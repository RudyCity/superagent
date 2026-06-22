"""
fastcontext_runner.py — Cross-platform wrapper that runs FastContext with
credentials passed as CLI arguments, not environment variables.

Emits structured JSONL progress events to stderr for live logging:
  {"event":"start","model":"...","query":"...","backend":"..."}
  {"event":"turn","turn":1}
  {"event":"thinking","text":"...","has_tools":true}
  {"event":"tool_start","tool":"Read [x3 parallel]","args":"..."}
  {"event":"tool_end","tool_call_id":"...","ok":true,"preview":"..."}
  {"event":"dedup","saved":1,"key":"Read::..."}
  {"event":"retry","attempt":1,"wait":2,"reason":"..."}
  {"event":"usage","prompt_tokens":100,"completion_tokens":50,"total_tokens":150}
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
    parser.add_argument("--max-turns", type=int, default=8)
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

    # ── LiteLLM Adapter ───────────────────────────────────────────────────────
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

    # ── Parallel ToolSet with deduplication ───────────────────────────────────
    toolset = ToolSet([ReadTool(), GlobTool(), GrepTool()], work_dir=args.work_dir)
    toolset._last_tool_results = []

    async def safe_single_tool_call(c):
        """Execute one tool call with timeout and isolated error handling."""
        try:
            return await asyncio.wait_for(
                toolset._single_tool_call(c.name, c.arguments, c.id), timeout=10
            )
        except (TimeoutError, asyncio.TimeoutError):
            return ToolResult(
                tool_call_id=c.id,
                failed=True,
                output="Tool `{}' timed out after 10s.".format(c.name),
            )
        except Exception as e:
            return ToolResult(
                tool_call_id=c.id,
                failed=True,
                output="Tool `{}' error: {}".format(c.name, e),
            )

    async def parallel_toolset_call(msg):
        """
        True-parallel tool execution with per-turn deduplication.

        Replaces the vendor's sequential ToolSet.call() loop entirely:
        - Groups identical (tool_name, arguments) pairs — executes each ONCE
        - Runs all unique calls concurrently via asyncio.gather
        - Builds tool-result Messages directly (no double-execution)
        """
        if not msg.tool_calls:
            return []

        # ── 1. Dedup: group by (name, arguments) ──────────────────────────────
        seen: dict[str, ToolResult] = {}         # cache_key -> ToolResult
        unique_calls: list = []                   # first call per unique key

        for c in msg.tool_calls:
            key = f"{c.name}::{c.arguments}"
            if key not in seen:
                seen[key] = None                  # placeholder
                unique_calls.append((key, c))

        n_deduped = len(msg.tool_calls) - len(unique_calls)
        if n_deduped > 0:
            emit({"event": "dedup", "saved": n_deduped})

        # ── 2. Execute unique calls in parallel ───────────────────────────────
        raw_results = await asyncio.gather(
            *[safe_single_tool_call(c) for _, c in unique_calls]
        )

        for (key, _), result in zip(unique_calls, raw_results):
            seen[key] = result

        # ── 3. Build ordered ToolResult list (sharing deduped results) ─────────
        ordered: list[ToolResult] = []
        for c in msg.tool_calls:
            key = f"{c.name}::{c.arguments}"
            cached = seen[key]
            # Stamp correct tool_call_id for deduplicated entries
            ordered.append(ToolResult(
                tool_call_id=c.id,
                failed=cached.failed,
                output=cached.output,
            ))

        toolset._last_tool_results = ordered

        # ── 4. Build Message list directly (bypass vendor sequential loop) ─────
        return [
            Message(role="tool", content=tr.output, tool_call_id=tr.tool_call_id)
            for tr in ordered
        ]

    # Wire in our replacement — vendor's sequential .call is never used
    toolset.call = parallel_toolset_call

    # ── LLM call with exponential-backoff retry ───────────────────────────────
    _RETRYABLE_SIGNALS = (
        "rate limit", "429", "timeout", "connection",
        "overloaded", "503", "529", "service unavailable",
    )
    _MAX_LLM_RETRIES = 3

    async def llm_call_with_retry(messages, tools):
        """Retry transient LLM errors (rate-limits, timeouts) with exponential backoff."""
        last_err = None
        for attempt in range(_MAX_LLM_RETRIES):
            try:
                return await llm.acall(messages=messages, tools=tools)
            except RequestyAPIError as exc:
                last_err = exc
                err_lower = str(exc).lower()
                retryable = any(sig in err_lower for sig in _RETRYABLE_SIGNALS)
                if retryable and attempt < _MAX_LLM_RETRIES - 1:
                    wait = 2 ** attempt          # 1s → 2s → 4s
                    emit({
                        "event": "retry",
                        "attempt": attempt + 1,
                        "wait": wait,
                        "reason": str(exc)[:120],
                    })
                    await asyncio.sleep(wait)
                else:
                    raise
        raise last_err  # unreachable but satisfies type checkers

    # ── Trajectory + Context ──────────────────────────────────────────────────
    trajectory_path = args.trajectory_path or os.path.join(
        args.work_dir, ".fastcontext", "trajectory.jsonl"
    )
    os.makedirs(os.path.dirname(trajectory_path), exist_ok=True)
    context = Context(trajectory_path)

    emit({"event": "start", "model": args.model, "query": args.query,
          "backend": "litellm" if _HAS_LITELLM else "openai-sdk"})

    # ── Main agent loop ───────────────────────────────────────────────────────
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

            # ── LLM call with retry ───────────────────────────────────────────
            try:
                step_msg = await llm_call_with_retry(
                    messages=context.get_messages(),
                    tools=toolset.schema_list(),
                )
            except RequestyAPIError as e:
                error_msg = f"LLM API call failed: {e}"
                emit({"event": "error", "text": error_msg})
                await context.add(Message(role="assistant", content=error_msg))
                return error_msg

            await context.add(step_msg)

            # ── Emit thinking / reasoning ─────────────────────────────────────
            reasoning_preview = (getattr(step_msg, "reasoning_content", None) or "")[:300]
            text_preview = (step_msg.content or "")[:500]
            has_tools = bool(step_msg.tool_calls)

            if reasoning_preview:
                emit({"event": "thinking", "text": f"[reasoning] {reasoning_preview}",
                      "has_tools": has_tools})
            elif text_preview:
                emit({"event": "thinking", "text": text_preview, "has_tools": has_tools})

            # ── Emit token usage ──────────────────────────────────────────────
            if getattr(step_msg, "usage", None):
                emit({
                    "event": "usage",
                    "prompt_tokens": step_msg.usage.get("prompt_tokens", 0),
                    "completion_tokens": step_msg.usage.get("completion_tokens", 0),
                    "total_tokens": step_msg.usage.get("total_tokens", 0),
                })

            if step_msg.tool_calls:
                # ── Emit tool_start (with parallel badge) ────────────────────
                n_tools = len(step_msg.tool_calls)
                parallel_badge = f" [\u00d7{n_tools} parallel]" if n_tools > 1 else ""

                for i, tc in enumerate(step_msg.tool_calls):
                    args_preview = (tc.arguments or "")[:200]
                    badge = parallel_badge if i == 0 else ""
                    emit({"event": "tool_start", "tool": tc.name + badge, "args": args_preview})

                # ── Execute tools (parallel + deduplication) ──────────────────
                tool_results = await toolset.call(step_msg)
                raw_results_by_id: dict = {
                    tr.tool_call_id: tr
                    for tr in getattr(toolset, "_last_tool_results", [])
                    if isinstance(tr, ToolResult)
                }

                # ── Emit tool_end + add to context ────────────────────────────
                for tr_msg in tool_results:
                    preview = (tr_msg.content or "")[:200]
                    raw = raw_results_by_id.get(tr_msg.tool_call_id)
                    ok = (not raw.failed) if raw else True
                    emit({
                        "event": "tool_end",
                        "tool_call_id": tr_msg.tool_call_id,
                        "ok": ok,
                        "preview": preview,
                    })
                    await context.add(tr_msg)
            else:
                # ── Final answer ──────────────────────────────────────────────
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
