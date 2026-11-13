# Отчёт о портировании (ветка `experiment/tauri-rust-finish`)

Кратко для проверяющего: что сделано, как проверено, что осталось. Ветка создана от `experiment/tauri-rust`.

## Базовая линия (0)

Снята 2026-11-14 на macOS (arm64, Darwin 27.2.0), Node v26.12.0, npm 11.20.0, Rust 1.100.0 (stable; в системе Rust не было — поставлен rustup для проверки). Хранилище — чистый клон ветки на `e008a5d`.

| Команда | Результат |
|---|---|
| `cargo test` в `experiments/tauri-app/core` | **96 passed, 0 failed** (77 lib + 6 aggregate_missing + 3 chapter_missing + 7 search_limit + 3 shared_helpers) |
| `npm ci` (корень) | exit 0, 454 пакета |
| `npm test` (корень) | **349 passed, 0 failed, 0 skipped** — только 51 файл, перечисленный в `package.json` |
| `npm run check` | exit 0 (см. ниже про «тесты: ?») |
| `node experiments/tauri-app/build.cjs` | exit 0 (`renderer/dist/app.js` + `dist/bridge.js`) |
| `cargo check` в `src-tauri` после `build.cjs` | **exit 0**, 2 предупреждения в `kabinet-core` (`import.rs`, `sheet_num`/`sheet_outline`) |
| `node --test "test/*.test.js"` (полный набор) | **524 passed, 0 failed, 0 skipped** |

`npm test` не равен полному набору: в `package.json` перечислены 51 файл из 76, новые файлы (`test/tauri-*.test.js`, мобильные и сетевые) в список не добавлены. Поэтому числа «полного набора» в отчёте сняты командой `node --test "test/*.test.js"`. `npm run check` печатает «тесты: ? пройдено», потому что `scripts/check.js` ищет в выводе старый формат `# pass N`, а Node 26 печатает `ℹ pass N`; сам прогон при этом успешен (exit 0).

### Почему в отчёте «504 passed, 2 skipped», а прогон даёт «506 и 0 skipped»

Это не расхождение по числу тестов, а разные окружение и момент снятия:

- строка отчёта снята на коммите `d330162` (когда отчёт был добавлен) в **Windows**-окружении — в отчёте ниже перечислены MSVC, `vcvars64`, `AppData\Local\Temp`;
- в наборе того момента ровно **506** тестов: два теста в `test/android-plugins.test.js` помечены `skipWindows` (нужна оболочка `sh` для заглушки `npx`), поэтому на Windows было **504 passed + 2 skipped**, а на macOS те же два выполняются → **506 passed, 0 skipped**;
- после `d330162` в ветку добавлены тесты: `test/tauri-chapter-read.test.js` + `test/tauri-safe-close.test.js` дают **+18** (плюс Rust-тесты `search_limit` и другие), поэтому на `e008a5d` полный набор — **524**, а Rust-тестов ядра — **96** вместо 69 в отчёте.

Итог: «504/2» и «506/0» — один и тот же набор 506 тестов до добавления новых, разница только в пропуске двух Windows-зависимых тестов; числа 524/96 относятся к `e008a5d`.

## Коммиты

- `ec00759` — падежные формы карточек (склонение) на Rust
- `3dddc43` — связи имён (namematch, mentions) на Rust

## Что перенесено в `kabinet-core`

| JS | Rust | Назначение |
|---|---|---|
| `src/declension.js` | `core/src/declension.rs` | падежные формы имён/названий: 5 падежей, прилагательные, частицы, дефис/пробел, ё→е |
| `src/namematch.js` | `core/src/namematch.rs` | регулярка «слово целиком» из префиксного дерева + `isCapital` (fancy-regex, lookaround) |
| `src/mentions.js` | `core/src/mentions.rs` | «встречается в главах»: явные имена + формы, `ignore`, протагонист |

Плюс:
- канал `cards:mentions` подключён в `src-tauri/src/main.rs`;
- из `bridge.src.js` убраны JS-фолбэки (declension/namematch) — мост стал самодостаточным;
- `cleanMode`/`cleanSkip` уже были в `store.rs` (встроены в `load_meta`, `set_project_mode`, `set_analysis_skip`) — отдельный порт не требовался.

## Что НЕ перенесено (осознанно)

`morph` (части речи, страдательный залог), `tense`, `rhythm`, `terms`, `stem`, `typo` — это ProseMirror-плагин в рендерере (`renderer/analysis.js`): пересчитывается синхронно на каждом нажатии и выдаёт позиции декораций. Клиентская логика; перенос в Rust через IPC дал бы задержку на ввод. Остаётся в JS.

## Проверка

- `cargo test` ядра: **69/69** (60 было + 5 declension + 3 namematch + 1 mentions).
- `cargo check --manifest-path experiments/tauri-app/src-tauri/Cargo.toml`: **exit 0**.
- `node scripts/check.js` (`npm run check`): **exit 0**.
- JS-тесты `node --test "test/*.test.js"`: **504 passed, 0 failed, 2 skipped**.

## Обходы локального окружения (для воспроизведения)

- `CARGO_PROFILE_DEV_DEBUG=0` — обход `D8050` в MSVC 18 (VS 18 BuildTools) при сборке `ring` с `-Z7`.
- `TMP`/`TEMP` → `experiments/tauri-app/core/target/test-tmp` — системный `AppData\Local\Temp` отдаёт `Access denied` для `CreateDirectory` из нативных процессов; тесты пишут во временные папки.
- `vcvars64.bat` для MSVC-окружения.
- `git config http.sslBackend openssl` — schannel не получает учётные данные в песочнице.

## Готовность к использованию

**Нет как релиз.** `bundle.active=false` (нет установщика), подписи нет, автообновления нет, `productName` — «Кабинет (Tauri, тест)», ручная приёмка не пройдена. Для повседневной работы — Electron-версия (`main`).

## Открытые вопросы

- `experiments/tauri-app/src-tauri/Cargo.lock` не закоммичен (воспроизводимость зависимостей приложения).
- Ветка запушена; PR не открыт.
