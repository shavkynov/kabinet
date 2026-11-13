//! Свои шрифты и звуки в папке данных приложения. Порт обработчиков fonts:* и sounds:* из main.js.
//! Файлы копируются, так что оригиналы автор может потом удалить. Содержимое отдаётся окну в base64.
use crate::store::R;
use base64::Engine;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const MAX_FONT_BYTES: u64 = 40 * 1024 * 1024;
pub const SOUND_SLOTS: [&str; 9] = [
    "ambient/rain", "ambient/fire", "ambient/wind", "ambient/sea", "ambient/hum",
    "keys/key", "keys/space", "keys/backspace", "keys/enter",
];

fn ext_is(name: &str, list: &[&str]) -> bool {
    Path::new(name).extension().and_then(|e| e.to_str()).map(|e| list.contains(&e.to_lowercase().as_str())).unwrap_or(false)
}
fn is_font(n: &str) -> bool { ext_is(n, &["ttf", "otf", "woff", "woff2"]) }
fn is_audio(n: &str) -> bool { ext_is(n, &["wav", "mp3", "ogg", "m4a", "aac"]) }
fn base(s: &str) -> String { Path::new(s).file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default() }
fn b64(bytes: &[u8]) -> String { base64::engine::general_purpose::STANDARD.encode(bytes) }
fn file_names(dir: &Path, ok: fn(&str) -> bool) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir).map(|rd| rd.filter_map(|e| e.ok())
        .filter(|e| e.path().is_file()).map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| ok(n)).collect()).unwrap_or_default();
    v.sort();
    v
}

fn fonts_dir(data: &Path) -> PathBuf { data.join("fonts") }

fn family(file: &str) -> String {
    let stem = Path::new(file).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let t: String = stem.chars().filter(|c| !matches!(c, '"' | '\'' | '\\')).collect();
    let t = t.trim();
    if t.is_empty() { "Шрифт".into() } else { t.into() }
}

pub fn fonts_list(data: &Path) -> Vec<Value> {
    let dir = fonts_dir(data);
    file_names(&dir, is_font).into_iter().filter_map(|f| {
        let bytes = std::fs::read(dir.join(&f)).ok()?;
        Some(json!({ "file": f, "family": family(&f), "data": b64(&bytes) }))
    }).collect()
}

pub fn fonts_add(data: &Path, srcs: &[PathBuf]) -> R<Vec<String>> {
    let dir = fonts_dir(data);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut added = vec![];
    for src in srcs {
        let name = base(&src.to_string_lossy());
        if !is_font(&name) { continue; }
        if std::fs::metadata(src).map_err(|e| e.to_string())?.len() > MAX_FONT_BYTES { return Err(format!("Файл слишком большой: {}", name)); }
        std::fs::copy(src, dir.join(&name)).map_err(|e| e.to_string())?;
        added.push(name);
    }
    Ok(added)
}

pub fn fonts_remove(data: &Path, file: &str) -> R<()> {
    let name = base(file);
    let target = fonts_dir(data).join(&name);
    if is_font(&name) && target.is_file() { std::fs::remove_file(target).map_err(|e| e.to_string())?; }
    Ok(())
}

fn sounds_root(data: &Path) -> PathBuf { data.join("sounds") }

fn slot_dir(data: &Path, slot: &str) -> R<PathBuf> {
    if !SOUND_SLOTS.contains(&slot) { return Err("Неизвестный вариант звука.".into()); }
    Ok(slot.split('/').fold(sounds_root(data), |p, s| p.join(s)))
}

/// Файлы key…, space…, enter…, backspace… из прежних версий лежали прямо в папке звуков: раскладываем по подпапкам.
fn migrate_old_key_sounds(data: &Path) {
    let root = sounds_root(data);
    let Ok(rd) = std::fs::read_dir(&root) else { return };
    for e in rd.filter_map(|e| e.ok()) {
        let f = e.file_name().to_string_lossy().to_string();
        let low = f.to_lowercase();
        let Some(kind) = ["key", "space", "enter", "backspace"].iter().find(|k| low.starts_with(**k)) else { continue };
        if !is_audio(&f) || !e.path().is_file() { continue; }
        let Ok(dir) = slot_dir(data, &format!("keys/{}", kind)) else { continue };
        let _ = std::fs::create_dir_all(&dir);
        if !dir.join(&f).exists() { let _ = std::fs::rename(e.path(), dir.join(&f)); }
    }
}

