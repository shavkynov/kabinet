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

Ранее в ветке (до этой доработки):

- `ec00759` — падежные формы карточек (склонение) на Rust
- `3dddc43` — связи имён (namematch, mentions) на Rust

Доработка поверх `e008a5d`, по одному коммиту на задачу:

| Задача | SHA | Что сделано |
|---|---|---|
| 0 | `8137ade` | базовая линия и объяснение «504/2» в этом отчёте |
| 1 | `209e571` | `guardWrite` на Rust: известные SHA-1, копия чужой версии в «Конфликты», строгие/массовые чтения |
| 2 | `3dcc65a` | предметы в «Встречается в главах» склоняются как места (JS, тесты JS и Rust) |
| 3 | `2245c89` | золотой корпус склонений из JS (307 карточек, 8604 варианта) и Rust-тест |
| 4 | `227903f` | `card_mentions` считает формы только одной карточки; убраны 2 предупреждения в RTF-импорте |
| 5 | этот коммит | удалены 5 workflow `repair-*`, проверены остальные workflow, обновлён отчёт |

## Что перенесено в `kabinet-core`

| JS | Rust | Назначение |
|---|---|---|
| `src/declension.js` | `core/src/declension.rs` | падежные формы имён/названий: 5 падежей, прилагательные, частицы, дефис/пробел, ё→е |
| `src/namematch.js` | `core/src/namematch.rs` | регулярка «слово целиком» из префиксного дерева + `isCapital` (fancy-regex, lookaround) |
| `src/mentions.js` | `core/src/mentions.rs` | «встречается в главах»: явные имена + формы, `ignore`, протагонист |
| `src/syncguard.js` (+ `known`/`noteRead`/`hashText`/`writeFileAtomic` из `src/fsutil.js`) | `core/src/syncguard.rs` (+ правки `store.rs`) | защита от затирания чужих правок: SHA-1 прочитанного, `guardWrite`, «Конфликты» |

Плюс:
- канал `cards:mentions` подключён в `src-tauri/src/main.rs`;
- из `bridge.src.js` убраны JS-фолбэки (declension/namematch) — мост стал самодостаточным;
- `cleanMode`/`cleanSkip` уже были в `store.rs` (встроены в `load_meta`, `set_project_mode`, `set_analysis_skip`) — отдельный порт не требовался.

## Что перенесено в задаче 1 (защита от затирания)

Повторено поведение `src/fsutil.js` + `src/syncguard.js` + `src/project.js`:

- реестр прочитанного — глобальный, ключ — полный путь файла; `noteRead`, `knownHash`, `hashText` (SHA-1 hex от UTF-8 — бит в бит как в Node), `note_written`;
- `guardWrite`: не читали → конфликта нет; файл на диске совпадает с известным → нет; совпадает с новым текстом → нет; файла нет/не читается → нет; иначе чужая версия атомарно пишется в `<проект>/Конфликты/<штамп> <название> (с другого устройства)<расширение>`, имя возвращается в `{ "conflict": ... }`;
- имя и хеш идентичны JS: штамп `2026-11-12 12-19-00`, `safeName` (запретные знаки → `-`, ведущие точки срезаются, 60 знаков, пусто → «без названия»), `path.extname`;
- строгие чтения (`load_meta`, `read_chapter`, `read_item` — открытие окна/IPC) записывают хеш; массовые (`read_chapter_lenient`, `read_item_lenient`, статистика, доска, поиск, замена, упоминания, индекс карточек, экспорт) — нет;
- каждое успешное сохранение (глава, карточка, `project.json`) обновляет известный хеш, как `writeFileAtomic` в JS;
- битые байты на диске декодируются с заменами U+FFFD, как `readFileSync(..., 'utf8')` в JS: испорченный файл не затирается молча, а копируется в «Конфликты».

## Что не перенесено (осознанно)

`morph` (части речи, страдательный залог), `tense`, `rhythm`, `terms`, `stem`, `typo` — это ProseMirror-плагин в рендерере (`renderer/analysis.js`): пересчитывается синхронно на каждом нажатии и выдаёт позиции декораций. Клиентская логика; перенос в Rust через IPC дал бы задержку на ввод. Остаётся в JS.

## Порядок проверки

Каждый коммит проверялся на своей вершине. Порядок команд (из клона ветки):

1. `npm ci` — один раз после клона (исходники не меняет);
2. `cargo test` в `experiments/tauri-app/core`;
3. `node experiments/tauri-app/build.cjs` — без него `cargo check` в `src-tauri` падает: нет `../dist`;
4. `cargo check` в `experiments/tauri-app/src-tauri`;
5. `npm test`;
6. `npm run check`;
7. `node --test "test/*.test.js"` — полный набор JS-тестов (в `npm test` покрыты не все файлы).

## Проверка: итоговые числа (вершина ветки)

