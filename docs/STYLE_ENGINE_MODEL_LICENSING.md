# F.1.1 — лицензионный аудит UDPipe Russian-GSD 2.5 и подготовка к поставке

Дата проверки: 2026-11-20. Ветка: `feature/linguistic-style-engine`.

- HEAD в начале F.1.1: `78363457044699febba2ab6f2a9bf95a35ab922f`.
- Модель в репозиторий, Tauri resources и установщик **не добавлена**.
- Код анализатора, парсер и категории в этой задаче не менялись.

> Это исследовательская сводка по первичным источникам, а не юридическое заключение.
> Она не заменяет заключение юриста и не создаёт разрешения, которого нет в лицензии.

## Итог

**Статус: `CONDITIONAL`.**

Распространение модели в бесплатном некоммерческом приложении **возможно после выполнения перечисленных ниже условий**, но не является `CLEARED`:

1. Подтверждена лицензия самого релиза модели: LINDAT metadata указывает
   **CC BY-NC-SA 4.0**.
2. Условие NonCommercial **само по себе не является препятствием** для
   бесплатного некоммерческого приложения. Оно становится препятствием только
   при коммерческой монетизации; проект должен зафиксировать это в EULA/условиях.
3. Остаётся нерешённым юридический вопрос о том, являются ли веса модели
   `Adapted Material` аннотаций корпуса CC BY-SA 4.0. Если являются, возникает
   коллизия ShareAlike: CC BY-SA 4.0 не указывает CC BY-NC-SA 4.0 как
   допустимую лицензию для адаптаций. Если не являются, модель регулируется
   своей лицензией CC BY-NC-SA.
4. Права на исходные тексты корпуса (жанр `wiki`) по первичным источникам не
   установлены. Google заявляет, что не претендует на права на underlying
   content, но это не определяет лицензию самих текстов.
5. MPL 2.0 для встроенного UDPipe и notices для Cargo-зависимостей выполнимы,
   но требуют поставки исходников/уведомлений. Сейчас в приложении нет ни
   EULA, ни `license`-поля у собственных Rust-пакетов.

До выполнения условий модель **не включать**. Если юридическая проверка
признает веса адаптацией CC BY-SA и не будет получено разрешение
правообладателя, статус должен быть изменён на `BLOCKED`.

## 1. Что именно распространяется

Модель в проекте — файл **UDPipe 1** из релиза
«Universal Dependencies 2.5 Models for UDPipe (2019-12-06)»:

- имя: `russian-gsd-ud-2.5-191206.udpipe`;
- размер: 14 034 257 байт;
- MD5: `35feb3bc8e3246bd900e364fe7dc6311`;
- SHA-256: `ba63e42f79f525cbcb78c8bc98dd126c2960cbada91b964a741285c15504f06a`;
- локальный файл не изменялся;
- в git не отслеживается; `tauri.conf.json` не содержит `style-models` в
  `bundle.resources`; вызовов скачивания модели в приложении нет.

Это **не** модель UDPipe 2: у UDPipe 1 и UDPipe 2 разные релизы и условия.

## 2. Таблица компонентов

