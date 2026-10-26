import unittest

from superagent_mcp_client.config import Config


class ConfigTests(unittest.TestCase):
    def test_valid_local_oauth(self):
        self.assertEqual(Config("http://127.0.0.1:6759/mcp").validated().auth, "oauth")

    def test_remote_https(self):
        self.assertEqual(Config("https://example.com/mcp", auth="bearer", token="secret").validated().auth, "bearer")

    def test_remote_http_rejected(self):
        with self.assertRaises(ValueError):
            Config("http://example.com/mcp").validated()

    def test_embedded_credentials_rejected(self):
        with self.assertRaises(ValueError):
            Config("https://user:pass@example.com/mcp").validated()

    def test_url_query_rejected(self):
        with self.assertRaises(ValueError):
            Config("https://example.com/mcp?Authorization=abc").validated()

    def test_bearer_needs_token(self):
        with self.assertRaises(ValueError):
            Config("https://example.com/mcp", auth="bearer").validated()

    def test_admin_needs_write(self):
        with self.assertRaises(ValueError):
            Config("https://example.com/mcp", scope="mcp:tools mcp:tools:admin").validated()


if __name__ == "__main__":
    unittest.main()
