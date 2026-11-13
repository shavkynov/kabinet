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

pub fn stamp_now() -> String {
    stamp_at(&chrono::Local::now())
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

/// Вызывать перед записью файла. Возвращает имя сохранённой чужой версии или None, если конфликта нет.
/// label: название главы или карточки для имени файла. Порт guardWrite из JS.
pub fn guard_write(dir: &Path, file: &Path, new_text: &str, label: &str) -> crate::store::R<Option<String>> {
    guard_write_at(dir, file, new_text, label, chrono::Local::now())
}

/// guardWrite с явным временем (в JS `now = new Date()`): нужно для воспроизводимых имён в тестах.
pub fn guard_write_at(
    dir: &Path,
    file: &Path,
    new_text: &str,
    label: &str,
    now: chrono::DateTime<chrono::Local>,
) -> crate::store::R<Option<String>> {
    let Some(k) = known_hash(file) else { return Ok(None) }; // файл в этом сеансе не читали: сравнивать не с чем
    let Ok(bytes) = std::fs::read(file) else { return Ok(None) }; // файла нет (удалён на другом устройстве): просто запишем свой
    // fs.readFileSync(file, 'utf8') в JS не падает на битых байтах, а заменяет их на U+FFFD: повторяем,
    // иначе испорченный файл молча перезаписался бы без копии в «Конфликты».
    let disk = String::from_utf8_lossy(&bytes).into_owned();
    let h = hash_text(&disk);
    if h == k || h == hash_text(new_text) {
        return Ok(None);
    }
    let folder = dir.join(CONFLICT_DIR);
    std::fs::create_dir_all(&folder).map_err(|e| format!("Не удалось создать папку «{}»: {}", CONFLICT_DIR, e))?;
    let name = format!("{} {} (с другого устройства){}", stamp_at(&now), safe_name(label), extname(&file.to_string_lossy()));
    // Чужую версию пишем атомарно: прерванная запись не должна оставить в «Конфликтах» обрывок.
    crate::store::write_atomic(&folder.join(&name), &disk)
        .map_err(|e| format!("Не удалось сохранить чужую версию в «{}»: {}", CONFLICT_DIR, e))?;
    Ok(Some(name))
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
