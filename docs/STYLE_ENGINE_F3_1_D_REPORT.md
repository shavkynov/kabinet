# F.3.1-D — финальная проверка интеграции Russian-GSD

**Итоговый статус: `ACCEPTED WITH CAVEATS`.**

Все проверки, доступные в среде macOS (`Darwin arm64`) с настоящей моделью `russian-gsd-ud-2.5-191206` (SHA-256 `ba63e42f79f525cbcb78c8bc98dd126c2960cbada91b964a741285c15504f06a`), выполнены в `debug` и `release`. Найден и исправлен один дефект гонки при отмене задач парсинга в Rust. Ограничения по Linux `.deb`, живому окну `tauri-driver` и `playwright` зафиксированы в разделе 7.

## 1. Исходный и итоговый HEAD

- Исходный: `17998b9b1be66053b9aa717d2eba0e53bb809bbf` (совпал с ожидаемым и с `origin/feature/linguistic-style-engine`).
- Итоговый: коммит с этим отчётом, исправлением гонки отмены и регрессионными тестами поверх `17998b9…` в ветке `feature/linguistic-style-engine` (см. `git log -2`).
- Ветки `main`, `fix/style-analysis-coverage` и PR #8 не менялись; PR #9 остаётся Draft; история не переписывалась, force push не использовался. Модель в Git, установщик и архивы не добавлялась.

## 2. Какие сценарии реально проверены

### 2.1. Настоящая отмена парсинга
- Выявлена и исправлена гонка между `StyleParser::cancel(task_id)` и регистрацией задачи в `StyleParser::parse(task_id, text)` через `tauri::async_runtime::spawn_blocking` (подробности в разделе 6).
- На реальной Russian-GSD (`experiments/tauri-app/core/tests/style_parser_f3_1_d.rs`, `real_model_mid_parse_cancel_and_rapid_switch`) проверены:
  - прерывание активного разбора главы (~21.4 тыс. символов, 200 абзацев) вызовом `cancel()` из другого потока через 40 мс во время работы UDPipe;
  - серия из 6 быстрых переключений (`task_id = 101..=106` с шагом 20 мс): вытесненные задачи `101..=105` возвращают `cancelled: true`, завершается только финальная задача `106`.

### 2.2. Второй лист (`editor2`)
- По исходникам (`renderer/app/05-pane2.js`) и регрессионному тесту (`test/style-shadow-f3-1-d.test.js`) подтверждено, что второй лист `editor2` намеренно не подключает `TextAnalysis` и не вызывает `scheduleStyleShadow` / `applyEngineAnalysis`.
- Проверено на `EditorState` ProseMirror: применение `applyEngineAnalysis` и правки/смена текста во втором листе полностью изолированы и не изменяют состояние `TextAnalysis` и `ranges` первого листа.

### 2.3. История редактирования
- Проверено по исходнику (`renderer/analysis.js`: `applyEngineAnalysis` ставит `addToHistory: false`) и регрессионным тестом с настоящими `prosemirror-state` + `prosemirror-history` (`history`, `undo`, `redo`) в `test/style-shadow-f3-1-d.test.js`:
  - применение результатов движка не попадает в стек undo (после смены главы/применения `undo` недоступен);
  - правки до и после найденного фрагмента, а также `undo` (`Ctrl+Z`) и `redo` (`Ctrl+Shift+Z`) немедленно сбрасывают `old.engine`, не оставляя устаревших подсветок;
  - повторный анализ актуального текста после `undo`/`redo` даёт точные `ranges` (`doc.textBetween(from, to, '', '') === fragment`).

### 2.4. Большие документы
- Проверены главы существенно большего размера, чем в предыдущих E2E (превышающие порог `LAZY_MIN_SIZE = 6000`): ~7 КБ, ~25 КБ и ~60 КБ на реальной Russian-GSD в `debug` и `release`, включая измерение времени парсинга Rust/UDPipe, структурного анализа `analyzeStructural`, адаптера `findingsToRanges`, пиковой RSS-памяти и отмены длительного запроса (таблица в разделе 5).

### 2.5. Установленная Linux-сборка (`.deb`)
- Не проверялась (текущая среда — macOS `Darwin arm64`; см. раздел 7).

