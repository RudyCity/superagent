from uuid import uuid4

from fastcontext.agent.context import Context
from fastcontext.agent.llm import LLM, Message, RequestyAPIError
from fastcontext.agent.tool import ToolSet
from fastcontext.agent.utils import get_final_answer


class Agent:
    """The loaded agent."""

    name: str
    system_prompt: str
    llm: LLM
    toolset: ToolSet
    context: Context

    work_dir: str

    def __init__(
        self,
        name: str,
        system_prompt: str,
        llm: LLM,
        toolset: ToolSet,
        trajectory_file: str,
        work_dir: str,
    ):
        self.name = name
        self.system_prompt = system_prompt
        self.llm = llm
        self.toolset = toolset
        self.context = Context(trajectory_file)
        self.work_dir = work_dir
        self.run_id = str(uuid4())
        self.n_turn = 0

    async def _agent_loop(self, prompt: str, max_turns: int, verbose: bool, citation: bool) -> str:
        # user promp -> tool calls -> tool results -> tool calls ... -> assistant final answer
        n_turn = 0
        await self.context.add(Message(role="system", content=self.system_prompt))
        await self.context.add(Message(role="user", content=prompt))

        while True:
            n_turn += 1
            if n_turn > max_turns + 1:
                return f"No final answer after {max_turns} turns."
            if n_turn == max_turns + 1:
                await self.context.add(
                    Message(
                        role="user",
                        content="Max number of turns reached. Please provide the final answer based on the information you have gathered.",
                    )
                )

            # call LLM to get next action
            try:
                step_msg = await self.llm.acall(
                    messages=self.context.get_messages(),
                    tools=self.toolset.schema_list(),
                )
            except RequestyAPIError as e:
                error_msg = f"LLM API call failed. So stopping the agent.\nError details:\n{str(e)}"
                await self.context.add(Message(role="assistant", content=error_msg))
                return error_msg
            self.n_turn = n_turn
            await self.context.add(step_msg)
            if verbose:
                print(f"Turn {n_turn}: \n {step_msg.to_dict()} \n")
            if step_msg.tool_calls:
                tools_result_msg = await self.toolset.call(step_msg)
                await self.context.add(tools_result_msg)
            else:
                if citation:
                    return get_final_answer(step_msg.content)
                return step_msg.content

    async def run(self, prompt: str, max_turns: int = 4, verbose: bool = False, citation: bool = False) -> str:
        if verbose:
            print("=== Agent Runtime Info ===")
            print(f"Agent: {self.name}")
            print(f"LLM: {self.llm.model}")
            print(f"Working Directory: {self.work_dir}")
            print("Agent Tools: " + " / ".join(self.toolset._tool_dict.keys()))
            print(f"User prompt:\n{prompt}\n")
            print("=== Agent Trajectory ===")
        return await self._agent_loop(prompt, max_turns, verbose, citation)
