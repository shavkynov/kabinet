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
| Удаление: ошибки чтения/удаления не глушатся | — | `after_local_delete`, `remove_local` (№ 2) | `delete_keeps_cloud_file_*`, `delete_reports_cloud_remove_error`, `local_delete_failure_is_reported_not_hidden`, `local_delete_preserves_changed_cloud_version_*` | тест |
| Неполный список облака не удаляет локальное | — | прямое чтение перед удалением (№ 5) | `incomplete_listing_does_not_delete_local_chapter` | тест |
| Пагинация списка и отказ от пустой страницы | — | `yandexdisk::do_list` (№ 5) | `remote_list_paginates_without_losing_files`, `empty_intermediate_page_is_rejected` | тест |
| Ссылки/junction не обходятся | — | `walk_local` (№ 6) | `walk_local_does_not_enter_linked_folder` | тест |
| Гонка создания нового файла | — | `write_checked` create-only (№ 1) | `push_new_file_does_not_overwrite_concurrent_creation` | тест |
| Create-only примитив | — | `Remote::create` (`overwrite=false`) | `create_only_does_not_overwrite_existing` | тест |
| Замок синхронизации (серверное время) | нет | `genlock` (№ 1, примитив) | `lock_is_exclusive_*`, `expired_lock_is_taken_over` | тест (в движок не подключён) |
| Остановка обмена без сетевого прохода | — | `davlink::stop` (№ 13) | `stop_does_not_force_network_pass_*` | тест |
| Связь проекта (attach/pull/push) | — | `DavLink` | `attach_*`, `sync_now_pulls_*` | тест |
| Корзина (восстановление карточки) | — | `store::restore_trash` | тест `store` | тест |
| Durability (sync каталога после rename) | — | `write_atomic_bytes` + `sync_parent_dir` (№ 11) | полный набор; авария не воспроизводима | код |
| Редактор и прочий UI | ProseMirror (`renderer/`) | тот же `renderer/` через `bridge` | GUI не запускался | не проверено |
| Импорт/экспорт/вложения | `store`/`export`/`import` | портированы | отдельно не проверялось в этой сессии | не проверено |

## Ограничения доказательств

- GUI Tauri в этой сессии не запускался; «тест» означает юнит-тест ядра, а не сквозную работу интерфейса.
- Реальный Яндекс Диск не использовался — только поддельный Диск, воспроизводящий документированное поведение API.
- macOS проверен только через CI (тесты ядра); Windows-специфичные тесты (junction, блокировка файла) на macOS не выполняются.
- Аварийное выключение / перезапуск не воспроизводились (durability — только «код»).
