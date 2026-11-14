//! Защита от затирания чужих правок при записи (порт src/syncguard.js и «известных» хэшей).
//! Сценарии повторяют test/sync.test.js Electron-версии.
use kabinet_core::{export, mentions, searchreplace, store, syncguard};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

fn unique_dir(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!("kabinet-guard-{}-{}-{:016x}", tag, std::process::id(), rand::random::<u64>()))
}

struct Project {
    dir: PathBuf,
    id: String,
}

impl Project {
    fn new(tag: &str) -> Self {
        let dir = unique_dir(tag);
        let view = store::create_project(&dir, "Проверка защиты", None).unwrap();
        let id = view["chapters"][0]["id"].as_str().unwrap().to_string();
        Project { dir, id }
    }

    /// Проект, собранный в обход store: ни один файл ещё не прочитан и не записан этой программой.
    fn unread(tag: &str) -> Self {
        let dir = unique_dir(tag);
        let id = "aabbccdd".to_string();
        fs::create_dir_all(dir.join("Главы")).unwrap();
        let meta = json!({ "app": "kabinet", "version": 1, "name": "Без чтения", "chapters": [{ "id": id, "title": "Глава 1" }] });
        fs::write(dir.join("project.json"), serde_json::to_string(&meta).unwrap()).unwrap();
        fs::write(dir.join("Главы").join(format!("{}.md", id)), "чужой текст, который не читали").unwrap();
        Project { dir, id }
    }

    fn chapter_file(&self) -> PathBuf {
        self.dir.join("Главы").join(format!("{}.md", self.id))
    }

    fn conflicts_dir(&self) -> PathBuf {
        self.dir.join("Конфликты")
    }

    fn conflict_name(res: &Value) -> Option<String> {
        res["conflict"].as_str().map(String::from)
    }
}

