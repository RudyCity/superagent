"""Command-line client and MCP stdio proxy; stdout is protocol-only in serve mode."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import (
    CallToolRequestParams,
    GetPromptRequestParams,
    ListToolsResult,
    PaginatedRequestParams,
    ReadResourceRequestParams,
)

from .client import connect
from .config import Config
from .oauth import FileTokenStorage


def create_proxy_server(upstream) -> Server:
    """Forward tools, resources and prompts, preserving upstream policy and payloads."""

    async def list_tools(_context, _params: PaginatedRequestParams | None) -> ListToolsResult:
        tools = []
        cursor = None
        while True:
            page = await upstream.list_tools(cursor=cursor)
            tools.extend(page.tools)
            cursor = page.next_cursor
            if not cursor:
                break
        return ListToolsResult(tools=tools)

    async def call_tool(_context, params: CallToolRequestParams):
        # Calls are not retried locally; a tool can have non-idempotent effects.
        return await upstream.session.call_tool(params.name, params.arguments or {})

    async def list_resources(_context, params: PaginatedRequestParams | None):
        return await upstream.list_resources(cursor=params.cursor if params else None)

    async def read_resource(_context, params: ReadResourceRequestParams):
        return await upstream.read_resource(params.uri)

    async def list_prompts(_context, params: PaginatedRequestParams | None):
        return await upstream.list_prompts(cursor=params.cursor if params else None)

    async def get_prompt(_context, params: GetPromptRequestParams):
        return await upstream.get_prompt(params.name, params.arguments)

    return Server(
        "SuperAgent MCP Python Bridge",
        on_list_tools=list_tools,
        on_call_tool=call_tool,
        on_list_resources=list_resources,
        on_read_resource=read_resource,
        on_list_prompts=list_prompts,
        on_get_prompt=get_prompt,
    )


async def relay(upstream) -> None:
    """Expose the authorized upstream through a local MCP stdio transport."""
    server = create_proxy_server(upstream)
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


async def run(command: str, tool: str | None, args: str | None) -> None:
    config = Config.from_env()
    if command == "serve" and config.auth == "oauth":
        if await FileTokenStorage(config.url, config.scope).get_tokens() is None:
            raise RuntimeError("OAuth setup required: run 'superagent-mcp-python login' first")

    async with connect(config) as upstream:
        if command == "serve":
            await relay(upstream)
        elif command in ("login", "doctor", "list"):
            tools = []
            cursor = None
            while True:
                result = await upstream.list_tools(cursor=cursor)
                tools.extend(result.tools)
                cursor = result.next_cursor
                if not cursor:
                    break
            if command == "list":
                print(json.dumps([t.model_dump(mode="json", by_alias=True) for t in tools], indent=2))
            else:
                print(json.dumps({"connected": True, "tools": len(tools), "auth": config.auth}))
        elif command == "call":
            if not tool:
                raise ValueError("call requires a tool name")
            parsed = json.loads(args or "{}")
            if not isinstance(parsed, dict):
                raise ValueError("Tool arguments must be a JSON object")
            result = await upstream.session.call_tool(tool, parsed)
            print(result.model_dump_json(indent=2, by_alias=True))


def main() -> None:
    parser = argparse.ArgumentParser(description="SuperAgent remote MCP Python client / stdio bridge")
    parser.add_argument("command", nargs="?", choices=("doctor", "list", "call", "login", "serve"), default="doctor")
    parser.add_argument("tool", nargs="?")
    parser.add_argument("--args", default="{}", help="JSON object passed to the selected tool")
    opts = parser.parse_args()
    try:
        asyncio.run(run(opts.command, opts.tool, opts.args))
    except (Exception, KeyboardInterrupt) as exc:
        # Never echo supplied bearer credentials in diagnostics.
        token = os.getenv("SUPERAGENT_MCP_TOKEN")
        message = str(exc)
        if token:
            message = message.replace(token, "[REDACTED]")
        print(f"SuperAgent MCP: {message}", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