| Компонент | Правообладатель / контрибьюторы | Лицензия | Первичный источник | Обязательства / статус |
|---|---|---|---|---|
| Модель `russian-gsd-ud-2.5-191206.udpipe` | ÚFAL, Charles University; Milan Straka, Jana Straková | **CC BY-NC-SA 4.0** — подтверждено metadata LINDAT | LINDAT item `41f05304-629f-4313-b9cf-9eeb0a2ca7c6`, handle `11234/1-3131`; UFAL UDPipe 1 Models | attribution, license notice, ShareAlike для адаптаций, только NonCommercial; модель не изменена |
| Аннотации UD Russian-GSD r2.5 | UD contributors: McDonald, Nikolaev, Lyashevskaya; аннотировал/конвертировал Google | **CC BY-SA 4.0** | `UD_Russian-GSD` r2.5 `README.md`, `LICENSE.txt` | attribution и ShareAlike для адаптаций; в приложение корпус не входит |
| Исходные тексты корпуса (жанр `wiki`) | не установлен; Google заявляет об отсутствии прав на underlying content | **не установлена** | README r2.5: «Genre: wiki», Google claims no ownership | вопрос требует проверки происхождения/лицензии текстов |
| UDPipe 1 C++ (вендор `udpipe-rs` 0.2.0) | ÚFAL, Charles University | **MPL 2.0** | `vendor/udpipe/LICENSE`, заголовки `src/**`; версия `1.4.1-dev` | сохранить notices, предоставить Source Code Form Covered Software, не налагать дополнительных ограничений |
| `udpipe-rs` 0.2.0 (Rust bindings/wrapper) | Christopher Costello | **MIT OR Apache-2.0** | crates.io/docs.rs; `LICENSE-MIT`, `LICENSE-APACHE-2.0` | включить MIT/Apache notices |
| Cargo-зависимости приложения | см. полный инвентарь | преимущественно MIT/Apache-2.0; есть MPL-2.0, Unicode-3.0, CDLA-Permissive-2.0 и др. | `Cargo.lock` + crates.io metadata | notices/source для MPL и attribution для остальных |
| Собственные `kabinet-core`, `kabinet-tauri` | проект | **не указана** | `Cargo.toml` | до поставки определить лицензию/EULA приложения |

## 3. Подтверждённые факты

### 3.1. Релиз LINDAT

Проверены item metadata и bitstream'ы LINDAT:

- API item:
  `https://lindat.mff.cuni.cz/repository/server/api/core/items/41f05304-629f-4313-b9cf-9eeb0a2ca7c6`
- `dc.rights`:
  `Creative Commons - Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)`
- `dc.rights.uri`:
  `http://creativecommons.org/licenses/by-nc-sa/4.0/`
- `dc.title`:
  `Universal Dependencies 2.5 Models for UDPipe (2019-12-06)`
- `dc.date.issued`: `2019-12-06`
- bundle `LICENSE` содержит один bitstream `license.txt`, 1655 байт,
  SHA-256 `08a3b03e25c12c8df9c277de4b8ae70ae4540e0ce1fdce55267e155f72c0faf4`.

Важно: этот `license.txt` — **NON-EXCLUSIVE DISTRIBUTION LICENSE**, которую
подписал депозитор для CUNI. Это **не** отдельная публичная лицензия модели.
Публичная лицензия модели подтверждается metadata `dc.rights`/`dc.rights.uri`,
а не текстом deposit-license.

### 3.2. UFAL

Страница «UDPipe 1 Models» прямо указывает:

> Universal Dependencies 2.5 Models are distributed under the CC BY-NC-SA licence.

URL: `https://ufal.mff.cuni.cz/node/1802`.

Это согласуется с LINDAT metadata и с `vendor/udpipe/README`, где сказано,
что языковые модели распространяются под CC BY-NC-SA, а сам UDPipe — под
MPL 2.0.

### 3.3. Корпус

`UD_Russian-GSD` r2.5 `README.md`:

- «annotated and converted by Google»;
- «v2.5: Google gave permission to drop the "NC" restriction from the license.
  This applies to the UD annotations (not the underlying content, of which
  Google claims no ownership or copyright)»;
- machine-readable metadata: `License: CC BY-SA 4.0`, `Includes text: yes`,
  `Genre: wiki`;
- `LICENSE.txt`: «The treebank is licensed under the Creative Commons License
  Attribution-ShareAlike 4.0 International».

Первичные URL:

- `https://github.com/UniversalDependencies/UD_Russian-GSD/blob/r2.5/README.md`
- `https://github.com/UniversalDependencies/UD_Russian-GSD/blob/r2.5/LICENSE.txt`

