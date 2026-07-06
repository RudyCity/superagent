import os
import platform
import re
from dataclasses import asdict, dataclass
from pathlib import Path

from jinja2 import Environment as JinjaEnvironment
from jinja2 import StrictUndefined


@dataclass(frozen=True, slots=True, kw_only=True)
class SystemPromptArgs:
    OS_KIND: str
    SHELL_NAME: str
    WORK_DIR: str
    WORK_DIR_LS: str


def _load_system_prompt(path: Path, builtin_args: SystemPromptArgs) -> str:
    system_prompt = path.read_text(encoding="utf-8").strip()
    env = JinjaEnvironment(
        keep_trailing_newline=True,
        lstrip_blocks=True,
        trim_blocks=True,
        variable_start_string="${",
        variable_end_string="}",
        undefined=StrictUndefined,
    )
    try:
        template = env.from_string(system_prompt)
        return template.render(asdict(builtin_args))
    except Exception as e:
        raise RuntimeError(f"Failed to render system prompt template: {e}") from e


def load_system_prompt(work_dir: str) -> str:

    os_kind = platform.system()
    if os_kind == "Windows":
        shell_name = os.getenv("COMSPEC", "powershell.exe")
    else:
        shell_name = os.getenv("SHELL", "bash")
    work_dir_ls = "\n".join(os.listdir(work_dir))

    return _load_system_prompt(
        path=Path(__file__).parent / "system.md",
        builtin_args=SystemPromptArgs(
            OS_KIND=os_kind,
            SHELL_NAME=shell_name,
            WORK_DIR=work_dir,
            WORK_DIR_LS=work_dir_ls,
        ),
    )


def get_final_answer(text: str) -> str:
    m = re.search(r"<final_answer>(.*?)</final_answer>", text, re.DOTALL)
    if m is None:
        return text
    return m.group(0)


if __name__ == "__main__":
    print(load_system_prompt(os.getcwd()))
