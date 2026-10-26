"""Configuration shared by the direct client and the MCP stdio bridge."""

from __future__ import annotations

import os
from dataclasses import dataclass
from urllib.parse import urlsplit


@dataclass(frozen=True)
class Config:
    url: str
    auth: str = "oauth"
    token: str | None = None
    scope: str = "mcp:tools"

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            url=os.getenv("SUPERAGENT_MCP_URL", ""),
            auth=os.getenv("SUPERAGENT_MCP_AUTH", "oauth").lower(),
            token=os.getenv("SUPERAGENT_MCP_TOKEN"),
            scope=os.getenv("SUPERAGENT_MCP_SCOPE", "mcp:tools"),
        ).validated()

    def validated(self) -> "Config":
        url = urlsplit(self.url)
        if not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError("SUPERAGENT_MCP_URL must be a clean absolute /mcp endpoint URL")
        if not url.path.endswith("/mcp"):
            raise ValueError("SUPERAGENT_MCP_URL must end in /mcp")
        if url.scheme != "https" and not (
            url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1", "::1")
        ):
            raise ValueError("Remote MCP endpoints must use HTTPS; HTTP is loopback-only")
        if self.auth not in ("oauth", "bearer"):
            raise ValueError("SUPERAGENT_MCP_AUTH must be oauth or bearer")
        if self.auth == "bearer" and not self.token:
            raise ValueError("SUPERAGENT_MCP_TOKEN is required for bearer authentication")
        scopes = self.scope.split()
        supported = {"mcp:tools", "mcp:tools:write", "mcp:tools:admin"}
        if not scopes or set(scopes) - supported or len(scopes) != len(set(scopes)):
            raise ValueError("SUPERAGENT_MCP_SCOPE contains unsupported or duplicate scopes")
        if "mcp:tools:admin" in scopes and "mcp:tools:write" not in scopes:
            raise ValueError("Admin scope requires write scope")
        return self