### 2.6. Символы и границы текста
- Проверено на реальной Russian-GSD (`real_model_handles_crlf_bom_and_paragraph_boundaries` в `style_parser.rs`) и через `createDocumentSnapshot` + `findingsToRanges` (`test/style-shadow-f3-1-d.test.js`):
  - BOM (`\uFEFF`) в начале документа и внутри строки, NBSP (`\u00A0`), ZWSP (`\u200B`), суррогатные пары emoji (`😀`), `U+2028`, `U+2029`, `\r\n\r\n` и одиночный `\r\n`.
  - Зафиксированный конвейер нормализации: при загрузке через Markdown (`tiptap-markdown`) `\r` нормализуется до границ блоков ProseMirror и не попадает в снимок; при прямом вызове `StyleParser::parse` одиночный `\r\n` (2 байта) разбивает блок в `paragraph_ranges`, при этом UTF-16 offsets совпадают со срезами `text` и `sentence.text` / `token.text` во всех случаях. Эталонными считаются UTF-16 offsets снимка `createDocumentSnapshot(editor.state.doc)`.

### 2.7. Мобильная платформа
- Проверены `mobile/package.json`, `mobile/backend.js` и запущен `node mobile/test/run-smoke.js`.
- Текущий механизм Rust/UDPipe к мобильной сборке **неприменим**: `mobile/` — это Capacitor Android-оболочка на JS без Rust и без `udpipe-rs`, в `mobile/backend.js` отсутствуют `styleParse` и `styleCancel`. В приложении `29-style-shadow.js` корректно уходит в fallback (`reason: 'ipc-unavailable'`) на `src/style.js`.
- При запуске `node mobile/test/run-smoke.js` тест падает на проверке паритета API с десктопом: `FAIL AssertionError [ERR_ASSERTION]: нет в api: styleCancel,styleParse` (кроме того, без сети падают проверки Яндекс Диска).

## 3. Проверки на настоящей Russian-GSD

Модель `/Users/rrrr/Downloads/russian-gsd-ud-2.5-191206.udpipe`, SHA-256 `ba63e42f79f525cbcb78c8bc98dd126c2960cbada91b964a741285c15504f06a` (подключалась через `KABINET_STYLE_MODEL`).

- `cargo test --lib style_parser -- --include-ignored` (`debug` и `release`): 20 / 20, включая 4 теста на реальной Russian-GSD (`real_model_builds_contract_with_utf16_offsets`, `real_model_survives_non_space_separators`, `real_model_handles_crlf_bom_and_paragraph_boundaries`, `cancel_stops_long_parse_between_paragraphs`).
- `cargo test --test style_parser_f3_1_d -- --include-ignored` (`debug` и `release`): 3 / 3 (гонка отмены до регистрации, реальная отмена в полёте + серия 6 быстрых переключений, большие документы 7–60 КБ).
- JS-анализ `analyzeStructural` + `findingsToRanges` поверх реального вывода Russian-GSD для глав ~7 КБ, ~25 КБ и ~60 КБ: `rejected = 0` на всех размерах.

## 4. Результаты debug / release и прочих проверок

| Проверка | Сборка | Модель | Результат | Примечание |
|---|---|---|---|---|
| `npm test` | — | JS + ProseMirror | 536 / 0 | Включая `test/style-shadow-f3-1-d.test.js` |
| `npm run check` | — | — | ✓ всё в порядке | После всех правок |
| `cargo test -- --include-ignored` (`kabinet-core`) | debug | Russian-GSD | 192 lib + 39 integ / 0 fail | Полный набор Rust-тестов |
| `cargo test --release --lib style_parser -- --include-ignored` | release | Russian-GSD | 20 / 0 | За 0.62 с |
| `cargo test --release --test style_parser_f3_1_d -- --include-ignored` | release | Russian-GSD | 3 / 0 | За 1.85 с |
| `cargo check` (`kabinet-tauri`) | debug | — | ok | Без ошибок компиляции |
| `node mobile/test/run-smoke.js` | — | — | FAIL | `нет в api: styleCancel,styleParse` + сеть |
| `npm run test:ui` | — | — | не запущен | Нет модуля `playwright` |
| `.deb` и живое окно `tauri-driver` | — | — | не запущены | Среда macOS (без Linux/Docker/`tauri-driver`) |

## 5. Время анализа и показатели больших документов

Замеры на macOS ARM64 (`Apple Silicon`), реальная Russian-GSD (после прогрева модели):

