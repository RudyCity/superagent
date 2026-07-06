import json
import datasets
from utils import calculate_score_file, calculate_score_line, parse_final_answer, parse_patch

DATASET_MAPPING = {
    "swebench-verified": "princeton-nlp/SWE-Bench_Verified",
    "swebench-multilingual": "SWE-bench/SWE-bench_Multilingual",
    "swebench-pro": "ScaleAI/SWE-bench_Pro",
}

# C, C++, Go, Java, JavaScript/TypeScript, PHP, Ruby, and Rust
FILE_TYPES = [".c", ".cpp", ".h", ".hpp", ".go", ".java", ".js", ".ts", ".tsx", ".php", ".rb", ".rs"]


def load_benchmark_data(bench: str):
    if bench in DATASET_MAPPING:
        bench = DATASET_MAPPING.get(bench)
        samples = datasets.load_dataset(bench, split="test")
        return samples
    else:
        raise ValueError(f"Unsupported benchmark: {bench}")


def load_pred_sample_citations(input_file: str) -> dict[str, list[str]]:
    """
    input_file: jsonl file, each line: {"instance_id": "<id>", "finial_response": "<response>"}
    """

    pred_sample_citations: dict[str, list[str]] = {}
    with open(input_file, "r", encoding="utf-8") as f:
        for line in f:
            data = json.loads(line)
            uuid = data["instance_id"]
            citations = parse_final_answer(data["finial_response"])["citations"]
            pred_sample_citations[uuid] = citations
    print(f"Loaded {len(pred_sample_citations)} predicted sample citations from {input_file}")
    return pred_sample_citations


def run_score(raw_samples: list[dict], pred_sample_citations: dict[str, list[str]] = None):

    score_file: list[dict[str, float]] = []
    score_line: list[dict[str, float]] = []
    n_no_citation = 0
    for sample in raw_samples:
        uuid = sample["instance_id"]
        edit_true = parse_patch(sample["patch"], workspace="/testbed/", file_types=FILE_TYPES)
        citations_pred = pred_sample_citations.get(uuid, [])
        if not citations_pred:
            n_no_citation += 1
        sf = calculate_score_file(edit_true, citations_pred)
        sl = calculate_score_line(edit_true, citations_pred)
        score_file.append(sf)
        score_line.append(sl)

    # average score (precision, recall, f1) of score_file and score_line
    avg_score_file = {
        "precision": sum([s["precision"] for s in score_file]) / len(score_file),
        "recall": sum([s["recall"] for s in score_file]) / len(score_file),
        "f1": sum([s["f1"] for s in score_file]) / len(score_file),
        "n_citation_files": sum([s["n_citation_files"] for s in score_file]) / len(score_file),
        "n_patch_files": sum([s["n_patch_files"] for s in score_file]) / len(score_file),
    }
    avg_score_line = {
        "precision": sum([s["precision"] for s in score_line]) / len(score_line),
        "recall": sum([s["recall"] for s in score_line]) / len(score_line),
        "f1": sum([s["f1"] for s in score_line]) / len(score_line),
        "n_citation_lines": sum([s["n_citation_lines"] for s in score_line]) / len(score_line),
        "n_patch_lines": sum([s["n_patch_lines"] for s in score_line]) / len(score_line),
    }

    score_results = {
        "score_file": avg_score_file,
        "score_line": avg_score_line,
        "n_no_citation": n_no_citation,
    }
    print(json.dumps(score_results, indent=2))
    return score_results


if __name__ == "__main__":
    """
    Usage: python run_score.py <bench_name> <pred_file>
    Example:
        python run_score.py swebench-multilingual result_finial_response.jsonl
    """
    import sys

    if len(sys.argv) == 3:
        bench_name = sys.argv[1]
        pred_file = sys.argv[2]
    else:
        raise ValueError("Usage: python run_score.py <bench_name> <pred_file>")
    raw_samples = load_benchmark_data(bench_name)
    pred_sample_citations = load_pred_sample_citations(pred_file)
    run_score(raw_samples, pred_sample_citations)
