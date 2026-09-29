"""One-time, deterministic source-PDF conversion. Never used for tenant uploads."""
import hashlib
import json
import sys
from pathlib import Path
import pdfplumber

source, target = map(Path, sys.argv[1:])
pages = []
with pdfplumber.open(source) as pdf:
    for page in pdf.pages:
        tables = page.find_tables()
        blocks = []
        for table in tables:
            blocks.append({"y": table.bbox[1], "kind": "table", "rows": table.extract()})
        chars = [c for c in page.chars if 109 < c["top"] < 785 and not any(
            t.bbox[0]-1 <= c["x0"] <= t.bbox[2]+1 and t.bbox[1]-1 <= c["top"] < t.bbox[3]
            for t in tables)]
        lines = []
        for c in sorted(chars, key=lambda c: (round(c["top"], 1), c["x0"])):
            line = next((v for v in lines[-3:] if abs(v["y"]-c["top"])<2), None)
            if line is None:
                line = {"y":c["top"],"chars":[]}; lines.append(line)
            line["chars"].append(c)
        for line in lines:
            cs=sorted(line["chars"],key=lambda c:c["x0"])
            text=""; previous=None
            for c in cs:
                if previous and c["x0"]-previous["x1"]>1.5 and not text.endswith(" "): text+=" "
                text+=c["text"]; previous=c
            text=text.strip()
            if not text: continue
            italic=sum("Italic" in c["fontname"] for c in cs)>len(cs)/2
            bold=sum("Bold" in c["fontname"] for c in cs)>len(cs)/2
            style="italic" if italic else "bold" if bold else "normal"
            prev=blocks[-1] if blocks else None
            if prev and prev["kind"]=="text" and prev["style"]==style and 0<line["y"]-prev["lastY"]<16:
                prev["text"]+=" "+text;prev["lastY"]=line["y"]
            else: blocks.append({"kind":"text","y":line["y"],"lastY":line["y"],"style":style,"text":text})
        pages.append(sorted(blocks,key=lambda b:b["y"]))
target.write_text(json.dumps({"sourceSha256":hashlib.sha256(source.read_bytes()).hexdigest(),"pages":pages},ensure_ascii=False,indent=2))