| Размер главы | Байт / символов | Предложений / токенов | Rust debug (мс) | Rust release (мс) | `analyzeStructural` (мс) | `findingsToRanges` (мс) | Находок / принято / отклонено |
|---|---|---|---|---|---|---|---|
| ~7 КБ (`> LAZY_MIN_SIZE`) | 6751 / 3747 | 70 / 710 | 99 (`wall 103`) | 102–104 | 4.75 | 0.55 | 60 / 60 / 0 |
| ~25 КБ | 24112 / 13383 | 250 / 2531 | 351 (`wall 365`) | 354–361 | 7.15 | 0.59 | 219 / 219 / 0 |
| ~60 КБ | 57823 / 32098 | 600 / 6075 | 827 (`wall 861`) | 820–827 | 15.44 | 2.43 | 525 / 525 / 0 |

- **Отмена длительного разбора** (~21.4 КБ, 200 абзацев): полный разбор `588 мс` (`debug`) / `570–581 мс` (`release`); отмена из соседнего потока через 40 мс завершается за `43 мс` (`debug`) / `45–46 мс` (`release`) с `cancelled: true`.
- **Пиковая память процесса** (`/usr/bin/time -l` на release-бинарнике `style_parser_f3_1_d` с загруженной Russian-GSD и прогоном 60 КБ): `maximum resident set size = 437 747 712` байт (~417.5 MiB), `peak memory footprint = 432 964 400` байт (~412.9 MiB).
- **Реакция интерфейса**: для документов `> 6000` символов `TextAnalysis` включает `isBig`, а полный цикл разбора 60 КБ (~845 мс суммарно в release) укладывается с запасом в `SHADOW_DEFAULT_TIMEOUT_MS = 10000`.

## 6. Найденные дефекты, причины и исправления

**Дефект 1 (исправлен): гонка между вызовом `style:cancel` и регистрацией задачи в `StyleParser::parse`.**
- **Причина:** `dispatch("style:parse")` в `experiments/tauri-app/src-tauri/src/main.rs` запускает `svc.parse(task_id, &text)` через `spawn_blocking`, а `style:cancel` вызывает `svc.cancel(task_id)` синхронно. Если `cancel(task_id)` приходил до захвата мьютекса в потоке `spawn_blocking`, `task_id` ещё не был в `self.current`, отмена терялась, и парсер выполнял весь разбор.
- **Исправление:** в `experiments/tauri-app/core/src/style_parser.rs` состояние задач заменено на `TaskState` с ограниченной очередью отменённых до старта идентификаторов (`MAX_CANCELLED_IDS = 256`). При поступлении `cancel(task_id)` до регистрации идентификатор запоминается, и `parse(task_id, ...)` сразу возвращает `{ taskId, cancelled: true }`. Дополнительно добавлена проверка флага отмены в `parse_inner` до загрузки/блокировки модели.
- **Регрессионные тесты:** `cancel_before_parse_registration_returns_cancelled` (`style_parser.rs`), `cancel_before_parse_and_new_task_works` и `real_model_mid_parse_cancel_and_rapid_switch` (`experiments/tauri-app/core/tests/style_parser_f3_1_d.rs`).

**Замечание 2 (не исправлялось, вне desktop-контура):** `mobile/test/run-smoke.js` падает с `нет в api: styleCancel,styleParse`, так как в `mobile/backend.js` не добавлены заглушки или реализация этих каналов.

## 7. Что не удалось проверить и почему

1. **Установленная Linux-сборка (`.deb`)** — текущая машина работает под macOS `Darwin arm64`, отсутствуют Linux-хост, Docker и `dpkg`.
2. **Живое окно Tauri (`WebKitGTK + tauri-driver`)** — `tauri-driver` не поддерживает macOS WKWebView; на macOS невозможно воспроизвести запуск реального окна с драйвером из `experiments/tauri-app/e2e/`.
3. **`npm run test:ui`** — в среде не установлен пакет `playwright`.

## 8. Остаточные риски

1. Итоговое поведение в установленном `.deb`-пакете на Linux (обнаружение модели из пользовательского каталога без env-переменных, отсутствие зависимости от debug-путей и живой отклик WebKitGTK на главах 60 КБ) требует подтверждения на Linux-раннере CI или локальной Linux-машине.
2. `mobile/test/run-smoke.js` остаётся красным из-за отсутствия `styleParse`/`styleCancel` в `mobile/backend.js` — при развитии мобильной сборки нужно либо добавить в `mobile/backend.js` явные заглушки с `ipc-unavailable`, либо скорректировать smoke-проверку.
3. Реальная отмена внутри C++ кода UDPipe происходит на границах абзацев (внутри одного очень длинного абзаца без пустых строк `model.parse(block)` дорабатывает до конца блока, прежде чем проверится `cancel`).