### 3.4. `udpipe-rs` и вендор

Скачан и распакован опубликованный crate `udpipe-rs 0.2.0`:

- crates.io tarball SHA-256:
  `9a8f34a036b145a2d253613c2742c836f79c9d5f9c2220f03931762224d23452`;
- `Cargo.toml`: `license = "MIT OR Apache-2.0"`;
- `.gitmodules`: `vendor/udpipe` → `https://github.com/ufal/udpipe.git`;
- `vendor/udpipe/LICENSE` — полный MPL 2.0;
- `vendor/udpipe/src/version/version.cpp` — `1.4.1-dev`;
- `vendor/udpipe/CHANGES.md` — последняя стабильная запись `1.4.0 [20 Nov 25]`;
- `build.rs` компилирует C++ из `vendor/udpipe/src` (основные подкаталоги
  `model`, `morphodita`, `parsito`, `sentence`, `unilib`, `tokenizer`,
  `trainer`, `utils`) и статически линкует библиотеку `udpipe`;
- в исходниках UDPipe сохранены MPL-заголовки и copyright ÚFAL;
- `src/udpipe_wrapper.cpp` — часть crate `udpipe-rs`, для него действует
  MIT/Apache-2.0.
- Проверка 287 C++/header-файлов vendor: 27 файлов не содержат MPL-заголовок
  в первых 500 символах. Это `releases/java/**/jni*.h` и
  `src/rest_server/microrestd/libmicrohttpd/*` (сторонние JNI/libmicrohttpd
  файлы); `build.rs` не компилирует `rest_server`. Для самих компилируемых
  подкаталогов заголовки MPL и copyright ÚFAL сохранены; полный vendor
  всё равно содержит третьи notices.

`rest_server`/`microrestd`/`libmicrohttpd` в `build.rs` не входят в список
компилируемых подкаталогов. Это важно: наличие файлов в vendored tree само по
себе не означает, что LGPL-код libmicrohttpd попадает в бинарник, но полный
vendor-архив всё равно содержит третьи лицензии.

### 3.5. Cargo-аудит

Полный инвентарь сгенерирован из `cargo metadata --locked`:

- [`docs/STYLE_ENGINE_CARGO_LICENSES.tsv`](STYLE_ENGINE_CARGO_LICENSES.tsv) —
  562 пакета: `package`, `version`, `license`, `repository`.

Инструмент и результат:

```sh
cargo install cargo-deny --locked --version 0.22.0

cd experiments/tauri-app/src-tauri
cargo deny --config /path/to/deny-licenses.toml check licenses
# licenses ok
```

Использованная конфигурация:

```toml
[licenses]
confidence-threshold = 0.8
allow = [
  "0BSD", "Apache-2.0", "Apache-2.0 WITH LLVM-exception",
  "BSD-2-Clause", "BSD-3-Clause", "CDLA-Permissive-2.0",
  "CC0-1.0", "ISC", "MIT", "MIT-0", "MPL-2.0",
  "Unicode-3.0", "Unlicense", "Zlib",
]
[licenses.private]
ignore = true
```

Результат: **562 пакета, `licenses ok`**, ни одна лицензия не была отклонена
этим allowlist. Это не означает отсутствие obligations: MPL и notices
перечислены ниже.

Что требует внимания:

- **MPL-2.0 (7 пакетов):** `cssparser` 0.37.0 и 0.38.0,
  `cssparser-macros` 0.7.1, `dtoa-short` 0.3.5, `option-ext` 0.2.0,
  `selectors` 0.38.0 и 0.41.0. Нужны notices и Source Code Form для
  Covered Software.
- **CDLA-Permissive-2.0 (2):** `webpki-roots` 0.26.11/1.0.12.
- **Unicode-3.0 (18):** ICU4X/Unicode data crates; нужны Unicode notices.
- **CC0-1.0:** `notify`, `tiny-keccak`; attribution не требуется, но
  происхождение следует сохранить в notices.
