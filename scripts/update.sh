#!/bin/bash
# Обновление из архива: bash scripts/update.sh ~/Downloads/kabinet-X.zip
# Файлы проекта заменяются новыми, node_modules и ваши тексты не затрагиваются.
main() {
  set -e
  ZIP="$1"
  if [ -z "$ZIP" ] || [ ! -f "$ZIP" ]; then
    echo "Укажите путь к архиву, например:"
    echo "  bash scripts/update.sh ~/Downloads/kabinet-0.9.zip"
    exit 1
  fi
  cd "$(dirname "$0")/.."
  ROOT=$(pwd)
  TMP=$(mktemp -d)
  unzip -q "$ZIP" -d "$TMP"
  SRC=$(ls -d "$TMP"/*/ | head -1)
  if [ ! -f "$SRC/package.json" ]; then
    echo "В архиве не нашёл package.json. Это точно архив Кабинета?"
    exit 1
  fi
  rsync -a --exclude node_modules --exclude dist --exclude renderer/dist "$SRC" "$ROOT/"
  rm -rf "$TMP"
  npm install --no-audit --no-fund
  bash scripts/install-app.sh
}
main "$@"
exit $?
