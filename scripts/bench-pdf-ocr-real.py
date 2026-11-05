#!/usr/bin/env python3
"""Measured Tesseract OCR on reproducible synthetic scanned PDFs (never mocks).

PDFs are raster scans built deterministically from independent gold strings,
rendered through the actual SuperAgent PDF CLI, and evaluated with Levenshtein
CER/WER against the synthetic gold. This is NOT a representative real-world
holdout corpus and is NOT a PaddleOCR benchmark.
"""
import argparse
import hashlib
import json
import re
import subprocess
import tempfile
import time
import random
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from reportlab.pdfgen.canvas import Canvas
from reportlab.lib.utils import ImageReader

SEED = 41020261104
SAMPLES = [
 ("id","Pusat riset agroindustri mengadakan pelatihan pada hari Selasa."),
 ("id","Nomor dokumen 1042 dan tanggal verifikasi 04 November 2026."),
 ("id","Pengelolaan limbah organik membantu meningkatkan mutu lingkungan."),
 ("id","Petugas memeriksa hasil pengukuran sebelum laporan disahkan."),
 ("id","Jumlah peserta 38 orang dan total ruang yang dipakai 5 unit."),
 ("id","Mohon periksa nomor invoice 2026 1415 sebelum pembayaran."),
 ("en","The quality team reviewed every section of the public report."),
 ("en","Receipt number 1042 was verified on November 04 2026."),
 ("en","Independent evaluation must not reuse training examples."),
 ("en","The project has three milestones and two major risks."),
 ("en","Please submit a signed contract before Friday afternoon."),
 ("en","The invoice total is 128 dollars for four separate items."),
]

def normalize(text):
    return " ".join(re.findall(r"[a-z0-9]+", text.casefold()))

def distance(a, b):
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b)+1))
    for i, x in enumerate(a, 1):
        row = [i]
        for j,y in enumerate(b,1):
            row.append(min(prev[j]+1, row[-1]+1, prev[j-1]+int(x!=y)))
        prev=row
    return prev[-1]

def run(args, cwd, timeout=25):
    start=time.perf_counter()
    p=subprocess.run(args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                     encoding="utf-8", errors="replace", timeout=timeout)
    if p.returncode!=0:
        raise RuntimeError("Command failed: "+Path(args[0]).name+"; "+p.stderr[-240:])
    return p.stdout.strip(), round(time.perf_counter()-start,3)

