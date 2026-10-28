#!/bin/bash
# Проверка и упаковка архива для обновления: bash scripts/release.sh
set -e
cd "$(dirname "$0")/.."
ROOT=$(pwd)
node scripts/check.js
VER=$(node -p "require('./package.json').version")
OUT="$(cd .. && pwd)/kabinet-$VER.zip"
rm -f "$OUT"
(cd .. && zip -qr "$OUT" "$(basename "$ROOT")" -x '*/node_modules/*' '*/dist/*' '*/renderer/dist/*' '*/renderer/app.gen.js' '*/.DS_Store')
echo "Архив: $OUT"
