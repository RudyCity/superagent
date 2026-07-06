import json
import shutil
import subprocess
from pathlib import Path

from .tool import Tool


def run(directory: str, pattern: str, cwd: str) -> str:
    rg = shutil.which("rg")
    if not rg:
        return (
            "Glob tool requires ripgrep (rg) to be installed, but it was not found in PATH.\n"
            "Install it from: https://github.com/BurntSushi/ripgrep#installation"
        )
    command = [rg, "--files", directory, "--glob", pattern]
    timeout = 10  # seconds
    try:
        output = subprocess.run(command, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    except subprocess.TimeoutExpired:
        return f"Tool `Glob` timed out after {timeout}s."
    except FileNotFoundError:
        return (
            "Glob tool requires ripgrep (rg) to be installed, but it was not found.\n"
            "Install it from: https://github.com/BurntSushi/ripgrep#installation"
        )
    if output.returncode == 0:
        return output.stdout if isinstance(output.stdout, str) else output.stdout.decode("utf-8", errors="replace")
    else:
        return output.stderr if isinstance(output.stderr, str) else output.stderr.decode("utf-8", errors="replace")


class GlobTool(Tool):
    name = "Glob"
    description: str = Tool.load_desc(Path(__file__).parent / "glob.md")
    parameters = {
        "type": "object",
        "properties": {
            "directory": {
                "type": "string",
                "description": "The absolute path of the directory to search in. If not provided, the current working directory will be used.",
            },
            "pattern": {
                "type": "string",
                "description": "The glob pattern to match files or directories.",
            },
        },
        "required": ["pattern"],
    }

    async def call(self, parameters: str, **kwargs) -> str:
        cwd = kwargs.get("cwd", str(Path.cwd()))
        params: dict = json.loads(parameters)
        directory = params.get("directory", cwd)
        pattern = params.get("pattern")

        p = Path(directory)
        if not p.is_dir():
            return f"The directory `{directory}` does not exist or is not a directory."
        if not p.resolve().is_relative_to(Path(cwd).resolve()):
            return f"Permission error: `{directory}` is not within the working directory `{cwd}`."

        output = run(directory, pattern, cwd=cwd)

        limit = 100
        matched_files = output.splitlines()
        if len(matched_files) > limit:
            matched_files = matched_files[:limit]
            matched_files.append(
                f"Results are truncated: showing first {limit} results. Consider using a more specific path or pattern."
            )

        if not matched_files:
            return "No files found"
        return "\n".join(matched_files)
