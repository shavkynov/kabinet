#!/usr/bin/env bash
# Обучает ИГРУШЕЧНУЮ UDPipe-модель на синтетическом трибанке (toy-treebank.js).
# Это не модель UD Russian-GSD: она нужна только чтобы прогнать успешный путь реального Tauri IPC.
# Результат лежит во временном каталоге и в репозиторий не добавляется.
#   experiments/tauri-app/e2e/make-toy-model.sh [каталог]     # по умолчанию $TMPDIR/kabinet-e2e
# Требуется собранное ядро (cargo fetch скачивает исходники udpipe-rs) и g++/make.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-${TMPDIR:-/tmp}/kabinet-e2e}"
mkdir -p "$OUT"
SRC="$(ls -d "$HOME"/.cargo/registry/src/*/udpipe-rs-0.2.0/vendor/udpipe 2>/dev/null | head -1)"
if [ -z "$SRC" ]; then
  echo "Нет исходников udpipe-rs: выполните cargo fetch --locked --manifest-path experiments/tauri-app/core/Cargo.toml" >&2
  exit 1
fi
rm -rf "$OUT/udpipe-src"
cp -r "$SRC" "$OUT/udpipe-src"
make -C "$OUT/udpipe-src/src" -j"$(nproc)" udpipe >/dev/null
node "$HERE/toy-treebank.js" "$OUT/toy.conllu"
"$OUT/udpipe-src/src/udpipe" --train --tokenizer='epochs=30' --tagger='iterations=8' --parser='iterations=8' "$OUT/toy.udpipe" "$OUT/toy.conllu"
echo "Игрушечная модель: $OUT/toy.udpipe"
echo "Запуск: KABINET_STYLE_MODEL=$OUT/toy.udpipe KABINET_STYLE_MODEL_SHA256= (пустой SHA отключает проверку хэша GSD)"