def fixture(gold, index, pdf_path, font):
    rng=random.Random(SEED+index)
    image=Image.new("RGB",(1200,1550),"white")
    draw=ImageDraw.Draw(image)
    f=ImageFont.truetype(font,[32,24,18][index%3])
    draw.text((65,215),gold,font=f,fill=(15,15,15))
    draw.line([(60,310),(1040,310)], fill=(85,85,85), width=2)
    if index%3 == 1:
        image=image.filter(ImageFilter.GaussianBlur(1.0)).rotate(.7,fillcolor="white")
    elif index%3 == 2:
        pixels=image.load()
        for _ in range(40000):
            x=rng.randrange(1200);y=rng.randrange(1550)
            shade=rng.randrange(195,255)
            rgb=pixels[x,y]
            pixels[x,y]=tuple(min(v,shade) for v in rgb)
        image=image.filter(ImageFilter.GaussianBlur(1.1))
    pdf=Canvas(str(pdf_path), pagesize=(600,775),pageCompression=1,invariant=1)
    pdf.drawImage(ImageReader(image),0,0,600,775)
    pdf.showPage()
    pdf.save()

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--json",required=True)
    p.add_argument("--markdown",required=True)
    args=p.parse_args()
    repo=Path(__file__).resolve().parent.parent
    output=Path(args.json).resolve()
    markdown=Path(args.markdown).resolve()
    if output.exists() or markdown.exists():
        raise RuntimeError("Evidence report already exists. Refusing overwrite.")
    if not output.is_relative_to(repo) or not markdown.is_relative_to(repo):
        raise RuntimeError("Benchmark report must stay within repo.")
    font=next((x for x in ["C:/Windows/Fonts/arial.ttf","C:/Windows/Fonts/segoeui.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"] if Path(x).is_file()),None)
    if not font:
        raise RuntimeError("No suitable font for reproducible synthetic fixtures.")
    version,_=run(["tesseract","--version"],repo)
    langs,_=run(["tesseract","--list-langs"],repo)
    available=sorted(set(langs.splitlines()).intersection({"eng","ind"}))
    if "eng" not in available:
        raise RuntimeError("English Tesseract model not found.")
    records=[]
    with tempfile.TemporaryDirectory(prefix="superagent-real-pdf-ocr-") as tmp:
        work=Path(tmp)
        for index,(language,gold) in enumerate(SAMPLES):
            base="sample-%02d"%(index+1)
            file=work/(base+".pdf")
            fixture(gold,index,file,font)
            meta,_render=run(["bun",str(repo/"scripts/pdf-cli.ts"),"render",file.name,base+"-page","1","2"],work)
            payload=json.loads(meta)
            image=Path(payload["images"][0]["path"])
            if not image.is_file():
                raise RuntimeError("PDF render did not publish image.")
            model="ind+eng" if language=="id" and "ind" in available else "eng"
            result,ocr_time=run(["tesseract",str(image),"stdout","--psm","6","-l",model],work)
            a=normalize(gold); b=normalize(result)
            records.append({
                "id":base,"language":language,"quality":["clean","blur_skew","noise_small_font"][index%3],
                "gold":gold,"prediction":result,"ocrModel":model,
                "CER":round(distance(a,b)/max(1,len(a)),4),
                "WER":round(distance(a.split(),b.split())/max(1,len(a.split())),4),
                "ocrSeconds":ocr_time,"pdfSHA256":hashlib.sha256(file.read_bytes()).hexdigest(),
                "renderPNG_SHA256":hashlib.sha256(image.read_bytes()).hexdigest()
            })
    group={}
    for lang in ("id","en"):
        selected=[r for r in records if r["language"]==lang]
        group[lang]={
            "n":len(selected),
            "meanCER":round(sum(r["CER"] for r in selected)/len(selected),4),
            "meanWER":round(sum(r["WER"] for r in selected)/len(selected),4)
        }
    report={
        "status":"completed","fixtureClass":"synthetic scanned PDF; independent predefined gold",
        "seed":SEED,"date":"2026-11-04","engine":"Tesseract CLI",
        "engineVersion":version.splitlines()[0],"installedModels":available,
        "pdfRendering":"SuperAgent scripts/pdf-cli.ts render scale 2",
        "scope":"Actual OCR benchmark, not simulated. Does not benchmark PaddleOCR or natural real scans.",
        "normalization":"Unicode casefold, ASCII alphanumerics only, collapse whitespace",
        "meanCER":round(sum(r["CER"] for r in records)/len(records),4),
        "meanWER":round(sum(r["WER"] for r in records)/len(records),4),
        "byLanguage":group,"samples":records,
        "limitations":["Only English traineddata installed unless ind listed","Synthetic fixtures are not field scans",
                       "Full production pdf_ocr fallback not benchmarked in this standalone Tesseract test"]
    }
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf8")
    lines=[
        "# Measured OCR benchmark — synthetic scanned PDFs",
        "",
        "Actual Tesseract executed after PDF rendering through SuperAgent; no mock OCR.",
        "",
        f"Engine: {version.splitlines()[0]}; available languages: {', '.join(available)}; samples: {len(records)}.",
        f"Mean CER **{report['meanCER']:.2%}**; mean WER **{report['meanWER']:.2%}**.",
        "",
        "| Language | N | Mean CER | Mean WER |",
        "|---|---:|---:|---:|",
    ]
    for lang,v in group.items():
        lines.append(f"| {lang.upper()} | {v['n']} | {v['meanCER']:.2%} | {v['meanWER']:.2%} |")
    lines.extend(["",
        "The JSON companion contains each gold transcript, OCR prediction, SHA-256 evidence and runtime.",
        "This is synthetic holdout material, not a representative real-world independent gold.",
        "Indonesian traineddata is unavailable unless the engine model list explicitly includes ind.",
        "Next: benchmark 100+ independent annotated real ID/EN scans and the full PDF OCR wrapper.",
    ])
    markdown.write_text("\n".join(lines)+"\n",encoding="utf8")
    print(json.dumps({"status":"completed","count":len(records),"meanCER":report["meanCER"],
                      "meanWER":report["meanWER"],"byLanguage":group,
                      "json":str(output),"markdown":str(markdown)}))

if __name__=="__main__":
    main()
