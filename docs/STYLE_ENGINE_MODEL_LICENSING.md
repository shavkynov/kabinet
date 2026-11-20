# F.1 — юридическая проверка модели UDPipe Russian-GSD 2.5

Дата проверки: 2026-11-20. Ветка: `feature/linguistic-style-engine`, HEAD на момент начала: `d4645366d2d59345a7d7ca18b08c03acacce29d0`.

> Это исследовательская сводка по первичным источникам, а не юридическое заключение. Разрешения на распространение она не создаёт.

## Итог

**Статус: `BLOCKED`.**

Модель `russian-gsd-ud-2.5-191206.udpipe` нельзя добавлять в установщик, пока не выполнены два условия: письменное подтверждение условий от правообладателя модели (ÚFAL) и заключение юриста по вопросам из раздела 8. Оснований для разрешения в первичных источниках недостаточно, а имеющийся явный текст ограничивает использование.

Причины в порядке значимости:

1. Правообладатель модели заявляет для неё лицензию **CC BY-NC-SA** (некоммерческая). Лицензия корпуса (CC BY-SA 4.0) на модель автоматически не переносится.
2. Условия ShareAlike корпуса (CC BY-SA 4.0) и лицензии модели (CC BY-NC-SA) не стыкуются по первичным источникам; вопрос не решён.
3. Страница релиза модели в LINDAT не показала название лицензии, а файл `LICENSE` релиза не прочитан.
4. Принадлежность исходных текстов корпуса (жанр `wiki`) не подтверждена первичным источником: Google заявляет, что не претендует на права на «underlying content», а чьи это тексты и на каких условиях, README не говорит.
5. Статус самого продукта (коммерческий или бесплатный, лицензия на код) в репозитории не определён, поэтому применимость «non-commercial» оценить нельзя.

## 1. Что именно проверялось

«UDPipe Russian-GSD 2.5» в проекте — это файл **UDPipe 1** из релиза «Universal Dependencies 2.5 Models for UDPipe (2019-12-06)», имя файла `russian-gsd-ud-2.5-191206.udpipe`, 13,38 МБ, MD5 `35feb3bc8e3246bd900e364fe7dc6311` (страница релиза в LINDAT). Это не модель нейросетевого UDPipe 2, у которого отдельный список моделей и свои условия.

Как это используется в коде (HEAD `d464536`):

- `experiments/tauri-app/core/Cargo.toml:18` — зависимость `udpipe-rs = "0.2"`; в `Cargo.lock` зафиксирована версия `0.2.0`.
- `experiments/tauri-app/core/src/style_parser.rs:16` — `DEFAULT_MODEL_VERSION = "russian-gsd-ud-2.5-191206"`.
- `experiments/tauri-app/src-tauri/src/main.rs:922` — путь `resource_dir()/style-models/russian-gsd-ud-2.5-191206.udpipe`, переопределяется переменной `KABINET_STYLE_MODEL`.
- Файл модели в git не отслежен; `bundle` в `tauri.conf.json` ресурсов `style-models` не содержит; вызовов `download_model` в коде нет. То есть модель сейчас нигде не распространяется.

## 2. Сводная таблица

