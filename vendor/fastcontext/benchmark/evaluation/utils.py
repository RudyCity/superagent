import json
import re


def load_json_file(file_path: str) -> dict:
    with open(file_path, "r", encoding="utf-8") as f:
        traj = json.load(f)
    # steps: "message", "reasoning_content", "tool_calls", "observation"
    return traj


def parse_final_answer(text: str, workspace: str = None) -> list[dict[str, str]]:

    citations = []
    n_citations = 0
    n_citations_files = 0
    n_citations_lines = 0
    n_broken_lines = 0
    n_overlap_line_citation = 0

    result = {
        "valid": False,
        "prefix": "",
        "final_answer": "",
        "tail": "",
        "citations": citations,
        "n_citations": n_citations,
        "n_citations_files": n_citations_files,
        "n_citations_lines": n_citations_lines,
        "n_broken_lines": n_broken_lines,
        "n_overlap_line_citation": n_overlap_line_citation,
    }
    if text is None:
        return result
    fa_match = re.search(r"<final_answer>(.*?)</final_answer>", text, re.DOTALL)
    if fa_match is None:
        return result

    prefix = text[: fa_match.start()]
    final_answer = fa_match.group(1)
    tail = text[fa_match.end() :]
    entries = final_answer.strip().splitlines()

    entries = [e for e in entries if e.strip()]

    file_paths = set()
    for entry in entries:
        # /absolute/path/to/file_1.py:10-15 (explanation 1)
        # /absolute/path/to/file_1.py:10 (explanation 2)
        # /absolute/path/to/file_1.py:10-15
        match = re.match(r"(.+?):(\d+(?:-\d+)?)\s*(.*)", entry.strip())
        if match:
            file_path = match.group(1).strip()
            if workspace is not None and file_path.startswith(workspace):
                file_path = file_path[len(workspace) :]
            line_range = match.group(2).strip()
            explanation = match.group(3).strip() if match.group(3) else ""
            start_line, end_line = line_range.split("-") if "-" in line_range else (line_range, line_range)
            start_line = int(start_line.strip())
            end_line = int(end_line.strip())
            file_paths.add(file_path)
            n_citations_lines += end_line - start_line + 1
            n_citations_files = len(file_paths)
            citations.append(
                {
                    "path": file_path,
                    "line_range": line_range,
                    "start_line": start_line,
                    "end_line": end_line,
                    "explanation": explanation,
                }
            )
        else:
            n_broken_lines += 1
    n_overlap_line_citation = line_range_overlap(citations)

    result["valid"] = True
    result["prefix"] = prefix
    result["final_answer"] = final_answer
    result["tail"] = tail
    result["citations"] = citations
    result["n_citations"] = len(citations)
    result["n_citations_files"] = n_citations_files
    result["n_citations_lines"] = n_citations_lines
    result["n_broken_lines"] = n_broken_lines
    result["n_overlap_line_citation"] = n_overlap_line_citation

    return result


def _calculate_score_file(citations_true: list[str], citations_pred: list[str]) -> dict[str, float]:
    y_true = set(citations_true)
    y_pred = set(citations_pred)

    # Calculate overlap
    overlap = y_true & y_pred

    # Calculate precision, recall, F1
    precision = len(overlap) / len(y_pred) if len(y_pred) > 0 else 0.0
    recall = len(overlap) / len(y_true) if len(y_true) > 0 else 0.0

    if precision + recall > 0:
        f1 = 2 * (precision * recall) / (precision + recall)
    else:
        f1 = 0.0

    return {
        "precision": precision,
        "recall": recall,
        "f1": f1,
    }


def calculate_explore_score(precision, recall, n_citation, n_label=3.0, beta=0.5, lmbda=0.1):
    if (precision + recall) == 0:
        f_beta = 0
    else:
        f_beta = (1 + beta**2) * (precision * recall) / ((beta**2 * precision) + recall)
    penalty = lmbda * max(0, (n_citation - n_label) / n_label)
    final_score = f_beta - penalty
    return final_score


def calculate_score_file(edit_true: list[dict], citations_pred: list[dict]) -> dict[str, float]:
    true_files = set(e["path"] for e in edit_true)
    pred_files = set(c["path"] for c in citations_pred)

    overlap = true_files & pred_files

    precision = len(overlap) / len(pred_files) if len(pred_files) > 0 else 0.0
    recall = len(overlap) / len(true_files) if len(true_files) > 0 else 0.0
    f1 = 2 * (precision * recall) / (precision + recall) if precision + recall > 0 else 0.0

    score = calculate_explore_score(precision, recall, len(pred_files), n_label=len(true_files))

    return {
        "score": score,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "n_citation_files": len(pred_files),
        "n_patch_files": len(true_files),
    }


