# Отчёт о портировании (ветка `experiment/tauri-rust-finish`)

Кратко для проверяющего: что сделано, как проверено, что осталось. Ветка создана от `experiment/tauri-rust`.

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
