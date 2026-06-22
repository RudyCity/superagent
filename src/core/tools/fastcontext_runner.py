"""
fastcontext_runner.py — Cross-platform wrapper that runs FastContext with
credentials passed as CLI arguments, not environment variables.

Emits structured JSONL progress events to stderr for live logging:
  {"event":"turn","turn":1}
  {"event":"thinking","text":"...","has_tools":true}
  {"event":"tool_start","tool":"Read","args":"..."}
  {"event":"tool_end","tool":"Read","ok":true,"preview":"..."}
  {"event":"error","text":"..."}
  {"event":"done","turns":3}

Final answer goes to stdout.
"""

import argparse
import asyncio
import json
import os
import sys

# Force UTF-8 for stdout and stderr to prevent UnicodeEncodeError on Windows
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


# Try to import LiteLLM for multi-provider support (OpenAI, Anthropic, OpenRouter, etc.)
try:
    import litellm
    litellm.suppress_debug_info = True
    import logging as _logging
    _logging.getLogger("litellm").setLevel(_logging.ERROR)
    _HAS_LITELLM = True
except ImportError:
    _HAS_LITELLM = False


def emit(event: dict):
    """Write a JSONL event to stderr for live logging."""
    print(json.dumps(event, ensure_ascii=False), file=sys.stderr, flush=True)