def calculate_score_line(edit_true: list[dict], citations_pred: list[dict]) -> dict[str, float]:
    """
    edit_true, e.g. [{'path': 'docs/querying/post-aggregations.md', 'start_line': 36, 'end_line': 42}, ...]
    citations_pred, e.g. [{'path': 'docs/querying/post-aggregations.md', 'start_line': 30, 'end_line': 50}, ...]
    """
    # caculate line-level precision, recall, F1
    true_lines = set()
    for edit in edit_true:
        for line in range(edit["start_line"], edit["end_line"] + 1):
            true_lines.add((edit["path"], line))

    pred_lines = set()
    for edit in citations_pred:
        for line in range(edit["start_line"], edit["end_line"] + 1):
            pred_lines.add((edit["path"], line))

    overlap = true_lines & pred_lines

    precision = len(overlap) / len(pred_lines) if len(pred_lines) > 0 else 0.0
    recall = len(overlap) / len(true_lines) if len(true_lines) > 0 else 0.0
    f1 = 2 * (precision * recall) / (precision + recall) if precision + recall > 0 else 0.0

    score = calculate_explore_score(precision, recall, len(pred_lines), n_label=len(true_lines))

    return {
        "score": score,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "n_citation_lines": len(pred_lines),
        "n_patch_lines": len(true_lines),
    }


def parse_patch(text: str, workspace: str = None, file_types: list[str] = None):
    file_pattern = re.compile(r"^diff --git a/(.+) b/(.+)$", re.MULTILINE)
    file_sections = re.split(r"(?=^diff --git a/)", text, flags=re.MULTILINE)
    file_sections = [s for s in file_sections if len(s)]  # skip the first empty element

    edit_files = []
    for file_patch in file_sections:
        files = file_pattern.findall(file_patch)
        if len(files) != 1:
            # skip files that are not in the format of a/b
            continue
        file = files[0][0]
        if file_types is not None and not any(file.endswith(ft) for ft in file_types):
            continue
        lines = file_patch.splitlines()
        _patch = "\n".join(lines[3:]).strip()
        hunks = re.split(r"(?=^@@ -\d+,\d+ \+\d+,\d+ @@)", _patch, flags=re.MULTILINE)

        for h in hunks:
            hunk_header_pattern = re.compile(r"^@@ -(\d+),(\d+) \+(\d+),(\d+) @@")
            hunk_header_match = hunk_header_pattern.match(h)
            if not hunk_header_match:
                continue
            old_line_start = int(hunk_header_match.group(1))
            old_n_lines = int(hunk_header_match.group(2))
            # new_start_line = int(hunk_header_match.group(3))
            # new_n_lines = int(hunk_header_match.group(4))
            # skip new file, e.g. @@ -0,0 +1,145 @@
            if old_line_start == 0 and old_n_lines == 0:
                continue

            old_line_end = old_line_start + old_n_lines - 1
            if workspace is not None and file.startswith(workspace):
                # strip workspace prefix if exists
                file = file[len(workspace) :]
            edit_files.append(
                {
                    "path": file,
                    "start_line": old_line_start,
                    "end_line": old_line_end,
                }
            )
            if old_line_end < old_line_start:
                print(h)

        if len(hunks) == 0:
            continue
    return edit_files


def line_range_overlap(citations: dict):

    n_overlap_line_citation = 0
    files_lines = {}
    for citation in citations:
        if citation["path"] not in files_lines:
            files_lines[citation["path"]] = []
        files_lines[citation["path"]].append((citation["start_line"], citation["end_line"]))

    for _, line_ranges in files_lines.items():
        line_ranges.sort()
        for i in range(1, len(line_ranges)):
            _, prev_end = line_ranges[i - 1]
            curr_start, _ = line_ranges[i]
            if curr_start < prev_end:
                n_overlap_line_citation += 1
                print(f"Warning: overlapping line ranges: {line_ranges}")
    return n_overlap_line_citation


