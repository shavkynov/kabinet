//! Журнал приложения: короткий текстовый файл для разбора ошибок.
//! Два файла по 150 КБ (текущий и предыдущий), старое стирается само. Тексты глав и токены в журнал не попадают:
//! пишутся только события и сообщения об ошибках, а секреты и имя пользователя в пути скрываются.
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Размер одного файла; журнал целиком занимает не больше двух таких.
pub const MAX_FILE: u64 = 150 * 1024;
/// Одна запись не длиннее этого (длинные сообщения обрезаются).
const MAX_ENTRY: usize = 1500;
const FILE: &str = "kabinet.log";
const OLD: &str = "kabinet.old.log";

static DIR: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

fn slot() -> &'static Mutex<Option<PathBuf>> { DIR.get_or_init(|| Mutex::new(None)) }

/// Включает журнал в папке `dir` (создаётся при необходимости).
pub fn init(dir: &Path) {
    let _ = std::fs::create_dir_all(dir);
    if let Ok(mut g) = slot().lock() { *g = Some(dir.to_path_buf()); }
}

pub fn folder() -> Option<PathBuf> { slot().lock().ok().and_then(|g| g.clone()) }

pub fn info(msg: impl AsRef<str>) { write("INFO", msg.as_ref()); }
pub fn warn(msg: impl AsRef<str>) { write("WARN", msg.as_ref()); }
pub fn error(msg: impl AsRef<str>) { write("ERROR", msg.as_ref()); }

pub fn write(level: &str, msg: &str) {
    let Some(dir) = folder() else { return };
    let line = format!("{} [{}] {}\n", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"), clean_level(level), scrub(msg));
    let _ = append(&dir, &line, MAX_FILE);
}

fn clean_level(l: &str) -> &'static str {
    match l.to_ascii_uppercase().as_str() { "ERROR" => "ERROR", "WARN" | "WARNING" => "WARN", _ => "INFO" }
}

/// Дописывает строку; когда файл вырос до `max`, он становится «предыдущим», прежний «предыдущий» стирается.
fn append(dir: &Path, line: &str, max: u64) -> std::io::Result<()> {
    let cur = dir.join(FILE);
    if std::fs::metadata(&cur).map(|m| m.len()).unwrap_or(0) + line.len() as u64 > max {
        let _ = std::fs::remove_file(dir.join(OLD));
        let _ = std::fs::rename(&cur, dir.join(OLD));
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(cur)?;
    f.write_all(line.as_bytes())
}

/// Журнал целиком (сначала предыдущий файл, затем текущий), не больше `limit` последних байт.
pub fn read_tail(limit: usize) -> String {
    let Some(dir) = folder() else { return String::new() };
    read_tail_in(&dir, limit)
}

fn read_tail_in(dir: &Path, limit: usize) -> String {
    let mut bytes = std::fs::read(dir.join(OLD)).unwrap_or_default();
    bytes.extend(std::fs::read(dir.join(FILE)).unwrap_or_default());
    if bytes.len() > limit {
        let mut from = bytes.len() - limit;
        while from < bytes.len() && (bytes[from] & 0xC0) == 0x80 { from += 1; } // не рвать UTF-8
        bytes.drain(..from);
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Скрывает то, чего в журнале быть не должно: токены, коды входа, пароли и имя пользователя в путях.
pub fn scrub(msg: &str) -> String {
    let mut s: String = msg.chars().take(MAX_ENTRY).collect();
    for key in ["OAuth ", "Bearer ", "Basic ", "access_token=", "refresh_token=", "token=", "code=", "client_secret=", "password=", "\"access_token\":\"", "\"refresh_token\":\"", "\"token\":\""] {
        s = mask_after(&s, key);
    }
    for var in ["USERPROFILE", "HOME"] {
        if let Ok(home) = std::env::var(var) {
            if home.len() > 3 { s = s.replace(&home, "~").replace(&home.replace('\\', "/"), "~"); }
        }
    }
    s.replace('\n', "\n    ").trim_end().to_string()
}

/// Всё, что идёт после `key` до пробела, кавычки, `&` или конца строки, заменяется на «***».
fn mask_after(s: &str, key: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find(key) {
        let (head, tail) = rest.split_at(i + key.len());
        out.push_str(head);
        let end = tail.find(|c: char| c.is_whitespace() || c == '"' || c == '&' || c == '\'' || c == ',').unwrap_or(tail.len());
        if end > 0 { out.push_str("***"); }
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::tmpdir;

    #[test]
    fn secrets_are_masked() {
        assert_eq!(scrub("Authorization: OAuth y0_AgAAAAB123 ok"), "Authorization: OAuth *** ok");
        assert_eq!(scrub("https://x/?code=abc123&state=zz"), "https://x/?code=***&state=zz");
        assert_eq!(scrub("{\"access_token\":\"secret\",\"a\":1}"), "{\"access_token\":\"***\",\"a\":1}");
        assert_eq!(scrub("обычная ошибка: файл не найден"), "обычная ошибка: файл не найден");
    }

    #[test]
    fn long_messages_are_cut_and_multiline_is_indented() {
        let long = "я".repeat(5000);
        assert_eq!(scrub(&long).chars().count(), MAX_ENTRY);
        assert_eq!(scrub("первая\nвторая"), "первая\n    вторая");
    }

    #[test]
    fn rotation_keeps_two_files_and_total_size_bounded() {
        let d = tmpdir("applog-rot");
        let line = format!("{}\n", "х".repeat(99)); // 99 букв по 2 байта + перевод строки ≈ 200 байт
        for i in 0..3000 { append(&d, &format!("{} {}", i, line), 20_000).unwrap(); }
        let size = |n: &str| std::fs::metadata(d.join(n)).map(|m| m.len()).unwrap_or(0);
        assert!(size(FILE) <= 20_000 && size(OLD) <= 20_000, "{} {}", size(FILE), size(OLD));
        let all = read_tail_in(&d, 1_000_000);
        assert!(all.contains("2999 "), "последняя запись сохранена");
        assert!(!all.contains("\n0 х"), "самые старые стёрты");
    }

    #[test]
    fn tail_never_splits_a_character() {
        let d = tmpdir("applog-tail");
        append(&d, "ёёёёёёёёёё\n", MAX_FILE).unwrap();
        for limit in 1..20 { let t = read_tail_in(&d, limit); assert!(t.chars().all(|c| c == 'ё' || c == '\n'), "{}", limit); }
    }
}
