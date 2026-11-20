# F.3.1-A — проверка и подключение Russian-GSD

**Итоговый статус: `ACCEPTED WITH CAVEATS`.**

Предоставленная модель UDPipe Russian-GSD UD 2.5 имеет ожидаемый SHA-256, реально загружается существующим `StyleParser` и возвращает токены, леммы, морфологические признаки и синтаксические зависимости. Дефектов, мешающих загрузке или использованию, не найдено; код не менялся. Оговорки — в разделе 8.

## 1. HEAD

- Исходный: `e4fd5a3848cb07f7e7752ae07cf58739fd1f89e3` (совпал с ожидаемым), ветка `feature/linguistic-style-engine`, рабочее дерево чистое.
- Итоговый: коммит с этим отчётом, родитель — `e4fd5a3…`. Собственный хэш отчёт содержать не может; см. `git log -2 feature/linguistic-style-engine`.
- Менялся только один файл: `docs/STYLE_ENGINE_F3_1_A_REPORT.md`. Другие ветки не трогались, PR #9 не менялся (остаётся Draft), force push не использовался.

## 2. Модель и SHA-256

- Файл: `russian-gsd-ud-2.5-191206.udpipe`, 14 034 257 байт.
- SHA-256 (посчитан по приложенному файлу и повторно по размещённой копии): `ba63e42f79f525cbcb78c8bc98dd126c2960cbada91b964a741285c15504f06a` — **совпадает** с ожидаемым и с `DEFAULT_MODEL_SHA256` в `style_parser.rs`.
- Версия: `russian-gsd-ud-2.5-191206` (совпадает с `DEFAULT_MODEL_VERSION`).
- Использовалась только эта модель, альтернативные не применялись.

## 3. Размещение

`~/.local/share/ru.kabinet.writer.tauri/style-models/russian-gsd-ud-2.5-191206.udpipe`

Это `<каталог данных приложения>/style-models/<MODEL_FILE_NAME>` — первое место поиска после `KABINET_STYLE_MODEL` в `resolve_model_path`. Каталог данных на Linux выведен из `identifier` в `tauri.conf.json` (`ru.kabinet.writer.tauri`); в запущенном Tauri-приложении путь не проверялся (см. раздел 8). Каталог находится вне репозитория.

## 4. Реальная загрузка

- Через `resolve_model_path(None, <каталог данных>, None)` без `KABINET_STYLE_MODEL` путь разрешился в файл из раздела 3.
- `StyleParser::parse` выполнил проверку SHA-256, затем `udpipe_rs::Model::load` — успешно. Ответ содержит `parser.modelVersion = russian-gsd-ud-2.5-191206` и `parser.modelSha256 = ba63e42f…f06a`.
- Разбор двух предложений занял 5 мс (debug-сборка, модель уже загружена в рамках процесса).

## 5. Пример разбора

Текст: «Мама мыла раму. Дом, который стоял у реки, продаётся.»  
Offsets — UTF-16 code units; `head` — номер токена в предложении, 0 — корень.

```
S [0..15] "Мама мыла раму."
  1 Мама       Мама       NOUN  h=2 nsubj      [0..4]    Animacy=Anim|Case=Nom|Gender=Fem|Number=Sing
  2 мыла       мыть       VERB  h=0 root       [5..9]    Aspect=Perf|Gender=Fem|Mood=Ind|Number=Sing|Tense=Past|VerbForm=Fin|Voice=Act
  3 раму       рам        NOUN  h=2 obj        [10..14]  Animacy=Inan|Case=Acc|Gender=Fem|Number=Sing
  4 .          .          PUNCT h=2 punct      [14..15]
S [16..53] "Дом, который стоял у реки, продаётся."
  1 Дом        дом        PROPN h=8 nsubj      [16..19]  Animacy=Inan|Case=Nom|Gender=Masc|Number=Sing
  2 ,          ,          PUNCT h=4 punct      [19..20]
  3 который    который    PRON  h=4 nsubj      [21..28]  Animacy=Anim|Case=Nom|Gender=Masc|Number=Sing
  4 стоял      стоять     VERB  h=1 acl:relcl  [29..34]  Aspect=Imp|Gender=Masc|Mood=Ind|Number=Sing|Tense=Past|VerbForm=Fin|Voice=Act
  5 у          у          ADP   h=6 case       [35..36]
  6 реки       река       NOUN  h=4 obl        [37..41]  Animacy=Inan|Case=Gen|Gender=Fem|Number=Sing
  7 ,          ,          PUNCT h=4 punct      [41..42]
  8 продаётся  продаваться VERB h=0 root       [43..52]  Aspect=Perf|Mood=Ind|Number=Sing|Person=3|Tense=Fut|VerbForm=Fin|Voice=Mid
  9 .          .          PUNCT h=8 punct      [52..53]
```

