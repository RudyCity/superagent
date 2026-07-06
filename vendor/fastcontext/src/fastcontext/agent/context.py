import json
import os
import aiofiles

from fastcontext.agent.llm import Message


class Context:
    def __init__(self, trajectory_file: str):
        self._history: list[Message] = []
        self.trajectory_file = trajectory_file

        os.makedirs(os.path.dirname(trajectory_file), exist_ok=True)

    def get_messages(self) -> list[dict]:
        return [message.to_dict(exclude_none=True) for message in self._history]

    async def add(self, message: Message | list[Message]):
        messages = [message] if isinstance(message, Message) else message
        # delete usage and reasoning_content info to history
        h_messages = []
        for message in messages:
            h_message = message.model_copy()
            h_message.model = None
            h_message.usage = None
            h_message.reasoning_content = None
            h_messages.append(h_message)
        self._history.extend(h_messages)

        async with aiofiles.open(self.trajectory_file, "a", encoding="utf-8") as f:
            lines = [message.to_dict(exclude_none=True) for message in messages]
            lines = [json.dumps(line, ensure_ascii=False) for line in lines]
            await f.write("\n".join(lines) + "\n")
