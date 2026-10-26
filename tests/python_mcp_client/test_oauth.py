import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.request import urlopen

from mcp.shared.auth import OAuthToken

from superagent_mcp_client.oauth import FileTokenStorage, LoopbackCallback, oauth_provider


class OAuthTests(unittest.IsolatedAsyncioTestCase):
    async def test_cache_is_per_endpoint_and_private(self):
        with tempfile.TemporaryDirectory() as home:
            with patch("superagent_mcp_client.oauth.Path.home", return_value=Path(home)):
                first = FileTokenStorage("https://a.example/mcp")
                second = FileTokenStorage("https://b.example/mcp")
                privileged = FileTokenStorage("https://a.example/mcp", "mcp:tools mcp:tools:write")
                self.assertNotEqual(first.path, second.path)
                self.assertNotEqual(first.path, privileged.path)
                token = OAuthToken(access_token="test-not-real", token_type="Bearer")
                await first.set_tokens(token)
                self.assertEqual((await first.get_tokens()).access_token, "test-not-real")
                self.assertIsNone(await second.get_tokens())
                self.assertNotIn("test-not-real", str(first.path))

    async def test_loopback_callback(self):
        receiver = LoopbackCallback()
        receiver.start()
        try:
            url = receiver.redirect_uri + "?code=example&state=expected"
            status = await asyncio.to_thread(lambda: urlopen(url, timeout=5).status)
            self.assertEqual(status, 200)
            result = await receiver.receive()
            self.assertEqual(result.code, "example")
            self.assertEqual(result.state, "expected")
        finally:
            receiver.close()

    async def test_oauth_provider_construction(self):
        callback = LoopbackCallback()
        try:
            provider = oauth_provider("https://example.com/mcp", "mcp:tools", callback)
            self.assertIsNotNone(provider)
        finally:
            callback.server.server_close()


if __name__ == "__main__":
    unittest.main()
