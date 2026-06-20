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
    args = parser.parse_args()

    # Ensure FastContext source is importable
    source_dir = os.path.abspath(args.source_dir)
    if source_dir not in sys.path:
        sys.path.insert(0, source_dir)

    from fastcontext.agent.context import Context
    from fastcontext.agent.llm import LLM, Message, RequestyAPIError
    from fastcontext.agent.tool.glob import GlobTool
    from fastcontext.agent.tool.grep import GrepTool
    from fastcontext.agent.tool.read import ReadTool
    from fastcontext.agent.tool.tool import ToolSet
    from fastcontext.agent.utils import load_system_prompt, get_final_answer

    system_prompt = load_system_prompt(args.work_dir)
    llm = LLM(model=args.model, api_key=args.api_key, base_url=args.base_url)
    toolset = ToolSet([ReadTool(), GlobTool(), GrepTool()], work_dir=args.work_dir)
    context = Context(".fastcontext/trajectory.jsonl")

    emit({"event": "start", "model": args.model, "query": args.query})

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

                # Emit tool_end for each result
                for tr_msg in tool_results:
                    preview = (tr_msg.content or "")[:200]
                    emit({
                        "event": "tool_end",
                        "tool_call_id": tr_msg.tool_call_id,
                        "ok": True,
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
