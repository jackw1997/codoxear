#!/bin/sh
set -eu
VENDOR_DIR="${CODOXEAR_CSS_VENDOR_DIR:-/tmp/codoxear-native-css-vendor}"
mkdir -p "$VENDOR_DIR"
cp tools/css/package.json tools/css/package-lock.json "$VENDOR_DIR/"
npm ci --prefix "$VENDOR_DIR" --no-audit --no-fund
cp scripts/css_entry.js "$VENDOR_DIR/entry.mjs"
"$VENDOR_DIR/node_modules/.bin/esbuild" "$VENDOR_DIR/entry.mjs" --bundle --platform=neutral --format=esm --target=es2020 --minify --outfile=entry/src/main/ets/vendor/css.js
cp "$VENDOR_DIR/node_modules/css-tree/LICENSE" entry/src/main/ets/vendor/css.LICENSE
