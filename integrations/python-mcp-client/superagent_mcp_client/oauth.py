"""OAuth PKCE consent and per-server local token storage."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
import tempfile
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from mcp.client.auth import AuthorizationCodeResult, OAuthClientProvider
from mcp.shared.auth import OAuthClientInformationFull, OAuthClientMetadata, OAuthToken
from pydantic import AnyUrl


class FileTokenStorage:
    """Stores credentials in a dedicated per-URL file, never in the project tree."""

    def __init__(self, url: str, scope: str = "mcp:tools"):
        base = Path.home() / ".superagent-r" / "python-mcp-client"
        # Never reuse cached read-only grants after opting into a privileged scope.
        digest = hashlib.sha256((url + "\0" + scope).encode("utf-8")).hexdigest()[:20]
        self.path = base / f"oauth-{digest}.json"

    def _read(self) -> dict:
        if self.path.is_symlink():
            raise RuntimeError("Refusing symlinked OAuth credential store")
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}

    def _write(self, key: str, value: dict) -> None:
        data = self._read()
        data[key] = value
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.path.is_symlink():
            raise RuntimeError("Refusing symlinked OAuth credential store")
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=".oauth-")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(data, handle)
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    async def get_tokens(self) -> OAuthToken | None:
        data = self._read().get("tokens")
        return OAuthToken.model_validate(data) if data else None

    async def set_tokens(self, tokens: OAuthToken) -> None:
        self._write("tokens", tokens.model_dump(mode="json"))

    async def get_client_info(self) -> OAuthClientInformationFull | None:
        data = self._read().get("client_info")
        return OAuthClientInformationFull.model_validate(data) if data else None

    async def set_client_info(self, info: OAuthClientInformationFull) -> None:
        self._write("client_info", info.model_dump(mode="json"))


class LoopbackCallback:
    """Uses a temporary loopback HTTP listener for the OAuth redirect."""

    def __init__(self):
        self.event = threading.Event()
        self.result: dict[str, str] = {}

        parent = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                url = urlsplit(self.path)
                if url.path != "/callback":
                    self.send_error(404)
                    return
                params = parse_qs(url.query)
                parent.result = {key: values[0] for key, values in params.items() if values}
                parent.event.set()
                body = b"Authorization response received. You may close this tab."
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                pass  # Do not log authorization codes or callback query strings.

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def redirect_uri(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}/callback"

    def start(self):
        self.thread.start()

    async def receive(self) -> AuthorizationCodeResult:
        received = await asyncio.to_thread(self.event.wait, 300)
        if not received:
            raise TimeoutError("OAuth approval timed out after 300 seconds")
        if "error" in self.result:
            raise RuntimeError("OAuth authorization was denied")
        if not self.result.get("code") or not self.result.get("state"):
            raise RuntimeError("OAuth callback did not contain code and state")
        return AuthorizationCodeResult(
            code=self.result["code"], state=self.result["state"], iss=self.result.get("iss")
        )

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        if self.thread.is_alive():
            self.thread.join(timeout=2)


def oauth_provider(url: str, scope: str, callback: LoopbackCallback) -> OAuthClientProvider:
    async def open_consent(authorization_url: str):
        print("Approve SuperAgent MCP access in your browser.", file=sys.stderr)
        if not webbrowser.open(authorization_url):
            print(f"Authorization URL: {authorization_url}", file=sys.stderr)

    return OAuthClientProvider(
        server_url=url,
        client_metadata=OAuthClientMetadata(
            client_name="SuperAgent Python MCP Client",
            redirect_uris=[AnyUrl(callback.redirect_uri)],
            grant_types=["authorization_code", "refresh_token"],
            response_types=["code"],
            scope=scope,
        ),
        storage=FileTokenStorage(url, scope),
        redirect_handler=open_consent,
        callback_handler=callback.receive,
    )