def describe_results(results: list[dict], model: str, output_file: str, tool_names: list[str], time_cost: float):
    num_tool_calls = [len(r["tool_calls"]) for r in results]
    n_none_toolcall = sum(1 for n in num_tool_calls if n == 0)

    tools_freq = {tool_name: 0 for tool_name in tool_names}
    overall = sum(num_tool_calls)
    for r in results:
        for tc in r["tool_calls"]:
            tool_name = tc["name"]
            assert tool_name in tool_names, f"Unknown tool name {tool_name}"
            tools_freq[tool_name] = tools_freq.get(tool_name, 0) + 1

    import pandas as pd

    df = pd.Series(num_tool_calls, dtype="int")
    desc = {
        "count": df.count().item(),
        "n_none_toolcall": n_none_toolcall,
        "min": df.min().item(),
        "max": df.max().item(),
        "mean": df.mean().round(1).item(),
        "std": df.std().round(1).item(),
        "25%": df.quantile(0.25).round(1).item(),
        "50%": df.quantile(0.5).round(1).item(),
        "75%": df.quantile(0.75).round(1).item(),
        "85%": df.quantile(0.85).round(1).item(),
        "90%": df.quantile(0.95).round(1).item(),
        "95%": df.quantile(0.95).round(1).item(),
        "99%": df.quantile(0.99).round(1).item(),
    }
    print(f"Desc of num_tool_calls:\n{json.dumps(desc, indent=2)}")
    print(f"Tools frequency:\n{json.dumps(tools_freq, indent=2)}")

    # convert desc to md table
    md_table = "| | Count | Min | Max | Mean | P50 | P85 | P95 |\n|---|---|---|---|---|---|---|---|\n"
    md_table += f"| {model} | {desc['count']} | {desc['min']} | {desc['max']} | {desc['mean']} | {desc['50%']} | {desc['85%']} | {desc['95%']} |\n"
    tool_calls_first = f"### Parallel tool calls on first turn\n{md_table}"
    print(tool_calls_first)

    # convert tool calls frequency to md table
    md_table_tools = "| Model/Category | Overall | " + " | ".join(tools_freq.keys()) + " |\n"
    md_table_tools += "| --- | --- | " + " | ".join(["---"] * len(tools_freq)) + " |\n"
    md_table_tools += (
        f"| {model} | {overall} | " + " | ".join(str(tools_freq.get(tool, 0)) for tool in tools_freq.keys()) + " |\n"
    )
    tool_calls_category = f"### Tool calls by Category\n\n{md_table_tools}"
    print(tool_calls_category)

    record_str_md = f"{tool_calls_first}\n\n{tool_calls_category}\n\n### Inference Time\n```\n{time_cost} seconds\n```"
    with open(output_file.replace(".jsonl", ".md"), "w", encoding="utf-8") as f:
        f.write(record_str_md)
    return desc


def describe_final_answer_results(samples, results: list[dict], model: str, output_file: str, time_cost: float):
    finish_reasons = {}
    n_toolcall = 0
    n_final_answer = 0
    n_citations = 0
    n_citations_files = 0
    n_citations_lines = 0
    n_broken_lines = 0
    n_overlap_line_citation = 0
    file_metrics = []
    for r, s in zip(results, samples):
        finish = r["finish_reason"]
        content = r["content"]
        edit_files = parse_patch(s["patch"], workspace=s["workspace"])
        result = parse_final_answer(content)
        if len(result["citations"]) > 0:
            n_final_answer += 1
        n_citations += result["n_citations"]
        n_citations_files += result["n_citations_files"]
        n_citations_lines += result["n_citations_lines"]
        n_broken_lines += result["n_broken_lines"]
        finish_reasons[finish] = finish_reasons.get(finish, 0) + 1
        if r["tool_calls"]:
            n_toolcall += 1
        n_overlap_line_citation += result["n_overlap_line_citation"]
        file_metrics.append(_calculate_score_file(result["citations"], edit_files))

    avg_file_metrics = {
        "precision": sum(m["precision"] for m in file_metrics) / len(file_metrics),
        "recall": sum(m["recall"] for m in file_metrics) / len(file_metrics),
        "f1": sum(m["f1"] for m in file_metrics) / len(file_metrics),
    }

    metadata = {
        "model": model,
        "time_cost (s)": time_cost,
        "n_toolcall": n_toolcall,
        "n_final_answer": n_final_answer,
        "n_citations": n_citations,
        "n_citations_files": n_citations_files,
        "n_citations_lines": n_citations_lines,
        "n_broken_lines": n_broken_lines,
        "n_overlap_line_citation": n_overlap_line_citation,
        "avg_file_metrics": avg_file_metrics,
        "extra": {
            "finish_reasons": finish_reasons,
        },
    }
    print(f"Final answer result:\n{json.dumps(metadata, indent=2)}")

    record_str_md = f"""


### Final Answer Evaluation
```
{json.dumps(metadata, indent=2)}
```
"""
    with open(output_file.replace(".jsonl", ".md"), "a", encoding="utf-8") as f:
        f.write(record_str_md)
    return metadata


def trajectory_analysis(traj: dict | str) -> dict:
    if isinstance(traj, str):
        traj = load_json_file(traj)

    steps = traj.get("steps", [])
    steps_with_tool_calls = [s for s in steps if len(s.get("tool_calls", [])) > 0]
    n_steps = len(steps)
    n_tools_by_toolstep = [len(s["tool_calls"]) for s in steps_with_tool_calls]
    n_tool_calls = sum(n_tools_by_toolstep)
    final_message = steps[-1]["message"] if n_steps > 0 else ""
    final_answer_result = parse_final_answer(final_message)
    return {
        "n_steps": n_steps,
        "n_tool_calls": n_tool_calls,
        "n_tools_by_toolstep": n_tools_by_toolstep,
        "final_answer_result": final_answer_result,
    }


if __name__ == "__main__":
    print(trajectory_analysis("./trajectory.json"))
