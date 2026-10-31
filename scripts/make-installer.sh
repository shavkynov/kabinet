#!/bin/bash
# Собирает установочный файл .dmg (для себя или чтобы отдать другому Mac): npm run installer
set -e
cd "$(dirname "$0")/.."

npm run dist:dmg

DMG=$(ls -t dist/*.dmg 2>/dev/null | head -1)
if [ -z "$DMG" ]; then
  echo "Не нашёл .dmg в папке dist/. Прокрутите вывод выше: там причина."
  exit 1
fi

cp "$DMG" "$HOME/Downloads/" 2>/dev/null || true
echo ""
echo "Готово: $DMG"
echo "Копия лежит в «Загрузках». Откройте .dmg и перетащите «Кабинет» в «Программы»."
echo "На чужом Mac при первом запуске: правый клик по программе → «Открыть» (подписи разработчика у неё нет)."
open -R "$DMG" 2>/dev/null || true
