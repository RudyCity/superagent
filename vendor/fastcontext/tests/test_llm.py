import os

from fastcontext.agent.llm import LLM


async def test_llm():
    llm = LLM(
        model=os.getenv("MODEL"),
        api_key=os.getenv("API_KEY"),
        base_url=os.getenv("BASE_URL"),
    )
    messages = [
        {"role": "user", "content": "Hello, how are you?"},
    ]
    msg = await llm.acall(
        messages=messages,
        tools=None,
    )
    print(msg.to_dict())


async def test_llm_tools():
    llm = LLM(
        model=os.getenv("MODEL"),
        api_key=os.getenv("API_KEY"),
        base_url=os.getenv("BASE_URL"),
        temperature=0.0,
        max_tokens=1024,
    )
    messages = [
        {"role": "system", "content": "You are a powerful AI agent."},
        {
            "role": "user",
            "content": "read file content from ./test_llm.py and ./README.md",
        },
    ]
    from fastcontext.agent.tool.read import ReadFileTool

    msg = await llm.acall(
        messages=messages,
        tools=[ReadFileTool().schema()],
        debug=True,
    )
    print(msg.to_dict())


async def test_llm_tools_result():
    llm = LLM(
        model=os.getenv("MODEL"),
        api_key=os.getenv("API_KEY"),
        base_url=os.getenv("BASE_URL"),
        temperature=0.0,
        max_tokens=1024,
    )
    messages = [
        {"role": "system", "content": "You are a powerful AI agent."},
        {"role": "user", "content": "please show me the current time"},
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "call_0",
                    "function": {"arguments": '{"command": "date"}', "name": "bash"},
                    "type": "function",
                },
                {
                    "id": "call_1",
                    "function": {"arguments": '{"command": "date"}', "name": "bash"},
                    "type": "function",
                },
            ],
        },
        {
            "role": "tool",
            "content": "Thu Aug 21 17:42:44 CST 2025",
            "tool_call_id": "call_0",
        },
        {
            "role": "tool",
            "content": "Thu Aug 21 17:42:44 CST 2025",
            "tool_call_id": "call_1",
            "name": "bash",
        },
    ]
    msg = await llm.acall(
        messages=messages,
        tools=None,
    )
    print(msg.to_dict())


if __name__ == "__main__":
    import asyncio

    # asyncio.run(test_llm())
    asyncio.run(test_llm_tools())
