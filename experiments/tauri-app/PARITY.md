# Паритет Electron ↔ Tauri: таблица доказательств (начало)

Дополнение к каноническому ТЗ `docs/tauri-release-tasks.md` (задача № 12). Это не отдельный реестр задач:
статусы и решения — только в ТЗ. Здесь собраны фактические доказательства по областям, проверенным в этой сессии.

Статусы: **тест** — покрыто автоматическим тестом; **код** — проверено чтением кода, автоматического теста нет;
**нет** — функции нет; **не проверено** — в этой сессии не проверялось.

| Область | Electron (`src/`) | Tauri (`core/`) | Доказательство | Статус |
|---|---|---|---|---|
| Сохранение главы (атомарно) | `folder.js`/`writeFileAtomic` | `store::write_atomic` + `syncguard` | `tests/syncguard_guard.rs`, тесты `store` | тест |
| Ошибка чтения ≠ «пусто» | — | `syncguard::guard_write_at_with_read` (№ 3) | `caller_save_stops_and_keeps_known_hash_*` | тест |
| Пустота глав при переносе структуры | — | `foldersync::read_local_opt` (№ 4) | `unreadable_chapter_is_not_treated_as_empty_in_adopt` | тест |
| Статистика без затирания оригинала | — | `stats::read_days_strict` + `sync_save_lock` (№ 9) | `set_day_words_*` (3 теста) | тест |
| Резервные копии | `backup.js` | `backup::make_backup` (№ 7) | `backup_detects_binary_change_*`, `backup_does_not_follow_directory_junctions` | тест |
| Проверка целостности копии | нет | `backup::verify_backup` (№ 7) | `backup_verification_detects_corruption_and_missing_signature` | тест |
| Восстановление из копии (файлы) | нет | `backup::restore_backup` (№ 8, MVP) | `restore_verified_backup_keeps_newer_files` | тест |
| Восстановление: координация с sync и меню | нет | `backup:restore`, `restore_interactive` (№ 8) | оболочка собирается (`cargo check --locked`); GUI не запускался | код |
| Синхронизация с общей папкой | `folder.js` | `foldersync::FolderSync` | `foldersync`-тесты (34) | тест |
| Удаление: ошибки чтения/удаления не глушатся | — | `after_local_delete`, `remove_local` (№ 2) | `delete_keeps_cloud_file_*`, `delete_reports_cloud_remove_error`, `local_delete_failure_is_reported_not_hidden`, `local_delete_preserves_changed_cloud_version_*`, `async_cloud_delete_is_confirmed_by_operation` | тест |
| Неполный список облака не удаляет локальное | — | прямое чтение перед удалением (№ 5) | `incomplete_listing_does_not_delete_local_chapter` | тест |
| Пагинация списка и отказ от пустой страницы | — | `yandexdisk::do_list` (№ 5) | `remote_list_paginates_without_losing_files`, `empty_intermediate_page_is_rejected` | тест |
| Ссылки/junction не обходятся | — | `walk_local` (№ 6) | `walk_local_does_not_enter_linked_folder` | тест |
| Гонка создания нового файла | — | `write_checked` create-only (№ 1) | `push_new_file_does_not_overwrite_concurrent_creation` | тест |
| Create-only примитив | — | `Remote::create` (`overwrite=false`) | `create_only_does_not_overwrite_existing` | тест |
| Отметка «проект открыт на другом устройстве» | `cloud.js` (`kabinet.lock`, `{device,time}`) | Rust не пишет и не блокирует её; проход не зависит от чужой отметки | `phone_lock_does_not_block_pass_and_is_not_touched` | тест |
| Остановка обмена без сетевого прохода | — | `davlink::stop` (№ 13) | `stop_does_not_force_network_pass_*` | тест |
| Связь проекта (attach/pull/push) | — | `DavLink` | `attach_*`, `sync_now_pulls_*` | тест |
| Корзина (восстановление карточки) | — | `store::restore_trash` | тест `store` | тест |
| Durability (sync каталога после rename) | — | `write_atomic_bytes` + `sync_parent_dir` (№ 11) | полный набор; авария не воспроизводима | код |
| Карточки (персонажи, места, предметы, заметки) | `store` (items) | `store::add_item/read_item/…` | unit-тесты модуля `store` | тест |
| Поиск и замена | `searchreplace` | `searchreplace::replace_project` | unit-тесты модуля | тест |
| Импорт глав (docx/rtf/md/txt) | `import` | `import` | unit-тесты модуля | тест |
| Экспорт (docx/pdf/…, цели сохранения) | `export` | `export`/`exporttarget` | unit-тесты модулей | тест |
| Вложения/изображения | — | `media` | unit-тесты модуля | тест |
| Упоминания и ссылки | — | `mentions` | unit-тесты модуля | тест |
| Анализ текста (проверка) | — | `check` | unit-тесты модуля | тест |
| Склонения/созвучия/словарь | — | `declension`/`namematch`/`dict` | unit-тесты модулей | тест |
| Редактор, форматирование, история (undo/redo) | ProseMirror (`renderer/`) | тот же `renderer/` через `bridge` | GUI Tauri не запускался | не проверено |
| Настройки/шрифты/звуки/эмбиент | `renderer/` | тот же `renderer/` | GUI Tauri не запускался | не проверено |

## Ограничения доказательств

- GUI Tauri в этой сессии не запускался; «тест» означает юнит-тест ядра, а не сквозную работу интерфейса.
- Для модульных областей (карточки, поиск, импорт, экспорт, вложения, упоминания, анализ, язык) «тест» = у модуля есть unit-тесты; их полный просмотр в этой сессии не выполнялся.
- Реальный Яндекс Диск не использовался — только поддельный Диск, воспроизводящий документированное поведение API.
- macOS проверен только через CI (тесты ядра); Windows-специфичные тесты (junction, блокировка файла) на macOS не выполняются.
- Аварийное выключение / перезапуск не воспроизводились (durability — только «код»).
