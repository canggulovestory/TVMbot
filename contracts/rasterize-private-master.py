#!/usr/bin/env python3
"""Flatten a private PDF so covered source values cannot remain as searchable text."""
import glob
import os
import subprocess
import sys
import tempfile
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen.canvas import Canvas

source, output, pdftoppm = sys.argv[1:4]
with tempfile.TemporaryDirectory(prefix="tvm-master-") as folder:
    prefix = os.path.join(folder, "page")
    subprocess.run([pdftoppm, "-jpeg", "-r", "200", "-jpegopt", "quality=92", source, prefix], check=True)
    pages = sorted(glob.glob(prefix + "-*.jpg"))
    if len(pages) != 13:
        raise SystemExit("Private lease master must contain 13 pages")
    canvas = Canvas(output, pagesize=A4, pageCompression=1)
    for page in pages:
        canvas.drawImage(page, 0, 0, width=A4[0], height=A4[1])
        canvas.showPage()
    canvas.save()