pub fn sounds_list(data: &Path) -> Value {
    migrate_old_key_sounds(data);
    let mut out = serde_json::Map::new();
    for slot in SOUND_SLOTS {
        let list = slot_dir(data, slot).map(|d| file_names(&d, is_audio)).unwrap_or_default();
        out.insert(slot.into(), json!(list));
    }
    Value::Object(out)
}

pub fn sound_read(data: &Path, slot: &str, file: &str) -> R<String> {
    let name = base(file);
    if !is_audio(&name) { return Err("Это не звуковой файл.".into()); }
    let bytes = std::fs::read(slot_dir(data, slot)?.join(&name)).map_err(|e| e.to_string())?;
    Ok(b64(&bytes))
}

pub fn sounds_add(data: &Path, slot: &str, srcs: &[PathBuf]) -> R<Vec<String>> {
    let dir = slot_dir(data, slot)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let limit: u64 = if slot.starts_with("ambient/") { 60 } else { 10 };
    let mut added = vec![];
    for src in srcs {
        let b = base(&src.to_string_lossy());
        if !is_audio(&b) { continue; }
        if std::fs::metadata(src).map_err(|e| e.to_string())?.len() > limit * 1024 * 1024 { return Err(format!("Файл слишком большой (больше {} МБ): {}", limit, b)); }
        let mut name = b.clone();
        let mut i = 2;
        while dir.join(&name).exists() {
            name = match b.rfind('.') { Some(p) => format!("{} {}{}", &b[..p], i, &b[p..]), None => format!("{} {}", b, i) };
            i += 1;
        }
        std::fs::copy(src, dir.join(&name)).map_err(|e| e.to_string())?;
        added.push(name);
    }
    Ok(added)
}

pub fn sound_remove(data: &Path, slot: &str, file: &str) -> R<()> {
    let name = base(file);
    let target = slot_dir(data, slot)?.join(&name);
    if is_audio(&name) && target.is_file() { std::fs::remove_file(target).map_err(|e| e.to_string())?; }
    Ok(())
}

pub fn sounds_folder(data: &Path) -> R<PathBuf> {
    let p = sounds_root(data);
    std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::tmpdir;

    #[test]
    fn fonts_and_sounds() {
        let data = tmpdir("media");
        let src = tmpdir("mediasrc");
        std::fs::write(src.join("Мой \"шрифт\".TTF"), b"FONT").unwrap();
        std::fs::write(src.join("a.txt"), b"x").unwrap();
        std::fs::write(src.join("дождь.mp3"), b"RAIN").unwrap();
        let added = fonts_add(&data, &[src.join("Мой \"шрифт\".TTF"), src.join("a.txt")]).unwrap();
        assert_eq!(added.len(), 1);
        let l = fonts_list(&data);
        assert_eq!(l[0]["family"], "Мой шрифт");
        assert_eq!(l[0]["data"], "Rk9OVA==");
        fonts_remove(&data, "../fonts/Мой \"шрифт\".TTF").unwrap();
        assert!(fonts_list(&data).is_empty());

        assert!(sounds_add(&data, "ambient/nope", &[]).is_err());
        assert_eq!(sounds_add(&data, "ambient/rain", &[src.join("дождь.mp3")]).unwrap(), vec!["дождь.mp3"]);
        assert_eq!(sounds_add(&data, "ambient/rain", &[src.join("дождь.mp3")]).unwrap(), vec!["дождь 2.mp3"]);
        assert_eq!(sound_read(&data, "ambient/rain", "дождь.mp3").unwrap(), "UkFJTg==");
        assert!(sound_read(&data, "ambient/rain", "x.txt").is_err());
        // старые файлы клавиш переезжают в подпапку
        std::fs::write(sounds_root(&data).join("Space1.wav"), b"S").unwrap();
        let l = sounds_list(&data);
        assert_eq!(l["keys/space"], json!(["Space1.wav"]));
        assert_eq!(l["ambient/rain"].as_array().unwrap().len(), 2);
        sound_remove(&data, "ambient/rain", "дождь 2.mp3").unwrap();
        assert_eq!(sounds_list(&data)["ambient/rain"], json!(["дождь.mp3"]));
    }
}