| Проверка | Результат |
|---|---|
| `cargo test` ядра | **109 passed, 0 failed**: 80 lib + 6 aggregate_missing + 3 chapter_missing + 1 declension_golden + 7 search_limit + 3 shared_helpers + 9 syncguard_guard |
| `npm ci` | exit 0, 454 пакета |
| `npm test` | **350 passed, 0 failed, 0 skipped** (51 файл из 76 по `package.json`) |
| `npm run check` | **exit 0** («тесты: ? пройдено» — см. «Известные отличия») |
| `node experiments/tauri-app/build.cjs` | exit 0 |
| `cargo check` в `src-tauri` после `build.cjs` | **exit 0, 0 предупреждений** |
| `node --test "test/*.test.js"` (полный набор) | **525 passed, 0 failed, 0 skipped** |
| золотой корпус склонений | 307 карточек / **8604 варианта**, расхождений JS↔Rust нет |
| `card_mentions`, 301 карточка и 60 глав (debug, эта машина) | **~35.8 мс → ~14.3 мс** (замер временным `#[ignore]`-тестом, в репозиторий не входит) |

## Уборка workflow

- удалены 5 файлов `.github/workflows/repair-*.yml` (`repair-hot-paths`, `repair-lenient-reads`, `repair-missing-chapter`, `repair-safe-close`, `repair-search-limit`) — они сами коммитили и пушили в `experiment/tauri-rust-finish`;
- в оставшихся 7 workflow нет `git push` в ветку: `build.yml` (main), `desktop-oauth-check.yml` (main), `editor-checks.yml` и `test-build.yml` (`claude/bugreport-fixes`), `android.yml` (теги, выкладывает APK в Release), `tauri-app.yml` и `tauri-experiment.yml` — только сборка (`permissions: contents: read`), пуша нет.

## Известные отличия и ограничения

- `npm test` запускает только 51 файл из 76 (список в `package.json` не обновлялся): 350 тестов против 525 в полном наборе. Числа «504/2» и «506/0» в прежнем отчёте — про один и тот же набор 506 тестов (см. «Базовая линия»).
- `npm run check` печатает «тесты: ? пройдено» из-за старого формата разбора вывода Node (`# pass N` вместо `ℹ pass N`); exit 0, сами тесты проходят.
- `safe_name` в Rust режет название по 60 Unicode-символам, JS `slice(0, 60)` — по UTF-16 code units: на обычных именах идентично, на эмодзи/астральных символах имя может отличаться по длине.
- Если не удаётся записать копию в «Конфликты», `guard_write` возвращает ошибку и своя версия не пишется — как `guardWrite` в JS (исключение до `writeFileAtomic`). Это осознанный выбор в пользу сохранности.
- Экспорт в Rust по-прежнему строгий к пропавшей главе (ошибка), тогда как JS-`readChapter` с `{track:false}` вернул бы пустую строку. Это существующее намеренное отличие порта (регрессия `export_stays_strict_when_a_chapter_is_missing`); известный хеш экспорт не обновляет.
- Реестр прочитанных хешей живёт в памяти процесса (как модульная `Map` в JS); ключ нормализует `\` → `/` для Windows/POSIX. После перезапуска приложения история чтения пуста — как и в Electron.
- Числа скорости `card_mentions` измерены на этой машине в debug-сборке: с 301 карточкой и 60 главами; они не сравнимы напрямую с «~140 мс против ~35 мс» из другой среды, но относительное ускорение ~2.5x устойчиво (убрано чтение и склонение всех карточек).
- `experiments/tauri-app/src-tauri/Cargo.lock` и `gen/` не закоммичены: `cargo check` создаёт их локально, в репозиторий они не входят.

## Обходы локального окружения (для воспроизведения)

На macOS-проверке этой сессии обходы не потребовались: Rust поставлен через rustup, `TMP`/`TEMP` не переопределялись. Исторические обходы Windows из прежнего отчёта (для воспроизведения на Windows):

- `CARGO_PROFILE_DEV_DEBUG=0` — обход `D8050` в MSVC 18 (VS 18 BuildTools) при сборке `ring` с `-Z7`.
- `TMP`/`TEMP` → `experiments/tauri-app/core/target/test-tmp` — системный `AppData\Local\Temp` отдаёт `Access denied` для `CreateDirectory` из нативных процессов; тесты пишут во временные папки.
- `vcvars64.bat` для MSVC-окружения.
- `git config http.sslBackend openssl` — schannel не получает учётные данные в песочнице.

## Готовность к использованию

**Нет как релиз.** `bundle.active=false` (нет установщика), подписи нет, автообновления нет, `productName` — «Кабинет (Tauri, тест)», ручная приёмка не пройдена. Для повседневной работы — Electron-версия (`main`).

## Открытые вопросы

- `experiments/tauri-app/src-tauri/Cargo.lock` не закоммичен (воспроизводимость зависимостей приложения).
- Список файлов в `npm test` не обновлён под новые тесты — вне рамок этой доработки; полный набор запускается через `node --test "test/*.test.js"`.
- Ветка запушена; PR не открыт.