impl Drop for Project {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// Массовое чтение не должно обновлять «известный» хэш открытой главы: чужую правку надо заметить.
fn chapter_guard_survives_bulk(tag: &str, bulk: &dyn Fn(&Project)) {
    let p = Project::new(tag);
    store::write_chapter(&p.dir, &p.id, "исходный текст").unwrap();
    store::read_chapter(&p.dir, &p.id).unwrap(); // окно открыло главу
    fs::write(p.chapter_file(), "правка с другого устройства").unwrap(); // облако подменило файл
    bulk(&p); // что-то прочитало все главы
    let res = store::write_chapter(&p.dir, &p.id, "моя правка").unwrap(); // автосохранение окна
    let name = Project::conflict_name(&res).unwrap_or_else(|| panic!("{tag}: конфликт должен быть замечен"));
    assert_eq!(fs::read_to_string(p.conflicts_dir().join(name)).unwrap(), "правка с другого устройства", "{tag}");
    assert_eq!(fs::read_to_string(p.chapter_file()).unwrap(), "моя правка", "{tag}");
}

#[test]
fn external_edit_is_kept_in_conflicts_and_my_version_is_written() {
    let p = Project::new("external");
    store::write_chapter(&p.dir, &p.id, "моя версия 1").unwrap();
    assert_eq!(store::read_chapter(&p.dir, &p.id).unwrap(), "моя версия 1");
    // облако принесло другую версию, пока глава была открыта
    fs::write(p.chapter_file(), "версия с другого устройства").unwrap();
    let res = store::write_chapter(&p.dir, &p.id, "моя версия 2").unwrap();
    let name = Project::conflict_name(&res).expect("конфликт обнаружен");
    assert_eq!(fs::read_to_string(p.conflicts_dir().join(&name)).unwrap(), "версия с другого устройства");
    assert_eq!(fs::read_to_string(p.chapter_file()).unwrap(), "моя версия 2");
    // дальше всё как обычно
    assert!(store::write_chapter(&p.dir, &p.id, "моя версия 3").unwrap()["conflict"].is_null());
}

#[test]
fn own_writes_and_identical_text_are_not_conflicts() {
    let p = Project::new("own");
    store::read_chapter(&p.dir, &p.id).unwrap();
    assert!(store::write_chapter(&p.dir, &p.id, "a").unwrap()["conflict"].is_null());
    assert!(store::write_chapter(&p.dir, &p.id, "b").unwrap()["conflict"].is_null());
    fs::write(p.chapter_file(), "c").unwrap();
    assert!(store::write_chapter(&p.dir, &p.id, "c").unwrap()["conflict"].is_null()); // на диске уже то же самое
    assert!(!p.conflicts_dir().exists(), "папка «Конфликты» не должна создаваться без конфликта");
}

#[test]
fn card_external_edit_is_a_conflict_with_json_extension() {
    let p = Project::new("card");
    let cid = store::add_item(&p.dir, "character", None).unwrap()["id"].as_str().unwrap().to_string();
    store::read_item(&p.dir, "character", &cid).unwrap();
    let file = p.dir.join("Персонажи").join(format!("{}.json", cid));
    fs::write(&file, r#"{"short":"чужое"}"#).unwrap();
    let res = store::write_item(&p.dir, "character", &cid, r#"{"short":"моё"}"#).unwrap();
    let name = Project::conflict_name(&res).expect("конфликт обнаружен");
    assert!(name.ends_with(".json"), "чужую версию карточки сохраняем с тем же расширением: {name}");
    assert!(fs::read_to_string(p.conflicts_dir().join(&name)).unwrap().contains("чужое"));
    assert_eq!(serde_json::from_str::<Value>(&fs::read_to_string(&file).unwrap()).unwrap()["short"], "моё");
}

#[test]
fn bulk_reads_do_not_reset_the_known_hash() {
    chapter_guard_survives_bulk("stats", &|p| { store::project_stats(&p.dir).unwrap(); });
    chapter_guard_survives_bulk("board", &|p| { store::board_data(&p.dir).unwrap(); });
    chapter_guard_survives_bulk("search", &|p| { searchreplace::search_project(&p.dir, "текст").unwrap(); });
    chapter_guard_survives_bulk("replace", &|p| { searchreplace::replace_project(&p.dir, "текст", "правка", true).unwrap(); });
    chapter_guard_survives_bulk("export", &|p| { export::build_export(&p.dir, "md", "ru", false, true).unwrap(); });
    chapter_guard_survives_bulk("mentions", &|p| {
        let cid = store::add_item(&p.dir, "character", None).unwrap()["id"].as_str().unwrap().to_string();
        store::rename_item(&p.dir, "character", &cid, "Иван").unwrap();
        mentions::card_mentions(&p.dir, "character", &cid).unwrap();
    });
}

#[test]
fn card_index_keeps_the_guard_of_an_open_card() {
    let p = Project::new("cardindex");
    let cid = store::add_item(&p.dir, "character", None).unwrap()["id"].as_str().unwrap().to_string();
    let file = p.dir.join("Персонажи").join(format!("{}.json", cid));
    let card = |short: &str| format!(r#"{{"short":"{short}","aliases":[],"ignore":[],"image":"","fields":[],"protagonist":false}}"#);
    store::write_item(&p.dir, "character", &cid, &card("моя 1")).unwrap();
    store::read_item(&p.dir, "character", &cid).unwrap(); // карточка открыта
    fs::write(&file, card("чужая")).unwrap();
    store::card_index(&p.dir).unwrap(); // индекс для автоссылок читает все карточки
    let res = store::write_item(&p.dir, "character", &cid, &card("моя 2")).unwrap();
    assert!(Project::conflict_name(&res).is_some(), "конфликт должен быть замечен");
}

#[test]
fn reading_again_after_an_external_edit_means_no_conflict() {
    let p = Project::new("reread");
    let file = p.chapter_file();
    fs::write(&file, "версия A").unwrap();
    store::read_chapter(&p.dir, &p.id).unwrap();
    // автор открыл главу после внешней правки: своя версия, конфликта нет
    fs::write(&file, "версия B").unwrap();
    store::read_chapter(&p.dir, &p.id).unwrap();
    assert!(store::write_chapter(&p.dir, &p.id, "версия C").unwrap()["conflict"].is_null());
}

#[test]
fn unread_or_deleted_file_is_written_without_conflict() {
    // файл в этом сеансе не читали: сравнивать не с чем
    let p = Project::unread("unread");
    let res = store::write_chapter(&p.dir, &p.id, "моя версия").unwrap();
    assert!(res["conflict"].is_null(), "непрочитанный файл не может дать конфликт");
    assert!(!p.conflicts_dir().exists());
    assert_eq!(fs::read_to_string(p.chapter_file()).unwrap(), "моя версия");

    // файл удалили на другом устройстве: просто пишем свой
    let p = Project::new("deleted");
    store::read_chapter(&p.dir, &p.id).unwrap();
    fs::remove_file(p.chapter_file()).unwrap();
    let res = store::write_chapter(&p.dir, &p.id, "мой текст").unwrap();
    assert!(res["conflict"].is_null(), "удалённый файл не может дать конфликт");
    assert!(!p.conflicts_dir().exists());
    assert_eq!(fs::read_to_string(p.chapter_file()).unwrap(), "мой текст");
}

#[test]
fn conflict_name_is_deterministic_and_sha1_matches_js() {
    use chrono::{Local, TimeZone};
    // crypto.createHash('sha1').update('abc').digest('hex') в Node
    assert_eq!(syncguard::hash_text("abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");

    let p = Project::new("stamp");
    let file = p.chapter_file();
    syncguard::note_read(&file, "версия 1");
    fs::write(&file, "версия 2").unwrap();
    let now = Local.with_ymd_and_hms(2026, 11, 12, 12, 19, 0).single().expect("местное время существует");
    // запретные знаки (: / ?) заменяются на «-»; длинное название обрезается до 60 знаков
    let label = "Глава 1: «Первый/второй»?";
    let name = syncguard::guard_write_at(&p.dir, &file, "версия 3", label, now).unwrap().expect("конфликт обнаружен");
    assert_eq!(name, "2026-11-12 12-19-00 Глава 1- «Первый-второй»- (с другого устройства).md");
    assert_eq!(fs::read_to_string(p.conflicts_dir().join(&name)).unwrap(), "версия 2");

    syncguard::note_read(&file, "версия 4");
    fs::write(&file, "версия 5").unwrap();
    let long = "я".repeat(100);
    let name = syncguard::guard_write_at(&p.dir, &file, "версия 6", &long, now).unwrap().expect("конфликт обнаружен");
    assert_eq!(name, format!("2026-11-12 12-19-00 {} (с другого устройства).md", "я".repeat(60)));
    assert_eq!(syncguard::safe_name(&long), "я".repeat(60));
}

#[test]
fn invalid_utf8_on_disk_is_kept_in_conflicts_like_js() {
    let p = Project::new("badutf8");
    // главу читали, пока файл был целым; облако испортило байты
    syncguard::note_read(&p.chapter_file(), "версия до порчи");
    fs::write(p.chapter_file(), [0xff, 0xfe, b'X']).unwrap();
    let res = store::write_chapter(&p.dir, &p.id, "моя версия").unwrap();
    let name = Project::conflict_name(&res).expect("испорченный файл не затираем молча");
    let saved = fs::read_to_string(p.conflicts_dir().join(&name)).unwrap();
    // fs.readFileSync(file, 'utf8') в JS декодирует с заменами U+FFFD; повторяем это поведение
    assert!(saved.contains('\u{fffd}'), "чужая версия сохранена с заменами, как в JS: {saved:?}");
    assert_eq!(fs::read_to_string(p.chapter_file()).unwrap(), "моя версия");
}

#[test]
fn caller_save_stops_and_keeps_known_hash_when_guard_cannot_read_the_file() {
    // Контракт вызывающего пути: ошибка чтения в защите доходит до write_chapter/write_item —
    // файл не перезаписывается, успех не сообщается, «известный» хэш не обновляется.
    // Ошибка воспроизводится подменой файла каталогом: это детерминированный тест контракта,
    // а не эквивалент всех ошибок доступа (см. карточку № 3 в ТЗ).
    let p = Project::new("caller_read_error");

    // глава: окно открыло файл (known_hash записан), затем на его месте оказывается каталог
    store::write_chapter(&p.dir, &p.id, "исходный текст").unwrap();
    store::read_chapter(&p.dir, &p.id).unwrap();
    let file = p.chapter_file();
    fs::remove_file(&file).unwrap();
    fs::create_dir(&file).unwrap();
    let known_before = syncguard::known_hash(&file);
    let res = store::write_chapter(&p.dir, &p.id, "моя правка");
    assert!(res.is_err(), "write_chapter должен вернуть ошибку защиты, а не успех");
    assert!(file.is_dir(), "файл не перезаписан: на его месте по-прежнему каталог");
    assert_eq!(syncguard::known_hash(&file), known_before, "known_hash не обновлён после ошибки");

    // карточка: тот же контракт
    let cid = store::add_item(&p.dir, "character", None).unwrap()["id"].as_str().unwrap().to_string();
    store::write_item(&p.dir, "character", &cid, r#"{"short":"моя 1"}"#).unwrap();
    store::read_item(&p.dir, "character", &cid).unwrap();
    let card = p.dir.join("Персонажи").join(format!("{}.json", cid));
    fs::remove_file(&card).unwrap();
    fs::create_dir(&card).unwrap();
    let known_card = syncguard::known_hash(&card);
    let res = store::write_item(&p.dir, "character", &cid, r#"{"short":"моя 2"}"#);
    assert!(res.is_err(), "write_item должен вернуть ошибку защиты, а не успех");
    assert!(card.is_dir(), "файл карточки не перезаписан");
    assert_eq!(syncguard::known_hash(&card), known_card, "known_hash карточки не обновлён");
}

#[cfg(windows)]
#[test]
fn caller_save_stops_on_unreadable_existing_file_and_keeps_its_bytes() {
    // Ошибка чтения СУЩЕСТВУЮЩЕГО файла (не NotFound) без chmod: файл открыт с запретом
    // совместного доступа. Запись должна остановиться, прежние байты — сохраниться.
    use std::os::windows::fs::OpenOptionsExt;
    let p = Project::new("caller_locked_read");
    store::write_chapter(&p.dir, &p.id, "исходный текст").unwrap();
    store::read_chapter(&p.dir, &p.id).unwrap();
    let file = p.chapter_file();
    let known_before = syncguard::known_hash(&file);
    let lock = fs::OpenOptions::new().read(true).share_mode(0).open(&file).expect("открыть файл с запретом совместного доступа");
    let res = store::write_chapter(&p.dir, &p.id, "моя правка");
    drop(lock);
    let err = res.expect_err("write_chapter должен вернуть ошибку чтения, а не успех");
    assert!(err.contains("Запись остановлена"), "ошибка защиты доходит до вызывающего: {}", err);
    assert_eq!(fs::read_to_string(&file).unwrap(), "исходный текст", "файл не перезаписан, байты прежние");
    assert_eq!(syncguard::known_hash(&file), known_before, "known_hash не обновлён после ошибки");
    assert!(!p.dir.join("Конфликты").exists(), "конфликтная копия не создавалась");
}
