from typing import Any, Literal

from openai import AsyncOpenAI
from openai.types.chat import ChatCompletionMessageToolCall
from pydantic import BaseModel, model_serializer


class RequestyAPIError(Exception):
    """Exception for Requesty LLM API errors."""


type Role = Literal[
    "system",
    "user",
    "assistant",
    "tool",
]


class FunctionCall(BaseModel):
    id: str
    name: str
    arguments: str

    @model_serializer(mode="wrap")
    def serialize_call(self, handler, info):
        return {
            "id": self.id,
            "type": "function",
            "function": {"arguments": self.arguments, "name": self.name},
        }


class Message(BaseModel):
    id: str | None = None
    role: Role
    content: str | None = None
    reasoning_content: str | None = None

    # [{"name": name, "arguments": arguments, "id": id} ... ]
    tool_calls: list[dict | FunctionCall] | None = None
    tool_call_id: str | None = None
    model: str | None = None
    usage: dict | None = None

    def to_dict(self, exclude_none: bool = True) -> dict:
        return self.model_dump(exclude_none=exclude_none)


class LLM:
    def __init__(self, model: str, api_key: str, base_url: str, **kwargs) -> None:
        self.model = model
        self.base_url = base_url
        self.client = AsyncOpenAI(api_key=api_key, base_url=base_url)
        self.max_tokens = kwargs.get("max_tokens", 32_000)
        self.temperature = kwargs.get("temperature", 1.0)
        self.top_p = kwargs.get("top_p", 0.95)
        self.debug = kwargs.get("debug", False)

    async def acall(
        self,
        messages: list[dict | Message],
        tools: list[dict[str, Any]] | None,
    ) -> Message:

        if isinstance(messages[0], Message):
            messages = [message.to_dict(exclude_none=True) for message in messages]
        payload = {
            "model": self.model,
            "messages": messages,
            # "max_tokens": self.max_tokens,
            "max_completion_tokens": self.max_tokens,
            "temperature": self.temperature,
            "top_p": self.top_p,
        }
        if "qwen" in self.model:
            payload["extra_body"] = {
                "top_k": 20,
                "chat_template_kwargs": {"enable_thinking": False},
            }

        if tools:
            payload["tools"] = tools

        if self.debug:
            print("LLM Payload:", payload)

        try:
            if "claude" in self.model:
                # Use the custom API call for claude models
                from fastcontext.agent.llm_api import call_completion

                response = call_completion(model=self.model, messages=messages, tools=tools)
            else:
                response = await self.client.chat.completions.create(**payload)
            usage = response.usage.to_dict()
            content = None
            reasoning_content = None
            tool_calls: list[ChatCompletionMessageToolCall] = []
            role = response.choices[0].message.role

            if len(response.choices) == 1:
                content = response.choices[0].message.content
                if hasattr(response.choices[0].message, "reasoning_content"):
                    reasoning_content = response.choices[0].message.reasoning_content
                elif hasattr(response.choices[0].message, "reasoning_text"):
                    reasoning_content = response.choices[0].message.reasoning_text
                tool_calls = response.choices[0].message.tool_calls
            elif len(response.choices) == 2:
                reasoning_content = response.choices[0].message.reasoning_text
                content = response.choices[0].message.content
                for choice in response.choices:
                    if choice.finish_reason == "tool_calls" and choice.message.tool_calls:
                        tool_calls.extend(choice.message.tool_calls)
            elif len(response.choices) > 2:
                raise ValueError(f"Unexpected number of choices returned: {len(response.choices)}")
            else:
                raise ValueError("No choices returned from LLM API call.")

            if tool_calls:
                function_calls = [
                    FunctionCall(id=tc.id, name=tc.function.name, arguments=tc.function.arguments) for tc in tool_calls
                ]
                return Message(
                    role=role,
                    content=content,
                    reasoning_content=reasoning_content,
                    tool_calls=function_calls,
                    tool_call_id=tool_calls[0].id,
                    model=self.model,
                    usage=usage,
                )
            return Message(
                role=role, content=content, reasoning_content=reasoning_content, model=self.model, usage=usage
            )
        except Exception as e:
            raise RequestyAPIError(f"LLM API call failed: {str(e)}") from e
