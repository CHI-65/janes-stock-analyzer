#!/usr/bin/env bash
# Build app.html from the JSX source. Run from anywhere.
#   ./src/build.sh
# 3 steps: transform JSX -> minify with esbuild -> assemble app.html (repo root).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

# esbuild: prefer the vendored native binary; fall back to a PATH copy / npx.
if [ -x "$HERE/.tools/esbuild" ]; then
  ESBUILD="$HERE/.tools/esbuild"
elif command -v esbuild >/dev/null 2>&1; then
  ESBUILD="esbuild"
else
  ESBUILD="npx esbuild"
fi

python3 build_standalone.py
$ESBUILD two-sides-standalone-v41.jsx --loader:.jsx=jsx --jsx=transform \
    --bundle=false --minify --outfile=app.compiled.js
python3 assemble_html.py

echo "---"
grep -o "<title>[^<]*</title>" ../app.html | head -1
