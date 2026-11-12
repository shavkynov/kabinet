//! Мелочи для конфликтов: имя папки «Конфликты», штамп времени, безопасное имя файла.
//! Порт src/syncguard.js (часть, нужная синхронизации).

pub const CONFLICT_DIR: &str = "Конфликты";

/// Местное время в виде «2026-11-12 12-19-00», как в имени файла из «Конфликтов» у Electron-версии.
pub fn stamp_now() -> String {
    chrono::Local::now().format("%Y-%m-%d %H-%M-%S").to_string()
}

/// Название главы или карточки для имени файла: без запретных знаков, не длиннее 60.
pub fn safe_name(s: &str) -> String {
    let replaced: String = s.chars().map(|c| if "\\/:*?\"<>|\n\r\t".contains(c) { '-' } else { c }).collect();
    let cut: String = replaced.trim_start_matches('.').trim().chars().take(60).collect();
    if cut.is_empty() { "без названия".to_string() } else { cut }
}

/// Как path.extname в Node: расширение последнего звена с точкой или пустая строка.
pub fn extname(rel: &str) -> String {
    let base = rel.rsplit('/').next().unwrap_or("");
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
}