- **Unlicense/MIT и Zlib/Apache/MIT:** стандартные permissive-наборы.
- **r-efi** имеет вариант `LGPL-2.1-or-later`, но лицензия выражена как
  `MIT OR Apache-2.0 OR LGPL-2.1-or-later`; проект может выбрать MIT/Apache,
  отдельная LGPL-обязанность не возникает при таком выборе.
- **Собственные `kabinet-core` и `kabinet-tauri`** не имеют `license` metadata.
  `cargo-deny` не считает их ошибкой только из-за `private.ignore`; это
  отдельный дефект поставки, а не проблема транзитивных зависимостей.
- `cargo-deny` **не видит** C++ `vendor/udpipe`: его MPL-обязанности
  проверяются вручную и не покрываются лицензией crate `udpipe-rs`
  `MIT OR Apache-2.0`.

## 4. Совместимость лицензий корпуса и модели

### 4.1. Что известно

- UD Russian-GSD annotations: **CC BY-SA 4.0**.
- Модель: **CC BY-NC-SA 4.0** по metadata LINDAT/UFAL.
- Модель обучена на UD 2.5 treebanks; UFAL указывает, что модели основаны
  solely on UD 2.5 data.
- CC BY-SA 4.0 и CC BY-NC-SA 4.0 — разные наборы License Elements:
  у второй добавлен NonCommercial.

### 4.2. Точные положения CC

CC BY-SA 4.0, §1(a) определяет Adapted Material как материал, производный
от Licensed Material и изменённый способом, требующим разрешения по
copyright/similar rights. Это фактический и правовой тест, а не автоматическая
характеристика любого обучения модели.

Официальная страница CC о совместимости:

- для адаптаций BY-SA 4.0 разрешены BY-SA 4.0/позднее, ported-версии или
  BY-SA Compatible License;
- BY-NC-SA 4.0 **не указана** в списке BY-SA-совместимых лицензий;
- для адаптаций BY-NC-SA 4.0 разрешены BY-NC-SA 4.0/позднее или
  BY-NC-SA Compatible License; не-CC совместимых лицензий сейчас нет.

Источники:

- <https://creativecommons.org/licenses/by-sa/4.0/legalcode>
- <https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode>
- <https://creativecommons.org/share-your-work/licensing-considerations/compatible-licenses>

### 4.3. Вывод

Нельзя автоматически утверждать ни того, что веса являются Adapted Material
аннотаций, ни обратного.

- Если веса **являются** Adapted Material CC BY-SA 4.0, то распространение
  адаптации под CC BY-NC-SA 4.0 не соответствует ShareAlike BY-SA 4.0:
  BY-NC-SA не входит в разрешённый список. Нужно разрешение правообладателя
  или иное юридическое решение.
- Если веса **не являются** Adapted Material (например, самостоятельный
  результат обучения, не воспроизводящий охраняемое выражение), то действует
  лицензия модели CC BY-NC-SA 4.0, и коллизии ShareAlike нет.
- Это требует заключения юриста или письменного разъяснения ÚFAL/Google.
  Один и тот же ответ нельзя выводить из того, что приложение бесплатное.

### 4.4. NC и бесплатное приложение

CC BY-NC-SA 4.0 §2(a)(1) разрешает воспроизведение и распространение
Licensed Material/Adapted Material **только для NonCommercial purposes**.
§1(k) определяет NonCommercial как «not primarily intended for or directed
towards commercial advantage or monetary compensation».

Проект заявляет, что «Кабинет» всегда бесплатный и некоммерческий. При таком
фактическом способе распространения NC-условие не требует отдельного
разрешения: оно уже входит в публичную лицензию. Но это должно быть
зафиксировано в условиях приложения и не должно нарушаться рекламой,
платными функциями, продажей сборок или иной монетизацией.

### 4.5. Исходные тексты

