import os

from fastcontext.agent.agent import Agent
from fastcontext.agent.llm import LLM
from fastcontext.agent.tool import ToolSet
from fastcontext.agent.tool.read import ReadTool


async def test_agent():
    llm = LLM(
        model=os.getenv("MODEL"),
        api_key=os.getenv("API_KEY"),
        base_url=os.getenv("BASE_URL"),
        debug=True,
    )

    work_dir = "/workspace"
    toolset = ToolSet(tools=[ReadTool()], work_dir=work_dir)

    agent = Agent(
        name="TestAgent",
        system_prompt="You are a helpful coding assistant.",
        llm=llm,
        toolset=toolset,
        trajectory_file="test_trajectory.log",
        work_dir=work_dir,
    )

    result = await agent.run(
        "Please summarize file content of '/workspace/README.md' to one sentence.",
        max_turns=5,
        verbose=True,
    )
    print(result)


async def _run_agent(instance: dict, agent_config: dict) -> dict:
    from fastcontext.agent.agent_factory import make_fastcontext_agent

    max_turns = int(agent_config.get("max_turns", 4))
    agent = make_fastcontext_agent(
        trajectory_file=agent_config.get("trajectory_file", ".fastcontext/trajectory.jsonl"),
        work_dir=agent_config.get("work_dir", "/testbed"),
    )

    final_answer = await agent.run(prompt=instance["query"], max_turns=max_turns, verbose=True)
    messages = agent.context.get_messages()

    return {
        "n_turn": agent.n_turn,
        "messages": messages,
        "tools": agent.toolset.schema_list(),
        "final_answer": final_answer,
    }


if __name__ == "__main__":
    import asyncio

    asyncio.run(test_agent())