def run():
    parser = argparse.ArgumentParser(description="FastContext runner")
    parser.add_argument("--source-dir", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--api-key", required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--query", required=True)
    parser.add_argument("--max-turns", type=int, default=6)
    parser.add_argument("--citation", action="store_true")
    parser.add_argument("--trajectory-path", required=False, default=None,
                        help="Path for trajectory JSONL file (unique per run)")
    parser.add_argument("--provider", required=False, default="openai",
                        help="Provider type: openai, anthropic, openrouter, custom")
    args = parser.parse_args()

    # Ensure FastContext source is importable
    source_dir = os.path.abspath(args.source_dir)
    if source_dir not in sys.path:
        sys.path.insert(0, source_dir)

    from fastcontext.agent.context import Context
    from fastcontext.agent.llm import LLM, Message, FunctionCall, RequestyAPIError
    from fastcontext.agent.tool.glob import GlobTool
    from fastcontext.agent.tool.grep import GrepTool
    from fastcontext.agent.tool.read import ReadTool
    from fastcontext.agent.tool.tool import ToolSet, ToolResult
    from fastcontext.agent.utils import load_system_prompt, get_final_answer

    system_prompt = load_system_prompt(args.work_dir)

    if _HAS_LITELLM:
        class LiteLLMAdapter:
            """Wraps LiteLLM to unify all providers (OpenAI, Anthropic, OpenRouter, etc.)
            into an OpenAI-compatible format that FastContext expects."""

            def __init__(self, model, api_key, base_url, provider="openai", **kw):
                self.model = model
                self.provider = (provider or "openai").lower()
                self.api_key = api_key
                self.base_url = base_url
                self.max_tokens = kw.get("max_tokens", 32_000)
                self.temperature = kw.get("temperature", 1.0)
                self.top_p = kw.get("top_p", 0.95)

                # Build LiteLLM model name with provider prefix
                if self.provider == "openrouter":
                    self.litellm_model = f"openrouter/{model}"
                elif self.provider == "anthropic":
                    self.litellm_model = f"anthropic/{model}"
                else:
                    # openai, custom, or unknown — use openai/ prefix
                    self.litellm_model = f"openai/{model}"

            async def acall(self, messages, tools):
                if messages and not isinstance(messages[0], dict):
                    messages = [m.to_dict(exclude_none=True) for m in messages]

                call_kw = {
                    "model": self.litellm_model,
                    "messages": messages,
                    "max_completion_tokens": self.max_tokens,
                    "temperature": self.temperature,
                    "top_p": self.top_p,
                    "api_key": self.api_key,
                }

                # Pass base_url for providers that need custom endpoints
                if self.base_url:
                    call_kw["base_url"] = self.base_url

                if tools:
                    call_kw["tools"] = tools

                try:
                    response = await litellm.acompletion(**call_kw)
                    choice = response.choices[0]
                    content = choice.message.content
                    reasoning = (
                        getattr(choice.message, "reasoning_content", None)
                        or getattr(choice.message, "reasoning_text", None)
                    )
                    tc_raw = choice.message.tool_calls

                    usage = None
                    if response.usage:
                        usage = {
                            "prompt_tokens": response.usage.prompt_tokens,
                            "completion_tokens": response.usage.completion_tokens,
                            "total_tokens": response.usage.total_tokens,
                        }

                    tool_call_failed = False
                    if tc_raw:
                        calls = [
                            FunctionCall(id=tc.id, name=tc.function.name,
                                         arguments=tc.function.arguments)
                            for tc in tc_raw
                        ]
                        return Message(
                            role="assistant", content=content,
                            reasoning_content=reasoning,
                            tool_calls=calls, tool_call_id=tc_raw[0].id,
                            model=self.model, usage=usage,
                        )
                    return Message(
                        role="assistant", content=content,
                        reasoning_content=reasoning,
                        model=self.model, usage=usage,
                    )
                except Exception as e:
                    raise RequestyAPIError(str(e)) from e

        llm = LiteLLMAdapter(
            model=args.model, api_key=args.api_key,
            base_url=args.base_url, provider=args.provider,
        )
    else:
        llm = LLM(model=args.model, api_key=args.api_key, base_url=args.base_url)
    toolset = ToolSet([ReadTool(), GlobTool(), GrepTool()], work_dir=args.work_dir)
    toolset._last_tool_results = []
    original_toolset_call = toolset.call

    async def call_with_results(msg):
        results = []
        if msg.tool_calls:
            for c in msg.tool_calls:
                try:
                    result = await asyncio.wait_for(
                        toolset._single_tool_call(c.name, c.arguments, c.id), timeout=10
                    )
                except TimeoutError:
                    result = ToolResult(
                        tool_call_id=c.id,
                        failed=True,
                        output="Tool `{}' timed out after 10s.".format(c.name),
                    )
                results.append(result)

        toolset._last_tool_results = results
        return await original_toolset_call(msg)

    toolset.call = call_with_results
    trajectory_path = args.trajectory_path or os.path.join(
        args.work_dir, ".fastcontext", "trajectory.jsonl"
    )
    os.makedirs(os.path.dirname(trajectory_path), exist_ok=True)
    context = Context(trajectory_path)

    emit({"event": "start", "model": args.model, "query": args.query,
          "backend": "litellm" if _HAS_LITELLM else "openai-sdk"})

    async def agent_loop():
        await context.add(Message(role="system", content=system_prompt))
        await context.add(Message(role="user", content=args.query))

        n_turn = 0
        while True:
            n_turn += 1
            if n_turn > args.max_turns + 1:
                emit({"event": "error", "text": f"No final answer after {args.max_turns} turns."})
                return f"No final answer after {args.max_turns} turns."

            if n_turn == args.max_turns + 1:
                await context.add(Message(
                    role="user",
                    content="Max number of turns reached. Please provide the final answer based on the information you have gathered.",
                ))

            emit({"event": "turn", "turn": n_turn})

            try:
                step_msg = await llm.acall(
                    messages=context.get_messages(),
                    tools=toolset.schema_list(),
                )
            except RequestyAPIError as e:
                error_msg = f"LLM API call failed: {e}"
                emit({"event": "error", "text": error_msg})
                await context.add(Message(role="assistant", content=error_msg))
                return error_msg

            await context.add(step_msg)

            # Emit thinking/reasoning
            text_preview = (step_msg.content or "")[:300]
            has_tools = bool(step_msg.tool_calls)

            if text_preview:
                emit({"event": "thinking", "text": text_preview, "has_tools": has_tools})

            if step_msg.tool_calls:
                # Emit tool_start for each call
                for tc in step_msg.tool_calls:
                    args_preview = (tc.arguments or "")[:200]
                    emit({"event": "tool_start", "tool": tc.name, "args": args_preview})

                # Execute tools
                tool_results = await toolset.call(step_msg)
                raw_tool_results = getattr(toolset, "_last_tool_results", [])
                raw_tool_results_by_id = {
                    tr.tool_call_id: tr for tr in raw_tool_results if isinstance(tr, ToolResult)
                }

                # Emit tool_end for each result
                for tr_msg in tool_results:
                    preview = (tr_msg.content or "")[:200]
                    raw_result = raw_tool_results_by_id.get(tr_msg.tool_call_id)
                    ok = not raw_result.failed if raw_result else True
                    emit({
                        "event": "tool_end",
                        "tool_call_id": tr_msg.tool_call_id,
                        "ok": ok,
                        "preview": preview,
                    })
                    await context.add(tr_msg)
            else:
                # Final answer
                emit({"event": "done", "turns": n_turn})
                if args.citation:
                    return get_final_answer(step_msg.content)
                return step_msg.content

    try:
        result = asyncio.run(agent_loop())
        print(result)
    except Exception as e:
        emit({"event": "error", "text": str(e)})
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    run()