Подтверждено получение: токенов с точными UTF-16 offsets, лемм, UPOS, морфологических признаков (`feats`), `head`/`deprel`. Структура зависимостей осмысленна: корни — глаголы, `nsubj`/`obj`/`obl`/`case`/`punct`, относительное придаточное `acl:relcl`.

Наблюдаемые ошибки самой модели (не дефекты Кабинета, к загрузке не относятся): лемма «рам» вместо «рама»; «Дом» помечен `PROPN` (из-за заглавной буквы); «мыла» получило `Aspect=Perf`; «который» получил `Animacy=Anim`. Для стилевого анализа это нужно учитывать при настройке правил.

## 6. Выполненные тесты

Команда (в `experiments/tauri-app/core`):

```
KABINET_STYLE_MODEL=<путь из раздела 3> cargo test --lib style_parser -- --include-ignored
```

Результат: **18 passed, 0 failed, 0 ignored**. В их числе три теста, требующие настоящую модель и ранее пропускавшиеся как `#[ignore]`:

- `real_model_builds_contract_with_utf16_offsets` — два предложения, границы и UTF-16 offsets совпадают с исходником;
- `real_model_survives_non_space_separators` — U+0085, U+2028, U+2029, U+000B, U+000C в четырёх позициях;
- `cancel_stops_long_parse_between_paragraphs` — отмена между абзацами на 1200 абзацев.

Плюс разовый прогон пробного примера (раздел 5) через штатный путь без переменной окружения. Пробный файл `examples/f31a_probe.rs` удалён и в Git не попал.

## 7. Модель не попала в Git, ресурсы и пакет

- `git status` до и после — чистое дерево; `git ls-files | grep -i -E '\.udpipe|style-models|\.model$'` — пусто; `find` по рабочей копии не находит `*.udpipe`.
- `tauri.conf.json`: нет ключей `bundle.resources` и `externalBin`; `tauri.linux.conf.json` (`.deb`) содержит только `desktopTemplate`; `build.cjs`, `Cargo.toml` и `.github` не ссылаются на `udpipe`/`style-models`.
- Модель лежит в каталоге данных пользователя, а не в `resource_dir`, поэтому в установщик не попадает.
- Файл `docs/STYLE_ENGINE_F3_1_A_REPORT.md` добавлен в Git принудительно (`git add -f`): каталог `docs/` в `.gitignore`, но уже содержит отслеживаемые файлы.

## 8. Проблемы и ограничения

1. **Установочный пакет не собирался.** Отсутствие модели в `.deb` подтверждено по конфигурации и содержимому репозитория, а не инспекцией собранного пакета. Для строгого подтверждения нужно собрать `.deb` и выполнить `dpkg -c`.
2. **Запущенное Tauri-приложение не проверялось.** Загрузка проверена через `StyleParser` и `resolve_model_path` с путём, выведенным из `identifier`. Совпадение с `app.path().app_data_dir()` в реальном бинарнике (IPC-сценарий `e2e/real-ipc.js`, `userdir`) не подтверждено.
3. Проверка выполнена на Linux x86_64 в debug-сборке; производительность на длинных текстах не измерялась (вне задачи).
4. В `.gitignore` нет правила `*.udpipe`; случайный `git add` модели из репозитория ничто не остановит. Не исправлялось, чтобы не расширять задачу; рекомендуется отдельным малым изменением.
5. Лицензионный статус модели остаётся `CONDITIONAL` (см. `docs/STYLE_ENGINE_F3_REPORT.md`); этот отчёт его не решает.
6. Полный E2E-аудит приложения не проводился (по условиям задачи).
7. Ошибки разбора модели из раздела 5 — свойство Russian-GSD, качество стилевых правил на реальных текстах этим отчётом не оценивается.
