#!/bin/sh
set -eu
harmony_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$harmony_root/tools/math"
npm ci --no-audit --no-fund
NODE_PATH="$harmony_root/tools/math/node_modules" ./node_modules/.bin/esbuild "$harmony_root/scripts/math_entry.js" --bundle --format=esm --platform=browser --target=es2020 --minify --legal-comments=eof --outfile="$harmony_root/entry/src/main/ets/vendor/math.js"
cp node_modules/mathjax-full/LICENSE "$harmony_root/entry/src/main/ets/vendor/mathjax.LICENSE"