README UD Russian-GSD говорит: `Genre: wiki`; Google заявляет, что не
претендует на права на underlying content. Этого **недостаточно**, чтобы
установить:

- кто автор конкретных текстов;
- под какой лицензией они были взяты;
- сохраняются ли ограничения на обучение/модель.

Если модель не распространяет исходные тексты, это может снизить риск, но не
устраняет вопрос о правах на обучающие данные. Нужна проверка происхождения
или письменное подтверждение правообладателя.

## 5. Обязательства при распространении

### 5.1. Модель

- Сохранить attribution ÚFAL/Charles University, авторов модели, название и
  версию `russian-gsd-ud-2.5-191206`.
- Указать источник: LINDAT handle `11234/1-3131`, item
  `41f05304-629f-4313-b9cf-9eeb0a2ca7c6`.
- Указать CC BY-NC-SA 4.0 и дать текст или URI лицензии.
- Указать, были ли изменения. Сейчас модель не изменялась.
- Не налагать на модель дополнительные ограничения, не использовать DRM,
  не препятствовать осуществлению прав по CC.
- Не субліцензировать модель: пользователи получают права непосредственно по
  CC; EULA приложения не должна выдавать себя за сублицензию модели.
- Если модель адаптируется/изменяется — ShareAlike и отметка изменений;
  перед этим требуется отдельное юридическое решение.

### 5.2. Корпус

- Если корпус или его адаптация распространяются: attribution UD Russian-GSD,
  CC BY-SA 4.0, ссылку на лицензию, отметку изменений и ShareAlike.
- В текущем приложении корпус не поставляется; это не отменяет вопрос об
  использовании корпуса для обучения модели.

### 5.3. UDPipe / MPL 2.0

MPL 2.0 — file-level copyleft, не требует открывать всё приложение. Для
Covered Software нужно:

- сохранить copyright/license notices;
- предоставить Source Code Form именно Covered Software;
- сообщить получателю, как получить исходники;
- если распространяется Executable Form, выполнить MPL §3.2 (source available
  at same place / instructions) или §3.3 (written offer / alternative);
- не налагать на Covered Software дополнительные условия, ограничивающие
  права по MPL;
- изменения Covered Software, если они будут, лицензировать под MPL;
- не использовать имена/товарные знаки ÚFAL как endorsement.

Предлагаемая формулировка для notices:

```text
UDPipe 1 (vendored in udpipe-rs 0.2.0)
Copyright 2016 Institute of Formal and Applied Linguistics,
Faculty of Mathematics and Physics, Charles University.
Licensed under the Mozilla Public License, v. 2.0.
Source Code Form: https://crates.io/api/v1/crates/udpipe-rs/0.2.0/download
(or the source archive shipped with the application).
No modifications by Kabinet.
MPL 2.0: https://www.mozilla.org/en-US/MPL/2.0/
```

Если приложение поставляет только бинарник, к нему нужно приложить исходники
вендорного UDPipe или рабочую ссылку на них и инструкции сборки.

### 5.4. `udpipe-rs`

```text
udpipe-rs 0.2.0
Copyright (c) 2025 Christopher Costello
Licensed under MIT OR Apache-2.0.
Source: https://github.com/ccostello97/udpipe-rs
```

### 5.5. Cargo-зависимости

До поставки нужен `THIRD_PARTY_NOTICES` (или аналог), включающий:

- MIT/Apache/BSD/ISC notices;
- MPL notices и source offer для семи MPL-пакетов;
- Unicode-3.0 notices;
- CDLA-Permissive-2.0 notices;
- CC0/Unlicense provenance;
- ссылки на source archives.

Полный перечень пакетов и лицензий — в
[`docs/STYLE_ENGINE_CARGO_LICENSES.tsv`](STYLE_ENGINE_CARGO_LICENSES.tsv).
Сам файл не является заменой текстам лицензий: notices должны содержать
copyright/лицензионные тексты, а не только имя пакета.

