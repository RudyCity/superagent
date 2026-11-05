#!/usr/bin/env python3
"""Aggregate four-way real-document OCR metrics, excluding raw document contents."""
from __future__ import annotations
import collections
import json
import pathlib
import statistics

AUDIT = pathlib.Path(__file__).resolve().parent.parent / "docs" / "audits"
TARGET = AUDIT / "2026-11-05-mdpbench-real-id-en-fourway-pilot.json"
MARKDOWN = TARGET.with_suffix(".md")
ENGINES = ("tiny", "small", "medium", "tesseract")

def get_segment(engine: str, lang: str, later: bool) -> dict:
    filename = f"2026-11-05-mdpbench-{engine}-{lang}{'-more' if later else ''}-5.json"
    return json.loads((AUDIT / filename).read_text("utf8"))

def main():
    if TARGET.exists() or MARKDOWN.exists():
        raise ValueError("No overwriting benchmark evidence.")
    results = {}
    reference = None
    for engine in ENGINES:
        cases = []
        for lang in ("en", "id"):
            for later in (False, True):
                obj = get_segment(engine,lang,later)
                start = (10 if lang=="id" else 0) + (5 if later else 0)
                if obj["status"]!="completed" or obj["engine"]!=engine or obj["start"]!=start or obj["count"]!=5:
                    raise ValueError("One benchmark segment is incomplete.")
                cases.extend(obj["cases"])
        cases.sort(key=lambda row:row["caseId"])
        if [x["caseId"] for x in cases]!=list(range(20)):
            raise ValueError("Incomplete or duplicated cases.")
        matching = [(x["caseId"],x["imageSha256"],x["annotatedGoldTokens"],x["lang"]) for x in cases]
        if reference is None:
            reference = matching
        elif reference != matching:
            raise ValueError("Four engines did not evaluate the same images and annotations.")
        per = {}
        for lang in ("id","en","all"):
            rows=[x for x in cases if lang=="all" or x["lang"]==lang]
            gold=sum(x["annotatedGoldTokens"] for x in rows)
            matched=sum(x["annotatedTokenHits"] for x in rows)
            recognized=sum(x["recognizedTokens"] for x in rows)
            recall=matched/max(1,gold)
            precision=matched/max(1,recognized)
            f1=2*recall*precision/(recall+precision) if recall+precision else 0
            timing=sorted(x["runtimeSeconds"] for x in rows)
            per[lang]={
                "pages":len(rows),"annotatedReferenceTokens":gold,
                "matchedTokens":matched,"recognizedTokens":recognized,
                "annotatedTokenRecall":round(recall,4),
                "annotatedTokenPrecision":round(precision,4),
                "annotatedTokenF1":round(f1,4),
                "pageP50Seconds":round(statistics.median(timing),3),
                "pageP95Seconds":round(timing[max(0,int((len(timing)-1)*.95))],3),
                "sourceGroups":len({x["sourceGroupHash"] for x in rows}),
            }
        results[engine]=per
    report={
        "status":"pilot_complete","date":"2026-11-05",
        "dataset":"Delores-Lin/MDPBench public","license":"Apache-2.0",
        "annotationsSha256":"9b5f0f233917f5ab6c83c55dd526f66c930414254079097477d2ec5572e450f3",
        "independentOriginalDocuments":20,"pages":20,
        "languageCounts":{"id":10,"en":10},
        "pretrainedOnly":True,"training":False,
        "metricDefinition":"Bag-of-word overlap against annotated layout text. NOT page CER/WER, bbox IoU, calibrated recognition or human gold from complete PDF transcription.",
        "limitations":"20 original images, incomplete/possibly noisy layout annotations, unannotated visible text, no dual human adjudication, no 200-page holdout, no hardware-tier performance.",
        "results":results,
    }
    TARGET.write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf8")
    lines=["# Four-engine OCR evaluation on real Indonesian and English documents",
      "","Date: 2026-11-05. Public Apache-2.0 MDPBench; 20 unique original documents",
      "(10 Indonesian + 10 English). Human-reviewed layout transcriptions.",
      "","| Engine | ID annotated token recall | EN annotated token recall | ID token F1 | EN token F1 |",
      "|---|---:|---:|---:|---:|"]
    for engine, per in results.items():
        lines.append(f"| {engine} | {per['id']['annotatedTokenRecall']:.2%} | {per['en']['annotatedTokenRecall']:.2%} | {per['id']['annotatedTokenF1']:.2%} | {per['en']['annotatedTokenF1']:.2%} |")
    lines.extend(["","## Metric warnings",
      "- These are word-overlap results against layout annotations, not full-page CER/WER.",
      "- Reading order ignored; detection bounding-box ground truth not measured.",
      "- Missing annotations or visible text outside annotated layout may lower precision.",
      "- This is a 20-document pilot, not 200 independent adjudicated real scans.",
      "- No model training, fine-tuning or custom OCR weights.",
      "- Source JSON and images are cached privately outside Git; repo holds only hashed statistical results.",
      "- Use scripts/bench_pdf_ocr_mdpbench.py to reproduce on the pinned corpus.",
    ])
    MARKDOWN.write_text("\n".join(lines)+"\n",encoding="utf8")
    print(json.dumps({"status":"completed","pages":20,"models":list(results),
      "scores":{k:{"id":v["id"]["annotatedTokenRecall"],
                   "en":v["en"]["annotatedTokenRecall"]} for k,v in results.items()}},ensure_ascii=False))

if __name__=="__main__":
    main()
