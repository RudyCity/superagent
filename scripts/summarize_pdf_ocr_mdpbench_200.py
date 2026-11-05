#!/usr/bin/env python3
"""Aggregate the sealed 200-page four-engine MDPBench OCR evaluation.

Inputs: 100 EN + 100 ID pages for each pretrained engine, all from the same
locked corpus. Raw text is never copied to the aggregate report.
"""
from __future__ import annotations
import json, pathlib, statistics

ROOT = pathlib.Path(__file__).resolve().parent.parent
AUDIT = ROOT / "docs" / "audits"
ENGINES = ("tiny","small","medium","tesseract")
TARGET = AUDIT / "2026-11-05-mdpbench-real-id-en-fourway-200page.json"
MARKDOWN = TARGET.with_suffix(".md")

def load(engine:str, lang:str):
    p=AUDIT / f"2026-11-05-mdpbench-200-{engine}-{lang}-100-direct.json"
    obj=json.loads(p.read_text("utf8"))
    expected_start=0 if lang=="en" else 100
    if obj.get("status")!="completed" or obj.get("engine")!=engine or obj.get("start")!=expected_start or obj.get("count")!=100:
        raise ValueError(f"Invalid segment {p.name}")
    if obj.get("benchmarkHarness")!="direct-import-same-pinned-backend" or obj.get("productionWorkerPageLimitUnchanged")!=20:
        raise ValueError(f"Unexpected benchmark provenance in {p.name}")
    return obj

def metrics(rows):
    gold=sum(x["annotatedGoldTokens"] for x in rows)
    hits=sum(x["annotatedTokenHits"] for x in rows)
    got=sum(x["recognizedTokens"] for x in rows)
    recall=hits/max(1,gold)
    precision=hits/max(1,got)
    f1=2*precision*recall/(precision+recall) if precision+recall else 0
    times=sorted(x["runtimeSeconds"] for x in rows)
    return {
        "pages":len(rows),"annotatedReferenceTokens":gold,
        "matchedTokens":hits,"recognizedTokens":got,
        "annotatedTokenRecall":round(recall,4),
        "annotatedTokenPrecision":round(precision,4),
        "annotatedTokenF1":round(f1,4),
        "pageP50Seconds":round(statistics.median(times),3),
        "pageP95Seconds":round(times[max(0,int((len(times)-1)*.95))],3),
        "sourceGroups":len({x["sourceGroupHash"] for x in rows}),
    }

def main():
    if TARGET.exists() or MARKDOWN.exists():
        raise ValueError("Refusing to overwrite 200-page release evidence.")
    results={}
    reference=None
    model_hashes={}
    for engine in ENGINES:
        en=load(engine,"en")
        idn=load(engine,"id")
        rows=sorted(en["cases"]+idn["cases"],key=lambda x:x["caseId"])
        if [x["caseId"] for x in rows] != list(range(200)):
            raise ValueError(f"{engine}: missing/duplicate case IDs")
        lock=[(x["caseId"],x["lang"],x["imageSha256"],x["annotatedGoldTokens"],x["sourceGroupHash"]) for x in rows]
        if reference is None: reference=lock
        elif lock != reference: raise ValueError("Engines did not evaluate the identical 200 locked pages.")
        results[engine]={
            "en":metrics([x for x in rows if x["lang"]=="en"]),
            "id":metrics([x for x in rows if x["lang"]=="id"]),
            "all":metrics(rows),
            "runtimeSeconds":round(en["runtimeSec"]+idn["runtimeSec"],3),
            "peakObservedRssBytes":max(en["observedRssBytes"],idn["observedRssBytes"]),
        }
        model_hashes[engine]=en["modelHashes"]
        if en["modelHashes"] != idn["modelHashes"]:
            raise ValueError(f"{engine}: model hashes differ between languages")
    report={
        "status":"completed",
        "date":"2026-11-05",
        "dataset":"Delores-Lin/MDPBench public",
        "license":"Apache-2.0",
        "annotationsSha256":"9b5f0f233917f5ab6c83c55dd526f66c930414254079097477d2ec5572e450f3",
        "pages":200,
        "languageCounts":{"en":100,"id":100},
        "uniqueSourceGroups":{"en":39,"id":40},
        "pretrainedOnly":True,
        "training":False,
        "productionWorkerPageLimitUnchanged":20,
        "metricDefinition":"Order-independent word-token overlap against human-reviewed layout text. NOT full-page CER/WER, reading-order accuracy, bbox IoU or independent dual-adjudicated transcription.",
        "independenceWarning":"200 page images are NOT 200 independent source documents; they represent 79 unique source groups (39 EN + 40 ID) with transformed/photo variants among the remaining pages.",
        "modelHashes":model_hashes,
        "results":results,
    }
    TARGET.write_text(json.dumps(report,indent=2,ensure_ascii=False)+"\n","utf8")
    lines=[
        "# Four-engine OCR evaluation — 200 real Indonesian/English pages",
        "",
        "Date: 2026-11-05. Public Apache-2.0 MDPBench, 100 English + 100 Indonesian page images.",
        "The 200 pages represent **79 unique source groups** (39 EN + 40 ID), so they are not described as 200 independent documents.",
        "",
        "| Engine | EN recall | ID recall | EN F1 | ID F1 | Overall recall | Peak observed RSS |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for engine,v in results.items():
        lines.append(
            f"| {engine} | {v['en']['annotatedTokenRecall']:.2%} | {v['id']['annotatedTokenRecall']:.2%} | "
            f"{v['en']['annotatedTokenF1']:.2%} | {v['id']['annotatedTokenF1']:.2%} | "
            f"{v['all']['annotatedTokenRecall']:.2%} | {v['peakObservedRssBytes']/1024**2:.1f} MiB |"
        )
    lines += [
        "",
        "## Validity limits",
        "- Word-overlap against layout annotations is **not CER/WER** and ignores reading order.",
        "- Visible but unannotated words can reduce measured precision.",
        "- Bounding-box detection accuracy is not independently scored here.",
        "- Dataset annotations are human-reviewed by MDPBench authors, but this is not a SuperAgent dual-adjudicated complete-page transcription holdout.",
        "- All four engines use the same locked images, preprocessing policy, annotations and local pretrained model hashes.",
        "- No OCR model was trained or fine-tuned.",
        "- The benchmark harness reuses the same pinned backend in-process for efficiency; the production OCR worker remains capped at 20 pages/request.",
    ]
    MARKDOWN.write_text("\n".join(lines)+"\n","utf8")
    print(json.dumps({"status":"completed","pages":200,"uniqueSourceGroups":79,
        "scores":{k:{"en":v["en"]["annotatedTokenRecall"],"id":v["id"]["annotatedTokenRecall"]} for k,v in results.items()}},ensure_ascii=False))

if __name__=="__main__":
    main()