## 5.6. Подготовленные файлы уведомлений

Эти файлы подготовлены отдельно в `docs/licenses/` и **не** подключены к
runtime, Tauri resources или установщику:

- [`MODEL-NOTICE.txt`](licenses/MODEL-NOTICE.txt) — attribution модели,
  версия, источник, лицензия, отсутствие изменений и атрибуция корпуса;
- [`CC-BY-NC-SA-4.0.txt`](licenses/CC-BY-NC-SA-4.0.txt) — полный текст
  CC BY-NC-SA 4.0;
- [`UDPIPE-MPL-NOTICE.txt`](licenses/UDPIPE-MPL-NOTICE.txt) — MPL 2.0
  notice, версия вендора и source offer;
- [`MPL-2.0.txt`](licenses/MPL-2.0.txt) — полный текст MPL 2.0;
- [`UDPIPE-RS-NOTICE.txt`](licenses/UDPIPE-RS-NOTICE.txt) — notice
  `udpipe-rs 0.2.0`;
- [`udpipe-rs-MIT.txt`](licenses/udpipe-rs-MIT.txt) и
  [`udpipe-rs-APACHE-2.0.txt`](licenses/udpipe-rs-APACHE-2.0.txt) — тексты
  лицензий crate.

Для Cargo-зависимостей полный пакет notices должен быть собран из
[`STYLE_ENGINE_CARGO_LICENSES.tsv`](STYLE_ENGINE_CARGO_LICENSES.tsv) с
добавлением текстов/copyright для каждого пакета. Один TSV не заменяет
`THIRD_PARTY_NOTICES`.

## 6. Проект EULA: что нельзя писать

EULA приложения пока отсутствует. При её подготовке необходимо:

1. Прямо отделить лицензию приложения от лицензий third-party/model.
2. Не утверждать, что приложение сублицензирует модель: пользователь получает
   CC-права напрямую от лицензиара.
3. Не запрещать копирование, изменение и распространение модели в пределах
   CC BY-NC-SA 4.0.
4. Не запрещать reverse engineering/доступ к исходникам Covered Software,
   если это необходимо для осуществления прав по MPL 2.0.
5. Не налагать DRM/дополнительные условия на модель или MPL-код.
6. Сохранять attribution и license notices при распространении.
7. Не заявлять, что «все права reserved» распространяются на third-party
   components.
8. Не обещать коммерческое использование модели; условия NonCommercial
   должны соблюдаться.
9. Сделать так, чтобы прекращение EULA не отменяло уже предоставленные
   CC/MPL права.
10. Указать, что модель поставляется «as is», с disclaimer авторов, в пределах
    допустимого.

Пример оговорки:

```text
Настоящая EULA регулирует только приложение Kabinet и не ограничивает
права, предоставленные вам лицензиями третьих сторон. Модель
russian-gsd-ud-2.5-191206 распространяется по CC BY-NC-SA 4.0;
UDPipe распространяется по MPL 2.0. В случае противоречия EULA и
этих лицензий преимущество имеют соответствующие лицензии третьих сторон.
```

## 7. Условия для перехода в `CLEARED`

До `CLEARED` необходимо:

- [ ] Получить заключение юриста/правообладателя по вопросу Adapted Material
      и совместимости CC BY-SA 4.0 / CC BY-NC-SA 4.0.
- [ ] Подтвердить происхождение и лицензию underlying wiki texts либо получить
      разрешение.
- [ ] Зафиксировать noncommercial статус приложения в EULA/условиях.
- [ ] Добавить attribution, CC BY-NC-SA 4.0, MPL notices и source offer.
- [ ] Сгенерировать и проверить `THIRD_PARTY_NOTICES` для Cargo-зависимостей.
- [ ] Добавить `license`/EULA для `kabinet-core` и `kabinet-tauri`.
- [ ] Проверить, что EULA не ограничивает CC/MPL права.
- [ ] Провести финальный legal review перед включением модели в bundle.

