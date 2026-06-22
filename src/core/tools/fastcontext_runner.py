"""
fastcontext_runner.py — Cross-platform wrapper that runs FastContext with
credentials passed as CLI arguments, not environment variables.

Emits structured JSONL progress events to stderr for live logging:
  {"event":"start","model":"...","query":"...","backend":"..."}
  {"event":"cache_hit","key":"...","age_s":42}
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
import hashlib
import json
import os
import random
import sys
import time

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
    parser.add_argument("--exclude", required=False, default="",
                        help="Comma-separated glob patterns to exclude (e.g. 'node_modules,dist')")
    parser.add_argument("--max-file-size-kb", type=int, default=512,
                        help="Skip files larger than this many KB when reading (default: 512)")
    parser.add_argument("--no-cache", action="store_true",
                        help="Bypass the query result cache")
    args = parser.parse_args()

    # Parse exclude patterns
    exclude_patterns: list[str] = [
        p.strip() for p in args.exclude.split(",") if p.strip()
    ] if args.exclude else []

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
                elif self.provider == "custom":
                    # Custom OpenAI-compatible endpoints: prefix with "openai/" so
                    # LiteLLM routes the call through its OpenAI SDK adapter and
                    # honours the custom base_url.  Without a recognised prefix
                    # LiteLLM raises "LLM Provider NOT provided" because it cannot
                    # infer the provider from a bare model string like "xmtp/mimo-v2-pro".
                    self.litellm_model = f"openai/{model}"
                else:
                    # openai or unknown — standard openai/ prefix
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

    # ── Cache helpers ───────────────────────────────────────────────────────────────────
    _CACHE_DIR = os.path.join(args.work_dir, ".fastcontext", "cache")
    _CACHE_TTL_S = 3600  # 1 hour

    def _cache_key() -> str:
        """SHA-256 hash of query + model + exclude + citation + maxTurns."""
        raw = "|".join([
            args.query, args.model, args.exclude,
            str(args.citation), str(args.max_turns),
        ])
        return hashlib.sha256(raw.encode()).hexdigest()[:32]

    def _cache_path(key: str) -> str:
        return os.path.join(_CACHE_DIR, f"{key}.txt")

    def load_cache() -> str | None:
        """Return cached result if it exists and is within TTL."""
        if args.no_cache:
            return None
        key = _cache_key()
        path = _cache_path(key)
        if not os.path.exists(path):
            return None
        age = time.time() - os.path.getmtime(path)
        if age > _CACHE_TTL_S:
            try:
                os.remove(path)
            except OSError:
                pass
            return None
        try:
            with open(path, encoding="utf-8") as f:
                result = f.read()
            emit({"event": "cache_hit", "key": key[:8] + "...", "age_s": int(age)})
            return result
        except OSError:
            return None

    def save_cache(result: str) -> None:
        """Persist result to cache."""
        if args.no_cache:
            return
        try:
            os.makedirs(_CACHE_DIR, exist_ok=True)
            key = _cache_key()
            with open(_cache_path(key), "w", encoding="utf-8") as f:
                f.write(result)
        except OSError:
            pass  # Non-fatal: cache write failure is silently ignored

    # ── Exclude-aware tool subclasses ────────────────────────────────────────────────
    import fnmatch as _fnmatch

    def _is_excluded(path_str: str) -> bool:
        """Return True if path_str matches any exclude pattern.

        Normalises backslashes to forward slashes so that patterns like
        'node_modules' work correctly on Windows paths.
        """
        normalised = path_str.replace("\\", "/")
        return any(
            _fnmatch.fnmatch(normalised, f"*{pat}*") or _fnmatch.fnmatch(normalised, pat)
            for pat in exclude_patterns
        )

    class SizedReadTool(ReadTool):
        """ReadTool that skips files exceeding max_file_size_kb.

        Runs the blocking vendor call in a thread so asyncio.gather() can
        truly parallelise Read + Grep + Glob calls within the same turn.
        """
        def __init__(self, max_kb: int):
            super().__init__()
            self._max_bytes = max_kb * 1024

        async def call(self, parameters: str, **kwargs) -> str:
            try:
                a = json.loads(parameters) if parameters else {}
                file_path = a.get("path", "")
                # Resolve relative paths against cwd
                cwd = kwargs.get("cwd", args.work_dir)
                if file_path and not os.path.isabs(file_path):
                    file_path = os.path.join(cwd, file_path)
                if file_path and os.path.isfile(file_path):
                    size = os.path.getsize(file_path)
                    if size > self._max_bytes:
                        return (
                            f"[Skipped: file is {size // 1024} KB, "
                            f"exceeds limit of {self._max_bytes // 1024} KB] "
                            f"{file_path}"
                        )
            except Exception:
                pass
            # ReadTool uses aiofiles internally (truly async), no thread needed
            return await super().call(parameters, **kwargs)

    class ExcludeGlobTool(GlobTool):
        """GlobTool with post-filtering of excluded patterns.

        GlobTool uses subprocess.run() (blocking). We run it in a thread via
        asyncio.to_thread() so asyncio.gather() can parallelise tool calls
        within the same turn, and asyncio.wait_for() timeout is effective.
        """
        async def call(self, parameters: str, **kwargs) -> str:
            # Run the blocking vendor call in a thread pool
            result = await asyncio.to_thread(self._blocking_call, parameters, **kwargs)
            if not exclude_patterns or not result or result == "No files found":
                return result
            lines = result.splitlines()
            filtered = [l for l in lines if not l.strip() or not _is_excluded(l)]
            if not filtered or not any(l.strip() for l in filtered):
                return "No files found (all results matched exclude patterns)"
            return "\n".join(filtered)

        def _blocking_call(self, parameters: str, **kwargs) -> str:
            """Synchronous wrapper for the vendor's blocking subprocess call."""
            import asyncio as _asyncio
            loop = _asyncio.new_event_loop()
            try:
                return loop.run_until_complete(super(ExcludeGlobTool, self).call(parameters, **kwargs))
            finally:
                loop.close()

    class ExcludeGrepTool(GrepTool):
        """GrepTool with post-filtering for excluded patterns.

        rg's --glob only accepts one pattern per flag — comma-separated negation
        patterns in a single --glob do NOT work as multiple exclusions.
        We instead run the normal search and filter the resulting lines by path.

        GrepTool uses subprocess.run() (blocking). We run it via asyncio.to_thread()
        so asyncio.gather() can truly parallelise Read + Glob + Grep calls, and
        asyncio.wait_for() timeout becomes effective.

        In 'files_with_matches' mode (default), each line is a file path.
        In 'content' mode with --heading, file paths appear as section headers
        followed by numbered match lines (e.g. "42|matched text").
        """
        async def call(self, parameters: str, **kwargs) -> str:
            result = await asyncio.to_thread(self._blocking_call, parameters, **kwargs)
            if not exclude_patterns or not result or result == "No matches found":
                return result

            lines = result.splitlines()
            non_empty = [l for l in lines if l.strip()]

            # Detect content/heading mode by presence of "N|..." numbered lines
            has_numbered = any(
                "|" in l and l.split("|")[0].strip().isdigit()
                for l in non_empty[:20]
            )

            if not has_numbered:
                # files_with_matches: each line is a file path — filter directly
                filtered = [l for l in lines if not l.strip() or not _is_excluded(l)]
            else:
                # content/heading mode: section headers are file paths
                filtered = []
                skip_section = False
                for line in lines:
                    stripped = line.strip()
                    is_numbered = (
                        stripped and "|" in stripped
                        and stripped.split("|")[0].strip().isdigit()
                    )
                    if stripped and not line[0].isspace() and not is_numbered:
                        # This is a file path heading
                        skip_section = _is_excluded(stripped)
                        if not skip_section:
                            filtered.append(line)
                        continue
                    if not skip_section:
                        filtered.append(line)

            if not filtered or not any(l.strip() for l in filtered):
                return "No matches found (all results matched exclude patterns)"
            return "\n".join(filtered)

        def _blocking_call(self, parameters: str, **kwargs) -> str:
            """Run the vendor's blocking subprocess in a fresh event loop."""
            import asyncio as _asyncio
            loop = _asyncio.new_event_loop()
            try:
                return loop.run_until_complete(
                    super(ExcludeGrepTool, self).call(parameters, **kwargs)
                )
            finally:
                loop.close()

    # ── Parallel ToolSet with deduplication ───────────────────────────────────
    toolset = ToolSet(
        [SizedReadTool(args.max_file_size_kb), ExcludeGlobTool(), ExcludeGrepTool()],
        work_dir=args.work_dir,
    )
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
        "internalservererror", "openaiexception",  # LiteLLM custom endpoint failures
    )
    _MAX_LLM_RETRIES = 3

    async def llm_call_with_retry(messages, tools):
        """Retry transient LLM errors with exponential backoff + jitter."""
        last_err = None
        for attempt in range(_MAX_LLM_RETRIES):
            try:
                return await llm.acall(messages=messages, tools=tools)
            except RequestyAPIError as exc:
                last_err = exc
                err_lower = str(exc).lower()
                retryable = any(sig in err_lower for sig in _RETRYABLE_SIGNALS)
                if retryable and attempt < _MAX_LLM_RETRIES - 1:
                    base_wait = 2 ** attempt          # 1s, 2s, 4s
                    jitter = random.uniform(0.0, 1.0) # 0–1s jitter
                    wait = round(base_wait + jitter, 1)
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

    # ── Main agent loop ───────────────────────────────────────────────────────
    async def agent_loop():
        emit({"event": "start", "model": args.model, "query": args.query,
              "backend": "litellm" if _HAS_LITELLM else "openai-sdk"})
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
            reasoning_preview = (getattr(step_msg, "reasoning_content", None) or "")[:600]
            text_preview = (step_msg.content or "")[:800]
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
                failed_tools: list[str] = []
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
                    if not ok and raw:
                        failed_tools.append(f"{tr_msg.tool_call_id}: {raw.output[:120]}")

                # ── Inject error recovery hint if any tools failed ────────────
                if failed_tools:
                    hint = (
                        "[System] The following tool call(s) failed this turn:\n"
                        + "\n".join(f"  - {f}" for f in failed_tools)
                        + "\nConsider trying a different path, pattern, or tool to achieve the same goal."
                    )
                    await context.add(Message(role="user", content=hint))
            else:
                # ── Final answer ──────────────────────────────────────────────
                emit({"event": "done", "turns": n_turn})
                if args.citation:
                    return get_final_answer(step_msg.content)
                return step_msg.content

    try:
        # ── Cache check before running agent ──
        cached = load_cache()
        if cached is not None:
            print(cached)
            return

        result = asyncio.run(agent_loop())
        save_cache(result)
        print(result)
    except Exception as e:
        emit({"event": "error", "text": str(e)})
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    run()