| Компонент | Правообладатель | Лицензия | Источник | Можно распространять |
|---|---|---|---|---|
| Корпус UD Russian-GSD (аннотации), v2.5 | Universal Dependencies contributors; вклад: McDonald, Nikolaev, Lyashevskaya; аннотировал и конвертировал Google | CC BY-SA 4.0 (с v2.5; «NC» снят) | [README r2.5](https://github.com/UniversalDependencies/UD_Russian-GSD/blob/r2.5/README.md), [LICENSE.txt r2.5](https://github.com/UniversalDependencies/UD_Russian-GSD/blob/r2.5/LICENSE.txt), [страница UD](https://universaldependencies.org/treebanks/ru_gsd) | Корпус как таковой — да, с атрибуцией и ShareAlike. **В приложение корпус не входит**, вопрос возникает только как исходник модели |
| Тексты внутри корпуса (жанр `wiki`) | Не установлен; Google заявляет, что не претендует на права | Не указана | README r2.5 | **Не подтверждено** |
| Модель `russian-gsd-ud-2.5-191206.udpipe` | ÚFAL, Charles University (Straka, Straková) | CC BY-NC-SA (заявлено ÚFAL); название лицензии на странице LINDAT не показано | [UDPipe 1 Models](https://ufal.mff.cuni.cz/node/1802), [LINDAT 11234/1-3131](https://lindat.mff.cuni.cz/repository/items/41f05304-629f-4313-b9cf-9eeb0a2ca7c6), [README UDPipe](https://github.com/ufal/udpipe/blob/9158bf7bb9270fd8d22cc06da36ee9e98b64922c/README.md) | **Нет (BLOCKED)** |
| UDPipe 1 (C++, код) | ÚFAL, Charles University | MPL 2.0 | [LICENSE](https://github.com/ufal/udpipe/blob/9158bf7bb9270fd8d22cc06da36ee9e98b64922c/LICENSE), [страница UDPipe 1](https://ufal.mff.cuni.cz/udpipe/1) | Да, при выполнении условий MPL 2.0 (раздел 4) |
| UniLib (внутри UDPipe) | ÚFAL | MPL 2.0 | [src/unilib/README](https://github.com/ufal/udpipe/blob/9158bf7bb9270fd8d22cc06da36ee9e98b64922c/src/unilib/README) | Да, как часть UDPipe |
| `udpipe-rs` 0.2.0 (Rust-обёртка) | Christopher Costello | MIT OR Apache-2.0 | [Cargo.toml](https://docs.rs/crate/udpipe-rs/latest/source/Cargo.toml), [README](https://docs.rs/crate/udpipe-rs/0.2.0/source/README.md) | Да (код обёртки); вендорит UDPipe (MPL 2.0) |
| Лицензии CC (BY-SA 4.0, BY-NC-SA 4.0) | Creative Commons | — | [BY-SA legalcode](https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt), [BY-NC-SA legalcode](https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.txt) | Тексты условий, применимы к корпусу и модели |

## 3. Корпус UD Russian-GSD

**Подтверждённые факты**

- README на теге `r2.5`: «Russian Universal Dependencies Treebank annotated and converted by Google.»
- Changelog там же: «2019-11-15 v2.5 — Google gave permission to drop the "NC" restriction from the license. This applies to the UD annotations (not the underlying content, of which Google claims no ownership or copyright).»
- Метаданные: `License: CC BY-SA 4.0`, `Includes text: yes`, `Genre: wiki`, `Contributors: McDonald, Ryan; Nikolaev, Vitaly; Lyashevskaya, Olga`.
- `LICENSE.txt`: «The treebank is licensed under the Creative Commons License Attribution-ShareAlike 4.0 International.»
- Страница UD сейчас: «License: CC BY-SA 4.0», «© 2014–2024 Universal Dependencies contributors».

**Неясности**

- Лицензия CC BY-SA 4.0 распространяется на аннотации. Принадлежность и условия использования самих текстов (`Includes text: yes`, жанр `wiki`) источником не раскрыты.
- До v2.5 корпус имел ограничение «NC». Модель обучена именно на данных v2.5 («created solely using UD 2.5 data»), но то, что снятие «NC» учтено в лицензии модели, нигде не сказано.

**Риски**

- Если тексты имеют собственные условия (например, свою лицензию-источник), BY-SA аннотаций их не заменяет.

**Обязательные условия (для корпуса / адаптаций), CC BY-SA 4.0 §3(a)(1)**

- «retain … a copyright notice», «a notice that refers to this Public License», ссылка на лицензию и «indicate if You modified the Licensed Material».

## 4. Модель и её веса

**Подтверждённые факты**

- Страница моделей UDPipe 1 для UD 2.5: «Universal Dependencies 2.5 Models are distributed under the CC BY-NC-SA licence.» и «The models were trained on Universal Dependencies 2.5 treebanks.»
- README UDPipe: «the linguistic models are free for non-commercial use and distributed under the CC BY-NC-SA license, although for some models the original data used to create the model may impose additional licensing conditions.»
- LINDAT, релиз `11234/1-3131`: описание «Tokenizer, POS Tagger, Lemmatizer and Parser models for 94 treebanks of 61 languages», «created solely using UD 2.5 data», дата 2019-12-06; в списке файлов есть `LICENSE` (20 kB).
- CC BY-NC-SA 4.0 §1(k): «NonCommercial means not primarily intended for or directed towards commercial advantage or monetary compensation.» §2(a)(1): лицензия «non-sublicensable».

**Неясности**

- Страница LINDAT показывает «Publicly Available and licensed under:» без названия лицензии. Файл `LICENSE` релиза **не прочитан**; его текст — первичный источник, который нужно получить.
- Заявлена общая лицензия на весь набор из 94 моделей. Для конкретной модели Russian-GSD, обученной на корпусе с CC BY-SA, отдельного подтверждения нет. Это не означает, что можно считать модель CC BY-SA: правообладатель модели явно выбрал NC.
- Почему модель, обученная на данных без «NC» (v2.5), распространяется как NC, источники не объясняют.

**Юридические риски**

- Распространение модели в составе приложения, которое продаётся или иным образом «primarily intended for … commercial advantage or monetary compensation», нарушит лицензию.
- Для «бесплатного» приложения применимость NC не очевидна: определение зависит от цели распространения, а не только от цены. Нужна оценка юриста (см. раздел 8).
- Прекращение прав при нарушении условий лицензии.

**Обязательные условия (если распространение когда-либо будет разрешено)**

- CC BY-NC-SA 4.0 §3(a): атрибуция (создатели, уведомление об авторских правах, ссылка на лицензию, указание изменений) и §3(b): ShareAlike.
- Цитирование ÚFAL согласно странице UDPipe: «If you use this tool for scientific work, please give credit to us by referencing Straka et al. 2016» (требование для научной работы; для приложения не обязательно, но стоит учесть при атрибуции).

## 5. UDPipe и библиотеки

**UDPipe 1**

- «UDPipe is a free software distributed under the Mozilla Public License 2.0.» Copyright 2017 ÚFAL, Charles University.
- Файл `LICENSE` — полный текст MPL 2.0.

**Условия MPL 2.0 при распространении (текст LICENSE)**

- §3.2: «If You distribute Covered Software in Executable Form then: (a) such Covered Software must also be made available in Source Code Form … and You must inform recipients of the Executable Form how they can obtain a copy of such Source Code Form».
- §3.3: «Larger Work» можно распространять на своих условиях при соблюдении требований MPL для Covered Software.
- §3.4: нельзя удалять уведомления об авторских правах и лицензии в исходниках.
- §3.1: изменённые файлы Covered Software распространяются только под MPL 2.0.

**UniLib**: «UniLib is an embeddable C++11 Unicode library under MPL 2.0 license».

**`udpipe-rs` 0.2.0**

- `license = "MIT OR Apache-2.0"`; README: «UDPipe itself is licensed under the Mozilla Public License 2.0.»
- В пакете каталог `vendor/`, `.gitmodules`: `path = vendor/udpipe`, `url = https://github.com/ufal/udpipe.git`. Сборка компилирует UDPipe статически («The build script compiles UDPipe as a static library automatically.»). Значит, итоговый бинарник содержит код под MPL 2.0.
- Имеет функцию `download_model` (загрузка из LINDAT); в проекте не вызывается.

**Неясности**

- Версия UDPipe, вендоренная в `udpipe-rs` 0.2.0, не определена (в `Cargo.lock` и CHANGELOG не указана). В `style_parser.rs` и `conllu-contract.js` указаны «0.2» и «1.4.0» — это значения полей контракта, а не проверенная версия.
- Содержимое `vendor/` не просмотрено; сторонние уведомления внутри него не проверены.
- Транзитивные зависимости (`ureq 3.x`, `cc`) в этой проверке не анализировались.

**Риски**

- Невыполнение §3.2 MPL 2.0 (не указан способ получения исходников UDPipe) при поставке бинарника.
- Нужна полная инвентаризация лицензий Cargo-зависимостей отдельным аудитом.

## 6. Условия распространения внутри desktop-приложения

- Модель — отдельный файл, который приложение читает с диска (`style-models/…`). Но распространение этого файла вместе с установщиком — это распространение лицензируемого материала со всеми его условиями.
- NC-ограничение относится к цели распространения, а не только к цене. В репозитории нет лицензии на код приложения (`package.json`: `"private": true`, без поля `license`), нет EULA и нет решения о монетизации. Без этого невозможно установить, подпадает ли распространение под NonCommercial.
- Пользовательское скачивание модели самим пользователем из LINDAT не снимает вопросов автоматически: условия приложения должны быть согласованы с юристом. В этой проверке такой вариант не оценивался.
- Статус на сегодня: модель не включена, ничего не распространяется.

## 7. Совместимость лицензий

| Пара | Вывод по источникам |
|---|---|
| UDPipe (MPL 2.0) ↔ приложение (Larger Work) | MPL 2.0 §3.3 допускает; при условии соблюдения §3.1–3.4 |
| `udpipe-rs` (MIT/Apache-2.0) ↔ MPL 2.0 | Совместимы по назначению: обёртка и вендоренный MPL-код остаются каждый под своей лицензией. Конкретный анализ — на юристе |
| Корпус (CC BY-SA 4.0) → модель (CC BY-NC-SA) | **Не решено.** CC BY-SA 4.0 §3(b)(1): «The Adapter's License You apply must be a Creative Commons license with the same License Elements, this version or later, or a BY-SA Compatible License.» §3(b)(3): нельзя «impose any additional or different terms or conditions … that restrict exercise of the rights granted under the Adapter's License». Страница CC о совместимости называет для BY-SA 4.0 лишь BY-SA 4.0 и позже, порты, Free Art License 1.3 и GPLv3 (односторонне), и **не** указывает BY-NC-SA. Является ли модель «Adapted Material» корпуса и допустима ли тут NC-надстройка — вопрос юристу; в пользу распространения не трактуется |
| Модель (CC BY-NC-SA) ↔ приложение | Применимость «NonCommercial» к конкретному продукту не установлена; ShareAlike-эффект на приложение не оценён |

## 8. Вопросы, которые невозможно решить без юриста / правообладателя

1. Что содержится в файле `LICENSE` релиза LINDAT `11234/1-3131` и какое название лицензии там указано? (Получить текст из релиза.)
2. Подтверждает ли ÚFAL письменно условия для модели Russian-GSD 2.5, в частности: почему NC при корпусе без «NC», допускается ли коммерческое и бесплатное встраивание в закрытое приложение?
3. Является ли распространение бесплатного приложения «primarily intended for or directed towards commercial advantage or monetary compensation» для CC BY-NC-SA 4.0 §1(k), если есть/нет планов монетизации, донатов, подписок, рекламы, платных функций?
4. Является ли обученная модель «Adapted Material» корпуса, и допустимо ли выпускать её под CC BY-NC-SA, учитывая CC BY-SA 4.0 §3(b)(1) и (3)?
5. На каких условиях существуют тексты внутри Russian-GSD (жанр `wiki`) и распространяется ли на модель их режим?
6. Какие ShareAlike-обязательства возникнут для приложения, поставляющего модель вместе с кодом, и можно ли поставлять модель как отдельный компонент?
7. Как выполнить §3.2 MPL 2.0 для статически слинкованного UDPipe в `udpipe-rs`?
8. Нужен ли отдельный аудит транзитивных Cargo-зависимостей и содержимого `vendor/` (версия UDPipe, сторонние уведомления)?
9. Какая лицензия и модель распространения у самого приложения «Кабинет»?

## 9. Условия, при которых статус может измениться

Статус может стать `CONDITIONAL` только после всего перечисленного:

- письменного ответа ÚFAL по вопросу 2 и текста `LICENSE` релиза (вопрос 1);
- юридического заключения по вопросам 3–6;
- решения о лицензии и модели распространения приложения (вопрос 9);
- подготовки файла уведомлений (атрибуция корпуса и модели, MPL 2.0, MIT/Apache-2.0).

`CLEARED` по имеющимся источникам невозможен.

## 10. Ограничения этой проверки

- Страницы читались через автоматическое извлечение текста; цитаты нужно сверить с оригиналами перед юридическим использованием.
- Не прочитаны: `LICENSE` релиза модели в LINDAT, содержимое `vendor/udpipe-rs`, лицензии транзитивных зависимостей.
- Страница UD 2.5 в LINDAT (`11234/1-3105`) показала лицензию лишь без названия; опорой для лицензии корпуса служат README и `LICENSE.txt` на теге `r2.5` в официальном репозитории.
- Страница UDPipe 2 Models (ufal.mff.cuni.cz/node/2110) прочитана частично (до UD 2.17); раздел UD 2.5 для UDPipe 1 прочитан на странице `node/1802`.

## Источники

- https://github.com/UniversalDependencies/UD_Russian-GSD/blob/r2.5/README.md
- https://github.com/UniversalDependencies/UD_Russian-GSD/blob/r2.5/LICENSE.txt
- https://universaldependencies.org/treebanks/ru_gsd
- https://ufal.mff.cuni.cz/node/1802 (UDPipe 1 Models)
- https://lindat.mff.cuni.cz/repository/items/41f05304-629f-4313-b9cf-9eeb0a2ca7c6 (UD 2.5 Models for UDPipe, 11234/1-3131)
- https://ufal.mff.cuni.cz/udpipe/1
- https://github.com/ufal/udpipe (README, LICENSE, src/unilib/README, commit `9158bf7`)
- https://docs.rs/crate/udpipe-rs/0.2.0 (README, Cargo.toml, .gitmodules)
- https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt
- https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.txt
- https://creativecommons.org/share-your-work/licensing-considerations/compatible-licenses
- https://lindat.mff.cuni.cz/repository/static/licence-UD-2.0.html