До этого включение модели в `bundle.resources`/установщик запрещено.

## 8. Нерешённые вопросы

1. Являются ли веса модели Adapted Material аннотаций UD Russian-GSD?
2. Совместимы ли CC BY-SA 4.0 и CC BY-NC-SA 4.0 для конкретного способа
   обучения/распространения модели?
3. Кто правообладатель исходных wiki-текстов и на каких условиях они
   использовались?
4. Достаточно ли лицензии LINDAT/ÚFAL для распространения модели, если
   исходные тексты имели отдельные ограничения?
5. Какой лицензией/EULA будет лицензировано само приложение?
6. Требуется ли письменное подтверждение ÚFAL о версии/содержимом модели и
   отсутствии дополнительных ограничений?

## 9. Источники

### Модель и корпус

- LINDAT item (metadata): <https://lindat.mff.cuni.cz/repository/items/41f05304-629f-4313-b9cf-9eeb0a2ca7c6>
- LINDAT item API: <https://lindat.mff.cuni.cz/repository/server/api/core/items/41f05304-629f-4313-b9cf-9eeb0a2ca7c6>
- LINDAT `license.txt` (deposit license): <https://lindat.mff.cuni.cz/repository/server/api/core/bitstreams/94b48668-86b0-4eae-90b2-7a8385a72a2d/content>
- UFAL UDPipe 1 Models: <https://ufal.mff.cuni.cz/node/1802>
- UD Russian-GSD r2.5 README: <https://github.com/UniversalDependencies/UD_Russian-GSD/blob/r2.5/README.md>
- UD Russian-GSD r2.5 LICENSE: <https://github.com/UniversalDependencies/UD_Russian-GSD/blob/r2.5/LICENSE.txt>
- UD Russian-GSD page: <https://universaldependencies.org/treebanks/ru_gsd>

### UDPipe / udpipe-rs

- UDPipe repository: <https://github.com/ufal/udpipe>
- UDPipe LICENSE (MPL 2.0): <https://github.com/ufal/udpipe/blob/master/LICENSE>
- UDPipe README: <https://github.com/ufal/udpipe/blob/master/README>
- `udpipe-rs` crate: <https://crates.io/crates/udpipe-rs/0.2.0>
- `udpipe-rs` source archive: <https://crates.io/api/v1/crates/udpipe-rs/0.2.0/download>
- `udpipe-rs` repository: <https://github.com/ccostello97/udpipe-rs>
- `udpipe-rs` docs: <https://docs.rs/crate/udpipe-rs/0.2.0>

### Creative Commons

- CC BY-SA 4.0 legal code: <https://creativecommons.org/licenses/by-sa/4.0/legalcode>
- CC BY-NC-SA 4.0 legal code: <https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode>
- CC compatibility: <https://creativecommons.org/share-your-work/licensing-considerations/compatible-licenses>
- CC FAQ, AI/training: <https://creativecommons.org/faq/>
- CC BY-NC-SA 4.0 deed: <https://creativecommons.org/licenses/by-nc-sa/4.0/>

### Аудит зависимостей

- `cargo-deny`: <https://github.com/EmbarkStudios/cargo-deny>
- `Cargo.lock` приложения: `experiments/tauri-app/src-tauri/Cargo.lock`
- `Cargo.lock` ядра: `experiments/tauri-app/core/Cargo.lock`
- Полный инвентарь: [`docs/STYLE_ENGINE_CARGO_LICENSES.tsv`](STYLE_ENGINE_CARGO_LICENSES.tsv)

## Статус

**`CONDITIONAL`** — не `CLEARED`.

Модель может быть включена только после выполнения условий раздела 7.
Если будет установлено, что веса являются Adapted Material CC BY-SA 4.0 и
правообладатель не даёт совместимого разрешения, статус должен быть
**`BLOCKED`**.
