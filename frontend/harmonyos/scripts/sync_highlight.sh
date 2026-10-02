#!/bin/sh
set -eu
VENDOR_DIR="${CODOXEAR_HIGHLIGHT_VENDOR_DIR:-/tmp/codoxear-native-highlight-vendor}"
mkdir -p "$VENDOR_DIR"
cp tools/highlight/package.json tools/highlight/package-lock.json "$VENDOR_DIR/"
npm ci --prefix "$VENDOR_DIR" --no-audit --no-fund
cp scripts/highlight_entry.js "$VENDOR_DIR/entry.mjs"
"$VENDOR_DIR/node_modules/.bin/esbuild" "$VENDOR_DIR/entry.mjs" --bundle --platform=neutral --format=esm --target=es2020 --minify --outfile=entry/src/main/ets/vendor/highlight.js
cp "$VENDOR_DIR/node_modules/highlight.js/LICENSE" entry/src/main/ets/vendor/highlight.LICENSE

# Ark's lexer treats a literal #! inside this Wren regex as a hashbang.
# Hex-escaping # preserves the regex language and avoids that lexer ambiguity.
python3 - <<'PYTHON'
from pathlib import Path
p = Path('entry/src/main/ets/vendor/highlight.js')
p.write_text(p.read_text().replace('/#!?/', '/\\x23!?/'))
PYTHON
