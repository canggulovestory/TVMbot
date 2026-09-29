#!/bin/bash
set -euo pipefail
# Called after npm ci. Only code/dependencies go in this non-root runtime.
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RENDERER_DIR=/opt/tvm-contract-renderer
id tvm-renderer >/dev/null
command -v google-chrome >/dev/null
command -v pdfinfo >/dev/null
command -v pdftoppm >/dev/null
install -d -m 755 "$RENDERER_DIR/contracts"
install -m 755 "$(node -p process.execPath)" "$RENDERER_DIR/node"
rsync -a --delete "$REPO_DIR/contracts/" "$RENDERER_DIR/contracts/"
rsync -a --delete "$REPO_DIR/node_modules/" "$RENDERER_DIR/node_modules/"
chown -R root:root "$RENDERER_DIR"
chmod -R a+rX "$RENDERER_DIR"
