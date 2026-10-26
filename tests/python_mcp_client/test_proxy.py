import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from mcp import Client
from mcp.types import (
    CallToolResult,
    GetPromptResult,
    ListPromptsResult,
    ListResourcesResult,
    ListToolsResult,
    Prompt,
    PromptMessage,
    Resource,
    TextContent,
    TextResourceContents,
    ReadResourceResult,
    Tool,
)

from superagent_mcp_client.__main__ import create_proxy_server


class ProxyTests(unittest.IsolatedAsyncioTestCase):
    async def test_tool_schemas_and_results_forwarded(self):
        schema = {"type": "object", "properties": {"value": {"type": "string"}}}
        remote_tool = Tool(name="fake_tool", description="Fake test tool", input_schema=schema)
        result = CallToolResult(
            content=[TextContent(type="text", text="test result")],
            structured_content={"ok": True},
        )
        upstream = SimpleNamespace(
            list_tools=AsyncMock(return_value=ListToolsResult(tools=[remote_tool])),
            session=SimpleNamespace(call_tool=AsyncMock(return_value=result)),
        )
        server = create_proxy_server(upstream)
        async with Client(server) as local:
            listed = await local.list_tools()
            self.assertEqual(listed.tools[0].name, "fake_tool")
            self.assertEqual(listed.tools[0].input_schema, schema)
            response = await local.call_tool("fake_tool", {"value": "hello"})
            self.assertEqual(response.structured_content, {"ok": True})
            upstream.session.call_tool.assert_awaited_once_with("fake_tool", {"value": "hello"})

    async def test_resources_and_prompts_forwarded(self):
        resource_uri = "test://resource/item"
        upstream = SimpleNamespace(
            list_tools=AsyncMock(return_value=ListToolsResult(tools=[])),
            list_resources=AsyncMock(return_value=ListResourcesResult(resources=[
                Resource(uri=resource_uri, name="test-resource")
            ])),
            read_resource=AsyncMock(return_value=ReadResourceResult(contents=[
                TextResourceContents(uri=resource_uri, text="secret-free data")
            ])),
            list_prompts=AsyncMock(return_value=ListPromptsResult(prompts=[
                Prompt(name="test_prompt", description="A test prompt")
            ])),
            get_prompt=AsyncMock(return_value=GetPromptResult(messages=[
                PromptMessage(role="user", content=TextContent(type="text", text="hello"))
            ])),
            session=SimpleNamespace(call_tool=AsyncMock()),
        )
        async with Client(create_proxy_server(upstream)) as local:
            listed_resources = await local.list_resources()
            self.assertEqual(len(listed_resources.resources), 1)
            resource_data = await local.read_resource(resource_uri)
            self.assertEqual(resource_data.contents[0].text, "secret-free data")
            prompts = await local.list_prompts()
            self.assertEqual(prompts.prompts[0].name, "test_prompt")
            prompt_result = await local.get_prompt("test_prompt")
            self.assertEqual(prompt_result.messages[0].role, "user")


if __name__ == "__main__":
    unittest.main()
