//! Защита от затирания чужих правок при записи: «известные» хэши прочитанных файлов и проверка перед записью.
//! Порт src/syncguard.js и части src/fsutil.js (hashText, known, noteRead, writeFileAtomic).
//!
//! Облако может подменить файл, пока он открыт у нас. Перед записью сверяем, не изменился ли файл с тех пор,
//! как мы его читали. Если изменился, чужую версию сохраняем в папку «Конфликты», а потом пишем свою: ничего не теряется.
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

pub const CONFLICT_DIR: &str = "Конфликты";

/// SHA-1 в шестнадцатеричном виде от UTF-8 текста — ровно как crypto.createHash('sha1').update(String(text)) в JS.
pub fn hash_text(text: &str) -> String {
    Sha1::digest(text.as_bytes()).iter().map(|b| format!("{:02x}", b)).collect()
}

/// Ключ реестра — полный путь файла. Слэши приводим к одному виду, чтобы Windows и POSIX не расходились.
fn key(file: &Path) -> String {
    file.to_string_lossy().replace('\\', "/")
}

fn known() -> &'static Mutex<HashMap<String, String>> {
    static K: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    K.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Запоминаем хэш прочитанного текста: с этим значением будет сверяться запись (noteRead в JS).
pub fn note_read(file: &Path, text: &str) {
    if let Ok(mut m) = known().lock() {
        m.insert(key(file), hash_text(text));
    }
}

/// Хэш версии файла, которую программа последней прочитала или записала. None — в этом сеансе файл не читали.
pub fn known_hash(file: &Path) -> Option<String> {
    known().lock().ok().and_then(|m| m.get(&key(file)).cloned())
}

/// Своя запись тоже становится «известной» версией файла (writeFileAtomic в JS обновляет known и wrote).
pub fn note_written(file: &Path, text: &str) {
    note_read(file, text);
}

fn pad(n: u32) -> String {
    format!("{:02}", n)
}

/// Местное время в виде «2026-11-12 12-19-00», как в имени файла из «Конфликтов» у Electron-версии.
pub fn stamp_at(now: &chrono::DateTime<chrono::Local>) -> String {
    use chrono::{Datelike, Timelike};
    format!(
        "{}-{}-{} {}-{}-{}",
        now.year(),
        pad(now.month()),
        pad(now.day()),
        pad(now.hour()),
        pad(now.minute()),
        pad(now.second())
    )
}

// Тестовая точка времени: под `cfg(test)` позволяет зафиксировать «текущую секунду» на потоке теста.
// В обычной сборке её нет, поведение не меняется.
#[cfg(test)]
thread_local! {
    static TEST_NOW: std::cell::Cell<Option<chrono::DateTime<chrono::Local>>> = std::cell::Cell::new(None);
}
#[cfg(test)]
pub(crate) fn set_test_now(t: Option<chrono::DateTime<chrono::Local>>) { TEST_NOW.with(|c| c.set(t)); }

pub(crate) fn now_local() -> chrono::DateTime<chrono::Local> {
    #[cfg(test)]
    if let Some(t) = TEST_NOW.with(|c| c.get()) { return t; }
    chrono::Local::now()
}

pub fn stamp_now() -> String {
    stamp_at(&now_local())
}

/// Название главы или карточки для имени файла: без запретных знаков, не длиннее 60.
pub fn safe_name(s: &str) -> String {
    let replaced: String = s.chars().map(|c| if "\\/:*?\"<>|\n\r\t".contains(c) { '-' } else { c }).collect();
    let cut: String = replaced.trim_start_matches('.').trim().chars().take(60).collect();
    if cut.is_empty() { "без названия".to_string() } else { cut }
}

/// Как path.extname в Node: расширение последнего звена с точкой или пустая строка.
/// Последнее звено отделяем и по «/», и по «\»: путь может прийти из любой системы.
pub fn extname(rel: &str) -> String {
    let base = rel.rsplit(|c| c == '/' || c == '\\').next().unwrap_or("");
    match base.rfind('.') {
        Some(i) if i > 0 => base[i..].to_string(),
        _ => String::new(),
    }
}

/// Имя файла без расширения (path.basename(rel, extname(rel))).
pub fn stem(rel: &str) -> String {
    let base = rel.rsplit('/').next().unwrap_or("");
    let ext = extname(rel);
    base[..base.len() - ext.len()].to_string()
}

// Этот замок защищает только выбор и запись конфликтной копии внутри процесса.
// guard_write может вызываться под sync_save_lock: повторно его здесь не берём.
static CONFLICT_COPY_LOCK: Mutex<()> = Mutex::new(());

