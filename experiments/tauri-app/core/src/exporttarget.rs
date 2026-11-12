//! Куда и в каком формате проект экспортировался в прошлый раз. Порт src/export-target.js.
//! PDF в версии на Tauri пока нет (печать окна недоступна), поэтому форматы: DOCX, RTF, Markdown, текст, HTML.
use crate::store::{write_atomic, R};
use sha1::{Digest, Sha1};
use std::path::{Path, PathBuf};

pub const FORMATS: [&str; 5] = ["docx", "rtf", "md", "txt", "html"];

fn settings_file(data_dir: &Path, project_dir: &Path) -> PathBuf {
    let mut h = Sha1::new();
    h.update(project_dir.to_string_lossy().as_bytes());
    let key: String = h.finalize().iter().map(|b| format!("{:02x}", b)).collect();
    data_dir.join("export-targets").join(format!("{}.json", key))
}

fn base_name(project_dir: &Path) -> String { project_dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "Проект".into()) }

/// Предлагаемый путь: прошлая папка и формат; без истории или при неверной записи — «Документы» и DOCX.
pub fn default_path(data_dir: &Path, project_dir: &Path, documents: &Path) -> PathBuf {
    let fallback = documents.join(format!("{}.docx", base_name(project_dir)));
    let Ok(raw) = std::fs::read_to_string(settings_file(data_dir, project_dir)) else { return fallback };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else { return fallback };
    let (Some(folder), Some(format)) = (v["folder"].as_str(), v["format"].as_str()) else { return fallback };
    if !FORMATS.contains(&format) { return fallback; }
    let folder = Path::new(folder);
    let folder = if folder.is_absolute() && folder.is_dir() { folder } else { documents };
    folder.join(format!("{}.{}", base_name(project_dir), format))
}

pub fn remember(data_dir: &Path, project_dir: &Path, file: &Path) -> R<()> {
    let format = file.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !file.is_absolute() || !FORMATS.contains(&format.as_str()) { return Err("Неверный путь экспорта.".into()); }
    let f = settings_file(data_dir, project_dir);
    if let Some(p) = f.parent() { std::fs::create_dir_all(p).map_err(|e| e.to_string())?; }
    let folder = file.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    write_atomic(&f, &format!("{}\n", serde_json::json!({ "folder": folder, "format": format })))
}

/// Фильтры окна «Сохранить»: формат предложенного имени идёт первым, иначе окно покажет один тип, а в имени будет другой.
pub fn filters(default_file: &Path) -> Vec<(&'static str, &'static str)> {
    let all = [("docx", "Word (DOCX)"), ("rtf", "RTF"), ("md", "Markdown"), ("txt", "Обычный текст"), ("html", "HTML")];
    let ext = default_file.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let mut v: Vec<(&str, &str)> = all.to_vec();
    if let Some(i) = v.iter().position(|(e, _)| *e == ext) { let f = v.remove(i); v.insert(0, f); }
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::tmpdir;

    #[test]
    fn remembers_folder_and_format() {
        let (data, docs, proj) = (tmpdir("d"), tmpdir("docs"), Path::new("/p/Роман"));
        assert_eq!(default_path(&data, proj, &docs), docs.join("Роман.docx"));
        let out = tmpdir("out");
        remember(&data, proj, &out.join("x.rtf")).unwrap();
        assert_eq!(default_path(&data, proj, &docs), out.join("Роман.rtf"));
        std::fs::remove_dir_all(&out).unwrap();
        assert_eq!(default_path(&data, proj, &docs), docs.join("Роман.rtf")); // папки больше нет
        assert!(remember(&data, proj, Path::new("rel.txt")).is_err());
        assert!(remember(&data, proj, &docs.join("a.pdf")).is_err());
    }

    #[test]
    fn selected_format_goes_first() {
        let f = filters(Path::new("/a/b.md"));
        assert_eq!(f[0].0, "md");
        assert_eq!(f.len(), 5);
        assert_eq!(filters(Path::new("/a/b.pdf"))[0].0, "docx");
    }
}
