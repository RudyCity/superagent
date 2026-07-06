from fastcontext.agent.llm import FunctionCall, Message
from fastcontext.agent.tool import ToolSet


async def test_toolset():
    from fastcontext.agent.tool.read import ReadTool

    toolset = ToolSet(tools=[ReadTool()])
    schema_list = toolset.schema_list()
    print(schema_list)
    assert len(schema_list) == 1

    tool_call_msg = Message(
        role="assistant",
        content=None,
        tool_call_id="call_1",
        tool_calls=[
            FunctionCall(
                id="call_1_1",
                name="Read",
                arguments='{"path": "/workspace/README", "offset": 1, "limit": 100}',
            ),
            FunctionCall(
                id="call_1_2",
                name="Read",
                arguments='{"path": "/workspace/README.md", "offset": 4, "limit": 100}',
            ),
        ],
    )
    tools_result_messages = await toolset.call(tool_call_msg)
    print(tools_result_messages)
    for i, msg in enumerate(tools_result_messages):
        print(f"=== msg {i} ===")
        print(msg.content)


async def tools_schema_list():
    import json

    from fastcontext.agent.tool.glob import GlobTool
    from fastcontext.agent.tool.grep import GrepTool
    from fastcontext.agent.tool.read import ReadTool

    toolset = ToolSet(tools=[GrepTool(), GlobTool(), ReadTool()], work_dir="/workspace")
    schema_list = toolset.schema_list()
    print(schema_list)
    with open("tools_schema.json", "w", encoding="utf-8") as f:
        json.dump(schema_list, f, indent=4)


if __name__ == "__main__":
    import asyncio

    asyncio.run(test_toolset())
    asyncio.run(tools_schema_list())