fn content_conflict_name(now: &chrono::DateTime<chrono::Local>, label: &str, suffix: &str, ext: &str, bytes: &[u8]) -> String {
    let digest: String = sha2::Sha256::digest(bytes).iter().map(|b| format!("{:02x}", b)).collect();
    let head = format!("{} ", stamp_at(now));
    let tail = format!(" ({}) {}{}", suffix, digest, ext);
    let mut title = String::new();
    for c in safe_name(label).chars() {
        if head.len() + title.len() + c.len_utf8() + tail.len() > 220 { break; }
        title.push(c);
    }
    format!("{}{}{}", head, title, tail)
}

// None — файл отсутствует; Some(true) — та же версия; Some(false) — другая.
// Ошибку чтения не принимаем за отсутствие копии.
fn conflict_copy_state(path: &Path, bytes: &[u8]) -> crate::store::R<Option<bool>> {
    match std::fs::read(path) {
        Ok(saved) => Ok(Some(saved.as_slice() == bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Не удалось проверить существующую копию конфликта: {}", e)),
    }
}

/// Кандидаты имени конфликтной копии: обычное (время + название) и с SHA-256 содержимого.
/// Второе нужно, если под обычным именем уже лежит ДРУГАЯ версия (одна секунда, одно название).
pub(crate) fn conflict_names(now: &chrono::DateTime<chrono::Local>, label: &str, suffix: &str, ext: &str, bytes: &[u8]) -> Vec<String> {
    vec![
        format!("{} {} ({}){}", stamp_at(now), safe_name(label), suffix, ext),
        content_conflict_name(now, label, suffix, ext, bytes),
    ]
}

/// Сохраняет версию в «Конфликты» под первым подходящим именем из кандидатов и возвращает его.
/// Та же версия под этим именем используется повторно, другую не затираем. Если подходящего имени нет,
/// возвращаем ошибку: сохранение останавливается, чтобы не затереть чужую копию.
/// Замок защищает только выбор и запись копии внутри процесса; сети под ним нет.
pub(crate) fn save_conflict_copy(folder: &Path, names: &[String], bytes: &[u8]) -> crate::store::R<String> {
    let _copy_guard = CONFLICT_COPY_LOCK.lock().map_err(|_| "Внутренний замок копий конфликтов недоступен.".to_string())?;
    std::fs::create_dir_all(folder).map_err(|e| format!("Не удалось создать папку «{}»: {}", CONFLICT_DIR, e))?;
    for name in names {
        match conflict_copy_state(&folder.join(name), bytes)? {
            Some(true) => return Ok(name.clone()),
            Some(false) => continue,
            None => {
                // Чужую версию пишем атомарно: прерванная запись не должна оставить в «Конфликтах» обрывок.
                crate::store::write_atomic_bytes(&folder.join(name), bytes)
                    .map_err(|e| format!("Не удалось сохранить чужую версию в «{}»: {}", CONFLICT_DIR, e))?;
                return Ok(name.clone());
            }
        }
    }
    Err("Копия в «Конфликты» уже существует и была изменена. Сохранение остановлено, чтобы не затереть её.".into())
}

/// Вызывать перед записью файла. Возвращает имя сохранённой чужой версии или None, если конфликта нет.
/// label: название главы или карточки для имени файла. Порт guardWrite из JS.
pub fn guard_write(dir: &Path, file: &Path, new_text: &str, label: &str) -> crate::store::R<Option<String>> {
    guard_write_at(dir, file, new_text, label, now_local())
}

/// guardWrite с явным временем (в JS `now = new Date()`): нужно для воспроизводимых имён в тестах.
pub fn guard_write_at(
    dir: &Path,
    file: &Path,
    new_text: &str,
    label: &str,
    now: chrono::DateTime<chrono::Local>,
) -> crate::store::R<Option<String>> {
    guard_write_at_with_read(dir, file, new_text, label, now, |path| std::fs::read(path))
}

// Подмена только чтения позволяет воспроизвести PermissionDenied независимо от прав процесса.
// В рабочем приложении guard_write_at всегда передаёт std::fs::read.
fn guard_write_at_with_read(
    dir: &Path,
    file: &Path,
    new_text: &str,
    label: &str,
    now: chrono::DateTime<chrono::Local>,
    read: impl FnOnce(&Path) -> std::io::Result<Vec<u8>>,
) -> crate::store::R<Option<String>> {
    let bytes = match read(file) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Не удалось прочитать файл «{}» перед сохранением: {}. Запись остановлена, чтобы не затереть исходное содержимое.", file.display(), e)),
    };
    // Даже без известного хэша ошибка чтения запрещает запись; читаемый непрочитанный файл сохраняет прежнее поведение.
    let Some(k) = known_hash(file) else { return Ok(None) };
    // fs.readFileSync(file, 'utf8') в JS не падает на битых байтах, а заменяет их на U+FFFD: повторяем,
    // иначе испорченный файл молча перезаписался бы без копии в «Конфликты».
    let disk = String::from_utf8_lossy(&bytes).into_owned();
    let h = hash_text(&disk);
    if h == k || h == hash_text(new_text) {
        return Ok(None);
    }
    let ext = extname(&file.to_string_lossy());
    let names = conflict_names(&now, label, "с другого устройства", &ext, disk.as_bytes());
    Ok(Some(save_conflict_copy(&dir.join(CONFLICT_DIR), &names, disk.as_bytes())?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(safe_name("a/b:c"), "a-b-c");
        assert_eq!(safe_name("..скрытое"), "скрытое");
        assert_eq!(safe_name("   "), "без названия");
        assert_eq!(safe_name(&"я".repeat(100)).chars().count(), 60);
        assert_eq!(extname("Главы/abc123.md"), ".md");
        assert_eq!(extname("Главы\\abc123.md"), ".md");
        assert_eq!(extname("project.json"), ".json");
        assert_eq!(extname("noext"), "");
        assert_eq!(extname(".hidden"), "");
        assert_eq!(stem("Главы/abc123.md"), "abc123");
        assert_eq!(stem("project.json"), "project");
    }

    #[test]
    fn stamp_shape() {
        let s = stamp_now();
        assert_eq!(s.len(), 19);
        assert_eq!(&s[10..11], " ");
    }

    #[test]
    fn sha1_like_node() {
        assert_eq!(hash_text("abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(hash_text(""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(hash_text("Привет"), "2805ae8e7e12f182135f92fb90843bb1080d3be8"); // сверено с node crypto.createHash('sha1')
    }
}


#[cfg(test)]
mod conflict_collision_tests {
    use super::*;
    use chrono::{Local, TimeZone};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::{Arc, Barrier};

    struct Project(PathBuf);
    impl Project {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("kabinet-copy-collision-{}-{:016x}", std::process::id(), rand::random::<u64>()));
            fs::create_dir(&dir).unwrap();
            Self(dir)
        }
        fn file(&self, name: &str, text: &str) -> PathBuf {
            let file = self.0.join(name);
            note_read(&file, "base");
            fs::write(&file, text).unwrap();
            file
        }
        fn save(&self, file: &Path) -> String {
            guard_write_at(&self.0, file, "mine", "Same title", at()).unwrap().unwrap()
        }
        fn path(&self, name: &str) -> PathBuf { self.0.join(CONFLICT_DIR).join(name) }
        fn saved(&self, name: &str) -> String { fs::read_to_string(self.path(name)).unwrap() }
    }
    impl Drop for Project { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    fn at() -> chrono::DateTime<Local> { Local.with_ymd_and_hms(2026, 11, 14, 12, 0, 0).single().unwrap() }

    #[test]
    fn same_second_keeps_both_foreign_versions() {
        let p = Project::new();
        let file = p.file("aaaaaa.md", "foreign one");
        let first = p.save(&file);
        assert_eq!(first, "2026-11-14 12-00-00 Same title (с другого устройства).md");
        fs::write(&file, "foreign two").unwrap();
        let second = p.save(&file);
        assert_ne!(first, second);
        assert_eq!(p.saved(&first), "foreign one");
        assert_eq!(p.saved(&second), "foreign two");
        assert_eq!(fs::read_to_string(file).unwrap(), "foreign two");
    }

    #[test]
    fn same_title_keeps_both_documents() {
        let p = Project::new();
        let one = p.file("aaaaaa.md", "first document");
        let two = p.file("bbbbbb.md", "second document");
        let first = p.save(&one);
        let second = p.save(&two);
        assert_ne!(first, second);
        assert_eq!(p.saved(&first), "first document");
        assert_eq!(p.saved(&second), "second document");
    }

    #[test]
    fn identical_copy_is_reused_without_rewriting() {
        let p = Project::new();
        let file = p.file("aaaaaa.md", "foreign");
        let first = p.save(&file);
        let stamp = fs::metadata(p.path(&first)).unwrap().modified().unwrap();
        let second = p.save(&file);
        assert_eq!(first, second);
        assert_eq!(fs::metadata(p.path(&first)).unwrap().modified().unwrap(), stamp);
        assert_eq!(fs::read_dir(p.0.join(CONFLICT_DIR)).unwrap().count(), 1);
    }

    #[test]
    fn edited_hashed_copy_stops_preservation_instead_of_overwriting() {
        let p = Project::new();
        let file = p.file("aaaaaa.md", "foreign one");
        let first = p.save(&file);
        fs::write(&file, "foreign two").unwrap();
        let second = p.save(&file);
        fs::write(p.path(&second), "manually edited copy").unwrap();
        assert!(guard_write_at(&p.0, &file, "mine", "Same title", at()).is_err());
        assert_eq!(p.saved(&first), "foreign one");
        assert_eq!(p.saved(&second), "manually edited copy");
        assert_eq!(fs::read_to_string(file).unwrap(), "foreign two");
    }

    #[test]
    fn parallel_calls_keep_every_version() {
        let p = Project::new();
        let gate = Arc::new(Barrier::new(8));
        let mut workers = Vec::new();
        for i in 0..8 {
            let text = format!("foreign version {}", i);
            let file = p.file(&format!("doc{}.md", i), &text);
            let root = p.0.clone();
            let gate = gate.clone();
            workers.push(std::thread::spawn(move || {
                gate.wait();
                let name = guard_write_at(&root, &file, "mine", "Same title", at()).unwrap().unwrap();
                (name, text)
            }));
        }
        let copies: Vec<_> = workers.into_iter().map(|t| t.join().unwrap()).collect();
        let names: std::collections::HashSet<_> = copies.iter().map(|(n, _)| n).collect();
        assert_eq!(names.len(), 8);
        for (name, text) in &copies { assert_eq!(&p.saved(name), text); }
        assert_eq!(fs::read_dir(p.0.join(CONFLICT_DIR)).unwrap().count(), 8);
    }

    #[test]
    fn hashed_name_keeps_extension_and_unicode_boundaries() {
        let name = content_conflict_name(&at(), &"漢".repeat(60), "с другого устройства", ".json", b"foreign");
        assert!(name.len() <= 220);
        assert!(name.ends_with(".json"));
        assert!(!name.contains('\u{fffd}'));
    }

    #[test]
    fn copy_directory_error_does_not_modify_the_source() {
        let p = Project::new();
        let file = p.file("aaaaaa.md", "foreign");
        fs::write(p.0.join(CONFLICT_DIR), "not a directory").unwrap();
        assert!(guard_write_at(&p.0, &file, "mine", "Same title", at()).is_err());
        assert_eq!(fs::read_to_string(file).unwrap(), "foreign");
    }

    #[test]
    fn read_errors_stop_guard_with_and_without_known_hash() {
        use std::io::{Error, ErrorKind};
        for kind in [ErrorKind::PermissionDenied, ErrorKind::Other] {
            for tracked in [false, true] {
                let p = Project::new();
                let file = p.0.join("read-error.md");
                fs::write(&file, "foreign bytes").unwrap();
                if tracked { note_read(&file, "base"); }
                let before_known = known_hash(&file);
                let result = guard_write_at_with_read(&p.0, &file, "mine", "Read error", at(), |path| {
                    assert_eq!(path, file.as_path());
                    Err(Error::new(kind, "injected read failure"))
                });
                let error = result.expect_err("ошибка чтения не должна разрешать запись");
                assert!(error.contains("injected read failure"));
                assert!(error.contains(&file.display().to_string()));
                assert_eq!(fs::read(&file).unwrap(), b"foreign bytes");
                assert_eq!(known_hash(&file), before_known);
                assert!(!p.0.join(CONFLICT_DIR).exists());
            }
        }
    }

    #[test]
    fn actual_directory_read_error_is_not_missing_file() {
        let p = Project::new();
        let file = p.0.join("directory.md");
        fs::create_dir(&file).unwrap();
        note_read(&file, "base");
        let read_error = fs::read(&file).expect_err("чтение каталога должно завершиться ошибкой");
        assert_ne!(read_error.kind(), std::io::ErrorKind::NotFound);
        assert!(guard_write_at(&p.0, &file, "mine", "Directory", at()).is_err());
        assert!(file.is_dir());
        assert!(!p.0.join(CONFLICT_DIR).exists());
    }

    #[test]
    fn missing_file_still_allows_save_with_and_without_known_hash() {
        let p = Project::new();
        for tracked in [false, true] {
            let file = p.0.join(if tracked { "tracked.md" } else { "untracked.md" });
            if tracked { note_read(&file, "base"); }
            assert!(guard_write_at(&p.0, &file, "mine", "Missing", at()).unwrap().is_none());
            assert!(!file.exists());
        }
        assert!(!p.0.join(CONFLICT_DIR).exists());
    }

    #[test]
    fn readable_untracked_file_keeps_previous_no_conflict_behavior() {
        let p = Project::new();
        let file = p.0.join("untracked.md");
        fs::write(&file, "foreign bytes").unwrap();
        assert!(known_hash(&file).is_none());
        assert!(guard_write_at(&p.0, &file, "mine", "Unread", at()).unwrap().is_none());
        assert_eq!(fs::read(&file).unwrap(), b"foreign bytes");
        assert!(!p.0.join(CONFLICT_DIR).exists());
    }
}
