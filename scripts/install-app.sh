#!/bin/bash
# Собирает программу и ставит её в «Программы» (старая версия заменяется, проекты и настройки не трогаются).
set -e
cd "$(dirname "$0")/.."

npm run dist

APP=$(ls -d dist/mac-arm64/*.app 2>/dev/null | head -1)
if [ -z "$APP" ]; then
  echo "Не нашёл собранную программу в dist/. Прокрутите вывод выше: там причина."
  exit 1
fi

osascript -e 'tell application "Кабинет" to quit' >/dev/null 2>&1 || true
sleep 1
rm -rf "/Applications/Кабинет.app"
cp -R "$APP" "/Applications/Кабинет.app"
xattr -cr "/Applications/Кабинет.app" 2>/dev/null || true
# Подпись «для себя»: без неё программа на Apple Silicon может не запуститься.
codesign --force --deep --sign - "/Applications/Кабинет.app" >/dev/null 2>&1 || true

echo ""
echo "Готово: Кабинет установлен в «Программы». Запускайте из Launchpad или Spotlight."
