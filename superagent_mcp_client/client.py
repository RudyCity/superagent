"""Authorized remote MCP connection, without implicit execution replay."""

from __future__ import annotations

from contextlib import asynccontextmanager

import httpx2
from mcp import Client
from mcp.client.streamable_http import streamable_http_client

from .config import Config
from .oauth import LoopbackCallback, oauth_provider


@asynccontextmanager
async def connect(config: Config):
    """Connect to one URL; never fall back to a different server."""
    config = config.validated()
    callback = None
    try:
        if config.auth == "oauth":
            callback = LoopbackCallback()
            callback.start()
            client_kwargs = {"auth": oauth_provider(config.url, config.scope, callback)}
        else:
            client_kwargs = {"headers": {"Authorization": f"Bearer {config.token}"}}

        async with httpx2.AsyncClient(
            timeout=httpx2.Timeout(30.0, read=300.0),
            **client_kwargs,
        ) as http_client:
            transport = streamable_http_client(config.url, http_client=http_client)
            async with Client(transport) as upstream:
                yield upstream
    finally:
        if callback:
            callback.close()
