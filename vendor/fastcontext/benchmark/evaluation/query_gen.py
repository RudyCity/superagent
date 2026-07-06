import json
import os

from apis import call_llm_api

fastcontext_desc = """
Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?").

When NOT to use the fastcontext tool:
- Simple, single or few-step tasks that can be performed by a single agent (using parallel or sequential tool calls) -- just call the tools directly instead.
- For example:
  - If you want to read a specific file path
  - If you are searching for code within a specific file or set of 2-3 files
  - If you are searching for a specific class definition like "class Foo"

Usage notes:
- Provide clear, detailed prompts so the agent can work autonomously and return exactly the information you need.
- When the fastcontext is done, it will return a single message back to you: A brief summary and a listing relevant file paths with line ranges.
""".strip()


tools = [
    {
        "type": "function",
        "function": {
            "name": "bash",
            "description": "Execute a bash command",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The bash command to execute",
                    }
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "subagent",
            "description": fastcontext_desc,
            "parameters": {
                "type": "object",
                "properties": {
                    "description": {"description": "A short (3-5 word) description of the task", "type": "string"},
                    "prompt": {"description": "The task for the agent to perform", "type": "string"},
                },
                "required": ["description", "prompt"],
            },
        },
    },
]

task_prompt = """
Please based on the <problem_statement> call the `subagent` tool to explore the codebase and get related code files which can help to solve the problem (Do not call `subagent` in parallel).
""".strip()


def get_subagent_tool_call(sample: dict, model: str, tools: list[dict]) -> str | None:
    instance_id = sample["instance_id"]
    problem_statement = sample["problem_statement"].strip()
    msgs = [
        {
            "role": "system",
            "content": "You are a helpful assistant that can interact with a computer to solve programming tasks.",
        },
        {
            "role": "user",
            "content": f"<problem_statement>\n{problem_statement}\n</problem_statement>\n{task_prompt}",
        },
    ]
    response = call_llm_api(
        model=model,
        messages=msgs,
        tools=tools,
        temperature=1.0,
    )

    tool_calls = []
    if response:
        # content = response.choices[0].message.content
        finish_reason = response.choices[0].finish_reason
        # usage = response.usage.to_dict()
        if finish_reason != "tool_calls":
            return tool_calls
        if len(response.choices) > 1:
            for choice in response.choices:
                if choice.finish_reason == "tool_calls" and choice.message.tool_calls:
                    tool_calls.extend(choice.message.tool_calls)
        else:
            tool_calls = response.choices[0].message.tool_calls
        if tool_calls:
            tool_calls = [
                {"function_name": tc.function.name, "arguments": json.loads(tc.function.arguments)}
                for tc in tool_calls
            ]
        else:
            tool_calls = []
    else:
        print(f"Instance {instance_id} failed after retries of API calls.")
    return tool_calls


if __name__ == "__main__":
    """
    Usage: python query_gen.py <dataset_name> <model_name>
    Example:
        python query_gen.py swebench-multilingual claude-sonnet-4.6
        python query_gen.py swebench-verified claude-sonnet-4.6
        python query_gen.py swebench-pro claude-sonnet-4.6
        python query_gen.py ./sft_5k.jsonl claude-sonnet-4.6
    """
    import sys
    from datasets import load_dataset

    DATASET_MAPPING = {
        "swebench-verified": "princeton-nlp/SWE-Bench_Verified",
        "swebench-multilingual": "SWE-bench/SWE-bench_Multilingual",
        "swebench-pro": "ScaleAI/SWE-bench_Pro",
    }

    data_name = sys.argv[1]
    model = sys.argv[2]

    # check if data_name is a jsonl file
    if data_name.endswith(".jsonl") and os.path.isfile(data_name):
        samples = []
        with open(data_name, "r", encoding="utf-8") as f:
            for line in f:
                samples.append(json.loads(line))
        save_file = f"query_{len(samples)}samples__{model}.jsonl"
    else:
        save_file = f"query_{data_name}__{model}.jsonl"
        samples = load_dataset(DATASET_MAPPING[data_name])["test"]

    failed_instances = []
    for sample in samples:
        tool_calls = get_subagent_tool_call(sample, model=model, tools=tools)
        sample["subagent"] = {
            "model": model,
            "tool_calls": tool_calls,
        }
        if not tool_calls:
            failed_instances.append(sample["instance_id"])
        with open(save_file, "a", encoding="utf-8") as fw:
            fw.write(json.dumps(sample) + "\n")
    print(f"Saved subagent tool calls to {save_file}")
    print(f"Failed instances: {failed_instances}")
