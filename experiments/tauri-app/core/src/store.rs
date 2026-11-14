// Хранение проекта на диске. Порт src/project.js (главы, корзина, список недавних) с тем же форматом файлов:
// проект, созданный здесь, открывается в Electron-версии и наоборот. Неизвестные поля project.json сохраняются.
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

pub type R<T> = Result<T, String>;

/// Общий замок между штатным сохранением (write_chapter/write_item) и записью/удалением локальных
/// файлов внутри прохода синхронизации (foldersync::sync): закрывает окно «свежий хеш → запись/удаление».
/// write_atomic его НЕ берёт, чтобы guard_write (который сам вызывает write_atomic для копии в «Конфликты»)
/// не зашёл в повторный захват.
pub(crate) fn sync_save_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Тестовая точка синхронизации меты: срабатывает после чтения `project.json` и до изменения/сохранения.
/// Живёт только в unit-тестах (`cfg(test)`): в обычной сборке и в интеграционных тестах её нет.
/// Точка стоит ДО записи: локальная команда не удерживает `sync_save_lock` во время ожидания.
#[cfg(test)]
pub(crate) mod meta_hook {
    use std::cell::RefCell;
    type Hook = Box<dyn FnOnce()>;
    thread_local! {
        static HOOK: RefCell<Option<Hook>> = RefCell::new(None);
    }
    pub fn set<F: FnOnce() + 'static>(f: F) {
        HOOK.with(|h| *h.borrow_mut() = Some(Box::new(f)));
    }
    pub fn fire() {
        let hook = HOOK.with(|h| h.borrow_mut().take());
        if let Some(hook) = hook {
            hook();
        }
    }
}

const META: &str = "project.json";
const CHAPTERS_DIR: &str = "Главы";
const TRASH_DIR: &str = "Корзина";
const SUBDIRS: [&str; 7] = ["Главы", "Персонажи", "Места", "Предметы", "Заметки", "Изображения", "Корзина"];
const MARKERS: [&str; 3] = ["red", "orange", "green"];
const SYNOPSIS_MAX: usize = 200_000;
const NOTES_MAX: usize = 500_000;

// (ключ списка в project.json, папка, расширение)
const KINDS: [(&str, &str, &str, &str); 4] = [
    ("character", "characters", "Персонажи", "json"),
    ("place", "places", "Места", "json"),
    ("item", "items", "Предметы", "json"),
    ("note", "notes", "Заметки", "md"),
];

const CHAPTER_KEYS: [&str; 7] = ["id", "title", "goal", "marker", "synopsis", "notes", "comments"];
const ITEM_KEYS: [&str; 3] = ["id", "title", "icon"];
const TRASH_KEYS: [&str; 12] = ["tid", "kind", "id", "title", "index", "file", "deleted", "icon", "goal", "marker", "synopsis", "notes"];
const TRASH_OWN: [&str; 7] = ["tid", "kind", "id", "title", "index", "file", "deleted"];

fn kind_info(kind: &str) -> R<(&'static str, &'static str, &'static str)> {
    KINDS
        .iter()
        .find(|k| k.0 == kind)
        .map(|k| (k.1, k.2, k.3))
        .ok_or_else(|| "Неизвестный вид записи.".to_string())
}

// ---------- мелочи ----------

pub fn valid_id(s: &str) -> bool {
    (6..=32).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit() || b.is_ascii_lowercase())
}

fn new_id(taken: &HashSet<String>) -> String {
    loop {
        let bytes: [u8; 5] = rand::random();
        let id: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
        if !taken.contains(&id) {
            return id;
        }
    }
}

fn clean_title(v: Option<&Value>) -> String {
    let raw = match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    };
    raw.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(200).collect()
}

fn clean_goal(v: Option<&Value>) -> Option<i64> {
    let n = match v {
        Some(Value::Number(n)) => n.as_f64()?,
        Some(Value::String(s)) if !s.trim().is_empty() => s.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    if !n.is_finite() {
        return None;
    }
    let g = (n + 0.5).floor() as i64;
    if (1..=1_000_000).contains(&g) { Some(g) } else { None }
}

fn clean_icon(v: Option<&Value>) -> Option<String> {
    let s = v?.as_str()?.trim();
    if !s.is_empty() && s.encode_utf16().count() <= 16 { Some(s.to_string()) } else { None }
}

fn clean_deadline(v: Option<&Value>) -> Option<String> {
    let s = v?.as_str()?;
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' { return None; }
    let digits = |r: std::ops::Range<usize>| s[r].bytes().all(|c| c.is_ascii_digit());
    if !(digits(0..4) && digits(5..7) && digits(8..10)) { return None; }
    let (y, m, d): (i32, u32, u32) = (s[0..4].parse().ok()?, s[5..7].parse().ok()?, s[8..10].parse().ok()?);
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let dim = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if m >= 1 && m <= 12 && d >= 1 && d <= dim[(m - 1) as usize] { Some(s.to_string()) } else { None }
}

fn clean_template(v: Option<&Value>) -> Option<Vec<Value>> {
    let arr = v?.as_array()?;
    let mut names: Vec<String> = Vec::new();
    for raw in arr {
        let n: String = clean_title(Some(raw)).chars().take(100).collect();
        if !n.is_empty() && !names.contains(&n) { names.push(n); }
    }
    names.truncate(60);
    Some(names.into_iter().map(Value::String).collect())
}

fn clean_words(arr: &[Value]) -> Vec<Value> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for x in arr {
        let w = x.as_str().map(|s| s.trim().to_string()).unwrap_or_default();
        if w.is_empty() || w.encode_utf16().count() > 100 || w.chars().any(|c| (c as u32) < 0x20) || seen.contains(&w) { continue; }
        seen.insert(w.clone());
        out.push(Value::String(w));
        if out.len() >= 5000 { break; }
    }
    out
}

fn clean_comments(v: Option<&Value>) -> Vec<Value> {
    let Some(list) = v.and_then(|v| v.as_array()) else { return Vec::new() };
    let s = |c: &Value, k: &str, n: usize| -> String {
        c.get(k).and_then(|x| x.as_str()).map(|x| x.chars().take(n).collect()).unwrap_or_default()
    };
    let mut out = Vec::new();
    for c in list.iter().take(500) {
        let Some(id) = c.get("id").and_then(|x| x.as_str()) else { continue };
        if id.is_empty() || id.chars().count() > 40 || !id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-') { continue; }
        let pos = c.get("pos").and_then(|p| p.as_f64()).filter(|p| p.is_finite()).map(|p| p.trunc().max(0.0) as i64).unwrap_or(0);
        let mut e = Map::new();
        e.insert("id".into(), json!(id));
        e.insert("text".into(), json!(s(c, "text", 5000)));
        e.insert("quote".into(), json!(s(c, "quote", 2000)));
        e.insert("before".into(), json!(s(c, "before", 60)));
        e.insert("after".into(), json!(s(c, "after", 60)));
        e.insert("pos".into(), json!(pos));
        e.insert("ts".into(), json!(s(c, "ts", 40)));
        if c.get("lost") == Some(&Value::Bool(true)) { e.insert("lost".into(), Value::Bool(true)); }
        out.push(Value::Object(e));
    }
    out
}

fn carry_unknown(src: &Map<String, Value>, out: &mut Map<String, Value>, known: &[&str]) {
    for (k, v) in src {
        if k != "__proto__" && !known.contains(&k.as_str()) && !out.contains_key(k) {
            out.insert(k.clone(), v.clone());
        }
    }
}

fn is_auto_title(t: &str) -> bool {
    match t.split_once(' ') {
        Some((p, n)) => ["Глава", "Рассказ", "Chapter", "Story"].contains(&p) && !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()),
        None => false,
    }
}

fn unit_title(meta: &Map<String, Value>, n: usize) -> String {
    if meta.get("mode").and_then(|m| m.as_str()) == Some("stories") { format!("Рассказ {}", n) } else { format!("Глава {}", n) }
}

fn renumber(meta: &mut Map<String, Value>) {
    let stories = meta.get("mode").and_then(|m| m.as_str()) == Some("stories");
    if let Some(Value::Array(chapters)) = meta.get_mut("chapters") {
        for (i, c) in chapters.iter_mut().enumerate() {
            let auto = c.get("title").and_then(|t| t.as_str()).map(is_auto_title).unwrap_or(false);
            if auto {
                let t = if stories { format!("Рассказ {}", i + 1) } else { format!("Глава {}", i + 1) };
                c["title"] = Value::String(t);
            }
        }
    }
}

// ---------- время ----------

fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn now_parts() -> (i64, u32, u32, u64, u64, u64, u32) {
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs();
    let (y, m, day) = civil((secs / 86_400) as i64);
    (y, m, day, (secs / 3600) % 24, (secs / 60) % 60, secs % 60, d.subsec_millis())
}

pub fn iso_now() -> String {
    let (y, m, d, h, mi, s, ms) = now_parts();
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", y, m, d, h, mi, s, ms)
}

fn stamp() -> String { crate::syncguard::stamp_now() }

// ---------- файлы ----------

pub fn write_atomic(file: &Path, data: &str) -> R<()> {
    write_atomic_bytes(file, data.as_bytes())?;
    // Своя запись тоже становится «известной» версией файла: как known+wrote в JS writeFileAtomic.
    crate::syncguard::note_written(file, data);
    Ok(())
}

pub fn write_atomic_bytes(file: &Path, data: &[u8]) -> R<()> {
    let tag: [u8; 3] = rand::random();
    let tmp = PathBuf::from(format!("{}.{}.{:02x}{:02x}{:02x}.tmp", file.display(), std::process::id(), tag[0], tag[1], tag[2]));
    let result = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        drop(f);
        let mut last = Ok(());
        for attempt in 0..6 {
            match fs::rename(&tmp, file) {
                Ok(()) => return Ok(()),
                Err(e) => { last = Err(e); std::thread::sleep(std::time::Duration::from_millis(40 * (attempt + 1))); }
            }
        }
        last
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(format!("Не удалось записать файл: {}", e));
    }
    crate::watcher::note_written(file, data);
    Ok(())
}

fn meta_path(dir: &Path) -> PathBuf { dir.join(META) }

fn chapter_file(dir: &Path, id: &str) -> R<PathBuf> {
    if !valid_id(id) { return Err("Неверный идентификатор главы.".into()); }
    Ok(dir.join(CHAPTERS_DIR).join(format!("{}.md", id)))
}

fn item_file(dir: &Path, kind: &str, id: &str) -> R<PathBuf> {
    let (_, d, ext) = kind_info(kind)?;
    if !valid_id(id) { return Err("Неверный идентификатор.".into()); }
    Ok(dir.join(d).join(format!("{}.{}", id, ext)))
}

// ---------- project.json ----------

pub fn load_meta(dir: &Path) -> R<Map<String, Value>> {
    let raw = match fs::read_to_string(meta_path(dir)) {
        Ok(s) => {
            // Запоминаем прочитанную версию до разбора: как noteRead в JS loadMeta.
            crate::syncguard::note_read(&meta_path(dir), &s);
            s
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err("В этой папке нет проекта Кабинета (нет файла project.json).".into());
        }
        Err(e) => return Err(format!("Не удалось прочитать project.json: {}", e)),
    };
    let parsed: Value = serde_json::from_str(raw.trim_start_matches('\u{feff}')).map_err(|_| {
        "Файл project.json повреждён. Программа его не изменяла. Рядом может лежать копия project.json.bak: её можно переименовать в project.json.".to_string()
    })?;
    let mut meta = match parsed {
        Value::Object(m) if m.get("chapters").map(|c| c.is_array()).unwrap_or(false) => m,
        _ => return Err("Файл project.json имеет неожиданный вид. Программа его не изменяла.".into()),
    };
    if meta.get("mode").and_then(|m| m.as_str()) != Some("stories") { meta.remove("mode"); }

    let untitled = "Без названия";
    let chapters: Vec<Value> = meta["chapters"].as_array().cloned().unwrap_or_default().iter().filter_map(|c| {
        let src = c.as_object()?;
        let id = src.get("id")?.as_str()?;
        if !valid_id(id) { return None; }
        let mut ch = Map::new();
        ch.insert("id".into(), json!(id));
        let t = clean_title(src.get("title"));
        ch.insert("title".into(), json!(if t.is_empty() { untitled.to_string() } else { t }));
        if let Some(g) = clean_goal(src.get("goal")) { ch.insert("goal".into(), json!(g)); }
        if let Some(m) = src.get("marker").and_then(|m| m.as_str()) { if MARKERS.contains(&m) { ch.insert("marker".into(), json!(m)); } }
        if let Some(s) = src.get("synopsis").and_then(|s| s.as_str()) { if !s.is_empty() { ch.insert("synopsis".into(), json!(s.chars().take(SYNOPSIS_MAX).collect::<String>())); } }
        if let Some(s) = src.get("notes").and_then(|s| s.as_str()) { if !s.is_empty() { ch.insert("notes".into(), json!(s.chars().take(NOTES_MAX).collect::<String>())); } }
        let comments = clean_comments(src.get("comments"));
        if !comments.is_empty() { ch.insert("comments".into(), Value::Array(comments)); }
        carry_unknown(src, &mut ch, &CHAPTER_KEYS);
        Some(Value::Object(ch))
    }).collect();
    meta.insert("chapters".into(), Value::Array(chapters));

    for (_, list, _, _) in KINDS.iter() {
        let src_list = meta.get(*list).and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let items: Vec<Value> = src_list.iter().filter_map(|c| {
            let src = c.as_object()?;
            let id = src.get("id")?.as_str()?;
            if !valid_id(id) { return None; }
            let mut it = Map::new();
            it.insert("id".into(), json!(id));
            let t = clean_title(src.get("title"));
            it.insert("title".into(), json!(if t.is_empty() { untitled.to_string() } else { t }));
            if let Some(i) = clean_icon(src.get("icon")) { it.insert("icon".into(), json!(i)); }
            carry_unknown(src, &mut it, &ITEM_KEYS);
            Some(Value::Object(it))
        }).collect();
        meta.insert((*list).to_string(), Value::Array(items));
    }

    let trash_src = meta.get("trash").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let trash: Vec<Value> = trash_src.iter().filter_map(|e| {
        let src = e.as_object()?;
        let tid = src.get("tid")?.as_str()?;
        let id = src.get("id")?.as_str()?;
        let kind = src.get("kind")?.as_str()?;
        if !valid_id(id) || !(kind == "chapter" || kind_info(kind).is_ok()) { return None; }
        let mut out = Map::new();
        out.insert("tid".into(), json!(tid.chars().take(40).collect::<String>()));
        out.insert("kind".into(), json!(kind));
        out.insert("id".into(), json!(id));
        let t = clean_title(src.get("title"));
        out.insert("title".into(), json!(if t.is_empty() { untitled.to_string() } else { t }));
        let index = src.get("index").and_then(|i| i.as_f64()).filter(|i| i.is_finite()).map(|i| i.trunc().max(0.0) as i64).unwrap_or(0);
        out.insert("index".into(), json!(index));
        let file = src.get("file").and_then(|f| f.as_str()).unwrap_or("");
        out.insert("file".into(), json!(Path::new(file).file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default()));
        out.insert("deleted".into(), json!(src.get("deleted").and_then(|d| d.as_str()).unwrap_or("")));
        if let Some(i) = clean_icon(src.get("icon")) { out.insert("icon".into(), json!(i)); }
        if let Some(g) = clean_goal(src.get("goal")) { out.insert("goal".into(), json!(g)); }
        if let Some(m) = src.get("marker").and_then(|m| m.as_str()) { if MARKERS.contains(&m) { out.insert("marker".into(), json!(m)); } }
        if let Some(s) = src.get("synopsis").and_then(|s| s.as_str()) { if !s.is_empty() { out.insert("synopsis".into(), json!(s.chars().take(SYNOPSIS_MAX).collect::<String>())); } }
        if let Some(s) = src.get("notes").and_then(|s| s.as_str()) { if !s.is_empty() { out.insert("notes".into(), json!(s.chars().take(NOTES_MAX).collect::<String>())); } }
        carry_unknown(src, &mut out, &TRASH_KEYS);
        Some(Value::Object(out))
    }).collect();
    meta.insert("trash".into(), Value::Array(trash));

    let t = meta.get("templates").and_then(|t| t.as_object()).cloned().unwrap_or_default();
    let default_character = ["Общее описание", "Возраст", "Рост и телосложение", "Волосы", "Глаза", "Особые приметы", "Одежда", "Характер", "Привычки и манера речи", "Прошлое", "Цели и страхи", "Связи с другими"];
    let default_place = ["Общее описание", "Расположение", "Климат", "Атмосфера", "Население", "Достопримечательности", "История", "Связанные персонажи"];
    let defaults = |d: &[&str]| d.iter().map(|x| Value::String(x.to_string())).collect::<Vec<_>>();
    let character = clean_template(t.get("character")).unwrap_or_else(|| defaults(&default_character));
    let place = clean_template(t.get("place")).unwrap_or_else(|| defaults(&default_place));
    meta.insert("templates".into(), json!({ "character": character, "place": place }));

    match clean_goal(meta.get("projectGoal")) { Some(g) => { meta.insert("projectGoal".into(), json!(g)); } None => { meta.remove("projectGoal"); } }
    // analysisSkip: объект остаётся как есть (в Electron его дополнительно чистит editing.cleanSkip), иначе убирается
    let skip_ok = meta.get("analysisSkip").and_then(|s| s.as_object()).map(|o| !o.is_empty()).unwrap_or(false);
    if !skip_ok { meta.remove("analysisSkip"); }
    if let Some(Value::Array(w)) = meta.get("words").cloned() { meta.insert("words".into(), Value::Array(clean_words(&w))); } else { meta.remove("words"); }
    match clean_deadline(meta.get("deadline")) { Some(d) => { meta.insert("deadline".into(), json!(d)); } None => { meta.remove("deadline"); } }
    match clean_goal(meta.get("defaultGoal")) { Some(g) => { meta.insert("defaultGoal".into(), json!(g)); } None => { meta.remove("defaultGoal"); } }
    let unit_ok = matches!(meta.get("goalUnit").and_then(|u| u.as_str()), Some("words") | Some("chars"));
    if !unit_ok { meta.remove("goalUnit"); }
    match clean_goal(meta.get("charLimit")) { Some(g) => { meta.insert("charLimit".into(), json!(g)); } None => { meta.remove("charLimit"); } }
    Ok(meta)
}

pub fn save_meta(dir: &Path, meta: &Map<String, Value>) -> R<()> {
    let p = meta_path(dir);
    if p.exists() { let _ = fs::copy(&p, format!("{}.bak", p.display())); }
    let text = serde_json::to_string_pretty(&Value::Object(meta.clone())).map_err(|e| e.to_string())?;
    write_atomic(&p, &text)
}

fn items_view(meta: &Map<String, Value>, list: &str) -> Value {
    Value::Array(meta.get(list).and_then(|v| v.as_array()).map(|a| a.iter().map(|c| json!({
        "id": c["id"], "title": c["title"], "icon": c.get("icon").cloned().unwrap_or(Value::Null),
    })).collect()).unwrap_or_default())
}

pub fn view(dir: &Path, meta: &Map<String, Value>) -> Value {
    let stories = meta.get("mode").and_then(|m| m.as_str()) == Some("stories");
    let name = meta.get("name").and_then(|n| n.as_str()).filter(|n| !n.is_empty()).map(|n| n.to_string())
        .unwrap_or_else(|| dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
    let get = |k: &str| meta.get(k).cloned().unwrap_or(Value::Null);
    let chapters: Vec<Value> = meta["chapters"].as_array().map(|a| a.iter().map(|c| json!({
        "id": c["id"], "title": c["title"], "goal": c.get("goal").cloned().unwrap_or(Value::Null), "marker": c.get("marker").cloned().unwrap_or(Value::Null),
    })).collect()).unwrap_or_default();
    let trash: Vec<Value> = meta["trash"].as_array().map(|a| a.iter().rev().map(|e| json!({
        "tid": e["tid"], "kind": e["kind"], "id": e["id"], "title": e["title"], "icon": e.get("icon").cloned().unwrap_or(Value::Null), "deleted": e["deleted"],
    })).collect()).unwrap_or_default();
    json!({
        "name": name,
        "defaultGoal": get("defaultGoal"),
        "projectGoal": get("projectGoal"),
        "analysisSkip": meta.get("analysisSkip").cloned().unwrap_or_else(|| json!({})),
        "deadline": get("deadline"),
        "mode": if stories { "stories" } else { "novel" },
        "goalUnit": if stories { meta.get("goalUnit").cloned().unwrap_or_else(|| json!("chars")) } else { json!("words") },
        "charLimit": if stories { get("charLimit") } else { Value::Null },
        "chapters": chapters,
        "characters": items_view(meta, "characters"),
        "places": items_view(meta, "places"),
        "items": items_view(meta, "items"),
        "notes": items_view(meta, "notes"),
        "templates": meta["templates"].clone(),
        "trash": trash,
    })
}

fn chapters_mut(meta: &mut Map<String, Value>) -> &mut Vec<Value> {
    meta.get_mut("chapters").and_then(|c| c.as_array_mut()).expect("chapters проверены при чтении")
}

fn find_index(meta: &Map<String, Value>, id: &str) -> R<usize> {
    meta["chapters"].as_array().and_then(|a| a.iter().position(|c| c["id"] == id)).ok_or_else(|| "Глава не найдена в проекте.".to_string())
}

fn ensure_dirs(dir: &Path) { for d in SUBDIRS.iter() { let _ = fs::create_dir_all(dir.join(d)); } }

// ---------- проект ----------

pub fn create_project(dir: &Path, name: &str, mode: Option<&str>) -> R<Value> {
    if meta_path(dir).exists() { return Err("В этой папке уже есть проект.".into()); }
    fs::create_dir_all(dir).map_err(|e| format!("Не удалось создать папку проекта: {}", e))?;
    ensure_dirs(dir);
    let id = new_id(&HashSet::new());
    write_atomic(&chapter_file(dir, &id)?, "")?;
    let stories = mode == Some("stories");
    let t = clean_title(Some(&json!(name)));
    let base = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let mut meta = Map::new();
    meta.insert("app".into(), json!("kabinet"));
    meta.insert("version".into(), json!(1));
    meta.insert("name".into(), json!(if t.is_empty() { base } else { t }));
    if stories { meta.insert("mode".into(), json!("stories")); }
    meta.insert("chapters".into(), json!([{ "id": id, "title": if stories { "Рассказ 1" } else { "Глава 1" } }]));
    for (_, list, _, _) in KINDS.iter() { meta.insert((*list).to_string(), json!([])); }
    save_meta(dir, &meta)?;
    let loaded = load_meta(dir)?;
    Ok(view(dir, &loaded))
}

/// Открывает проект; файлы глав, которых нет в project.json, добавляются в конец списка, чтобы текст не потерялся.
pub fn open_project(dir: &Path) -> R<Value> {
    let mut meta = load_meta(dir)?;
    ensure_dirs(dir);
    let mut known: HashSet<String> = meta["chapters"].as_array().map(|a| a.iter().filter_map(|c| c["id"].as_str().map(String::from)).collect()).unwrap_or_default();
    let mut files: Vec<String> = fs::read_dir(dir.join(CHAPTERS_DIR)).map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).collect()).unwrap_or_default();
    files.sort();
    let mut changed = false;
    for f in files {
        if let Some(stem) = f.strip_suffix(".md") {
            if valid_id(stem) && !known.contains(stem) {
                let head: String = stem.chars().take(4).collect();
                chapters_mut(&mut meta).push(json!({ "id": stem, "title": format!("Найденная глава ({})", head) }));
                known.insert(stem.to_string());
                changed = true;
            }
        }
    }
    if changed { save_meta(dir, &meta)?; }
    Ok(view(dir, &meta))
}

// ---------- главы ----------

pub fn add_chapter(dir: &Path, after: Option<&str>) -> R<Value> {
    let mut meta = load_meta(dir)?;
    let taken: HashSet<String> = meta["chapters"].as_array().map(|a| a.iter().filter_map(|c| c["id"].as_str().map(String::from)).collect()).unwrap_or_default();
    let id = new_id(&taken);
    write_atomic(&chapter_file(dir, &id)?, "")?; // сначала файл, потом запись в project.json: ссылка никогда не ведёт в пустоту
    let mut at = chapters_mut(&mut meta).len();
    if let Some(a) = after.filter(|a| !a.is_empty()) {
        if let Some(i) = chapters_mut(&mut meta).iter().position(|c| c["id"] == a) { at = i + 1; }
    }
    let title = unit_title(&meta, at + 1);
    chapters_mut(&mut meta).insert(at, json!({ "id": id, "title": title }));
    renumber(&mut meta);
    save_meta(dir, &meta)?;
    Ok(json!({ "project": view(dir, &meta), "id": id }))
}

/// Импорт глав: первый текст занимает пустую главу нового проекта, остальные добавляются в конец.
pub fn import_chapters(dir: &Path, items: &[(String, String)]) -> R<Value> {
    if items.is_empty() { return Err("Нечего импортировать.".into()); }
    if items.len() > 500 { return Err("За один раз можно импортировать не больше 500 глав.".into()); }
    let meta0 = load_meta(dir)?;
    let only = meta0["chapters"].as_array().filter(|a| a.len() == 1).map(|a| a[0].clone());
    let reuse = only.and_then(|c| {
        let id = c["id"].as_str()?.to_string();
        let empty = read_chapter(dir, &id).map(|t| t.trim().is_empty()).unwrap_or(false);
        if is_auto_title(c["title"].as_str().unwrap_or("")) && empty { Some(id) } else { None }
    });
    let mut ids = Vec::new();
    for (k, (title, text)) in items.iter().enumerate() {
        let id = match (&reuse, k) {
            (Some(r), 0) => r.clone(),
            _ => add_chapter(dir, None)?["id"].as_str().unwrap_or("").to_string(),
        };
        if !title.is_empty() { rename_chapter(dir, &id, title)?; }
        if !text.is_empty() { write_chapter(dir, &id, text)?; }
        ids.push(id);
    }
    let mut meta = load_meta(dir)?;
    renumber(&mut meta);
    save_meta(dir, &meta)?;
    Ok(json!({ "project": view(dir, &meta), "ids": ids }))
}

pub fn rename_chapter(dir: &Path, id: &str, title: &str) -> R<Value> {
    let mut meta = load_meta(dir)?;
    #[cfg(test)]
    meta_hook::fire(); // ТЕСТОВАЯ ТОЧКА: после чтения project.json, до изменения и сохранения
    let i = find_index(&meta, id)?;
    let t = clean_title(Some(&json!(title)));
    if !t.is_empty() { chapters_mut(&mut meta)[i]["title"] = json!(t); }
    save_meta(dir, &meta)?;
    Ok(view(dir, &meta))
}

pub fn move_chapter(dir: &Path, id: &str, new_index: f64) -> R<Value> {
    let mut meta = load_meta(dir)?;
    let from = find_index(&meta, id)?;
    let item = chapters_mut(&mut meta).remove(from);
    let n = if new_index.is_finite() { new_index.trunc() as i64 } else { 0 };
    let to = n.clamp(0, chapters_mut(&mut meta).len() as i64) as usize;
    chapters_mut(&mut meta).insert(to, item);
    renumber(&mut meta);
    save_meta(dir, &meta)?;
    Ok(view(dir, &meta))
}

pub fn set_chapter_goal(dir: &Path, id: &str, goal: Option<&Value>) -> R<Value> {
    let mut meta = load_meta(dir)?;
    let i = find_index(&meta, id)?;
    match clean_goal(goal) {
        Some(g) => { chapters_mut(&mut meta)[i]["goal"] = json!(g); }
        None => { if let Some(o) = chapters_mut(&mut meta)[i].as_object_mut() { o.remove("goal"); } }
    }
    save_meta(dir, &meta)?;
    Ok(view(dir, &meta))
}

pub fn set_chapter_marker(dir: &Path, id: &str, marker: Option<&str>) -> R<Value> {
    let mut meta = load_meta(dir)?;
    let i = find_index(&meta, id)?;
    match marker.filter(|m| MARKERS.contains(m)) {
        Some(m) => { chapters_mut(&mut meta)[i]["marker"] = json!(m); }
        None => { if let Some(o) = chapters_mut(&mut meta)[i].as_object_mut() { o.remove("marker"); } }
    }
    save_meta(dir, &meta)?;
    Ok(view(dir, &meta))
}

pub fn set_default_goal(dir: &Path, goal: Option<&Value>) -> R<Value> {
    let mut meta = load_meta(dir)?;
    match clean_goal(goal) { Some(g) => { meta.insert("defaultGoal".into(), json!(g)); } None => { meta.remove("defaultGoal"); } }
    save_meta(dir, &meta)?;
    Ok(view(dir, &meta))
}

fn read_chapter_impl(dir: &Path, id: &str, track: bool) -> R<String> {
    let file = chapter_file(dir, id)?;
    match fs::read_to_string(&file) {
        Ok(s) => {
            if track {
                crate::syncguard::note_read(&file, &s); // окно открыло главу: эту версию защищаем от затирания
            }
            Ok(s)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(format!(
            "Файл главы «{}.md» не найден в папке «Главы». Дождитесь завершения синхронизации или восстановите файл из резервной копии. Пустая глава вместо него не создана.", id)),
        Err(e) => Err(format!("Не удалось прочитать главу: {}", e)),
    }
}

/// Чтение главы для окна (chapter:read): запоминаем версию файла для защиты от затирания.
pub fn read_chapter(dir: &Path, id: &str) -> R<String> {
    read_chapter_impl(dir, id, true)
}

/// Строгое чтение главы без запоминания версии: сборка экспорта не должна обновлять «известный» хэш.
pub fn read_chapter_untracked(dir: &Path, id: &str) -> R<String> {
    read_chapter_impl(dir, id, false)
}

/// Чтение главы для сводных операций (счётчики, доска, поиск, замена, упоминания): отсутствующий файл считается пустым,
/// чтобы одна пропавшая глава не останавливала остальные. Настоящие ошибки чтения по-прежнему возвращаются.
pub fn read_chapter_lenient(dir: &Path, id: &str) -> R<String> {
    let file = chapter_file(dir, id)?;
    match fs::read_to_string(&file) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("Не удалось прочитать главу: {}", e)),
    }
}

pub fn write_chapter(dir: &Path, id: &str, text: &str) -> R<Value> {
    let meta = load_meta(dir)?;
    let i = find_index(&meta, id)?; // пишем только в главы, которые есть в проекте
    let title = meta["chapters"][i]["title"].as_str().unwrap_or("").to_string();
    let file = chapter_file(dir, id)?;
    // Файл изменили снаружи: чужую версию сохраняем в «Конфликты», потом пишем свою.
    // Замок держим только вокруг проверки и записи, чтобы проход синхронизации не мог вклиниться
    // между «свежий хеш» и записью/удалением этого файла.
    let _guard = sync_save_lock().lock().map_err(|_| "Внутренний замок сохранения недоступен.".to_string())?;
    let conflict = crate::syncguard::guard_write(dir, &file, text, &title)?;
    write_atomic(&file, text)?;
    Ok(json!({ "conflict": conflict }))
}

// ---------- корзина ----------

fn move_to_trash(dir: &Path, src: &Path, title: &str, id: &str, ext: &str) -> R<String> {
    if !src.exists() { return Ok(String::new()); }
    let safe: String = title.chars().map(|c| if "\\/:*?\"<>|".contains(c) { '-' } else { c }).take(60).collect();
    let name = format!("{} ({}) {}.{}", safe, id, stamp(), ext);
    fs::create_dir_all(dir.join(TRASH_DIR)).map_err(|e| e.to_string())?;
    fs::rename(src, dir.join(TRASH_DIR).join(&name)).map_err(|e| format!("Не удалось переместить в корзину: {}", e))?;
    Ok(name)
}

fn push_trash(meta: &mut Map<String, Value>, kind: &str, removed: &Value, index: usize, file: &str) {
    let taken: HashSet<String> = meta["trash"].as_array().map(|a| a.iter().filter_map(|e| e["tid"].as_str().map(String::from)).collect()).unwrap_or_default();
    let mut entry = Map::new();
    entry.insert("tid".into(), json!(new_id(&taken)));
    entry.insert("kind".into(), json!(kind));
    entry.insert("id".into(), removed["id"].clone());
    entry.insert("title".into(), removed["title"].clone());
    entry.insert("index".into(), json!(index));
    entry.insert("file".into(), json!(file));
    entry.insert("deleted".into(), json!(iso_now()));
    if let Some(o) = removed.as_object() {
        for (k, v) in o { if k != "__proto__" && !TRASH_OWN.contains(&k.as_str()) { entry.insert(k.clone(), v.clone()); } }
    }
    if let Some(Value::Array(t)) = meta.get_mut("trash") { t.push(Value::Object(entry)); }
}

pub fn delete_chapter(dir: &Path, id: &str) -> R<Value> {
    let mut meta = load_meta(dir)?;
    let i = find_index(&meta, id)?;
    let removed = chapters_mut(&mut meta).remove(i);
    let title = removed["title"].as_str().unwrap_or("").to_string();
    let file = move_to_trash(dir, &chapter_file(dir, id)?, &title, id, "md")?;
    push_trash(&mut meta, "chapter", &removed, i, &file);
    renumber(&mut meta);
    save_meta(dir, &meta)?;
    Ok(view(dir, &meta))
}

fn trash_index(meta: &Map<String, Value>, tid: &str) -> R<usize> {
    meta["trash"].as_array().and_then(|a| a.iter().position(|e| e["tid"] == tid)).ok_or_else(|| "Записи нет в корзине.".to_string())
}

pub fn restore_trash(dir: &Path, tid: &str) -> R<Value> {
    let mut meta = load_meta(dir)?;
    let i = trash_index(&meta, tid)?;
    let e = meta["trash"][i].clone();
    let kind = e["kind"].as_str().unwrap_or("").to_string();
    let id = e["id"].as_str().unwrap_or("").to_string();
    let is_chapter = kind == "chapter";
    let list_key = if is_chapter { "chapters".to_string() } else { kind_info(&kind)?.0.to_string() };
    let exists = meta[&list_key].as_array().map(|a| a.iter().any(|c| c["id"] == id.as_str())).unwrap_or(false);
    if exists { return Err("Такая запись уже есть в проекте.".into()); }
    let dest = if is_chapter { chapter_file(dir, &id)? } else { item_file(dir, &kind, &id)? };
    let file = e["file"].as_str().unwrap_or("");
    let src = if file.is_empty() { None } else { Some(dir.join(TRASH_DIR).join(file)) };
    match src {
        Some(s) if s.exists() => {
            if let Some(p) = dest.parent() { let _ = fs::create_dir_all(p); }
            fs::rename(&s, &dest).map_err(|er| format!("Не удалось вернуть файл из корзины: {}", er))?;
        }
        _ if !dest.exists() => {
            if !file.is_empty() {
                return Err("Файл этой записи пропал из Корзины, вернуть её нельзя. Запись можно удалить из корзины насовсем.".into());
            }
            if !is_chapter && kind_info(&kind)?.2 != "md" {
                return Err("Карточку без файла пока нельзя восстановить в этой версии.".into());
            }
            write_atomic(&dest, "")?;
        }
        _ => {}
    }
    let mut item = Map::new();
    item.insert("id".into(), json!(id));
    item.insert("title".into(), e["title"].clone());
    if let Some(o) = e.as_object() {
        for (k, v) in o { if k != "__proto__" && !TRASH_OWN.contains(&k.as_str()) { item.insert(k.clone(), v.clone()); } }
    }
    let at = (e["index"].as_u64().unwrap_or(0) as usize).min(meta[&list_key].as_array().map(|a| a.len()).unwrap_or(0));
    if let Some(Value::Array(list)) = meta.get_mut(&list_key) { list.insert(at, Value::Object(item)); }
    if let Some(Value::Array(t)) = meta.get_mut("trash") { t.remove(i); }
    if is_chapter { renumber(&mut meta); }
    save_meta(dir, &meta)?;
    Ok(json!({ "project": view(dir, &meta), "kind": kind, "id": id }))
}

fn remove_trash_file(dir: &Path, e: &Value) -> R<()> {
    let file = e["file"].as_str().unwrap_or("");
    if file.is_empty() { return Ok(()); }
    match fs::remove_file(dir.join(TRASH_DIR).join(file)) {
        Ok(()) => Ok(()),
        Err(er) if er.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(er) => Err(format!("Не удалось удалить файл из корзины: {}", er)),
    }
}

pub fn purge_trash(dir: &Path, tid: &str) -> R<Value> {
    let mut meta = load_meta(dir)?;
    let i = trash_index(&meta, tid)?;
    remove_trash_file(dir, &meta["trash"][i])?;
    if let Some(Value::Array(t)) = meta.get_mut("trash") { t.remove(i); }
    save_meta(dir, &meta)?;
    Ok(view(dir, &meta))
}

pub fn empty_trash(dir: &Path) -> R<Value> {
    let mut meta = load_meta(dir)?;
    for e in meta["trash"].as_array().cloned().unwrap_or_default() { remove_trash_file(dir, &e)?; }
    meta.insert("trash".into(), json!([]));
    save_meta(dir, &meta)?;
    Ok(view(dir, &meta))
}

// ---------- недавние проекты ----------

const RECENTS_MAX: usize = 15;

fn recents_raw(file: &Path) -> Vec<Value> {
    fs::read_to_string(file).ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_array().cloned())
        .map(|a| a.into_iter().filter(|x| x.get("path").and_then(|p| p.as_str()).is_some()).collect())
        .unwrap_or_default()
}

fn recents_write(file: &Path, list: &[Value]) -> R<()> {
    if let Some(p) = file.parent() { let _ = fs::create_dir_all(p); }
    write_atomic(file, &serde_json::to_string_pretty(list).map_err(|e| e.to_string())?)
}

pub fn recents_add(file: &Path, path: &str, name: &str) -> R<()> {
    let mut list: Vec<Value> = recents_raw(file).into_iter().filter(|x| x["path"] != path).collect();
    list.insert(0, json!({ "path": path, "name": name, "lastOpened": iso_now() }));
    list.truncate(RECENTS_MAX);
    recents_write(file, &list)
}

pub fn recents_remove(file: &Path, path: &str) -> R<()> {
    let list: Vec<Value> = recents_raw(file).into_iter().filter(|x| x["path"] != path).collect();
    recents_write(file, &list)
}

pub fn recents_has(file: &Path, path: &str) -> bool { recents_raw(file).iter().any(|x| x["path"] == path) }

pub fn recents_list(file: &Path) -> Value {
    Value::Array(recents_raw(file).into_iter().map(|mut x| {
        let exists = x["path"].as_str().map(|p| Path::new(p).join(META).exists()).unwrap_or(false);
        x["exists"] = Value::Bool(exists);
        x
    }).collect())
}

pub fn safe_folder_name(name: &str) -> R<String> {
    let replaced: String = name.chars().map(|c| if "\\/:*?\"<>|".contains(c) { '-' } else { c }).collect();
    let n = replaced.trim_start_matches('.').trim().trim_end_matches(|c| c == '.' || c == ' ').to_string();
    if n.is_empty() { return Err("Введите название проекта.".into()); }
    let reserved = {
        let l = n.to_lowercase();
        ["con", "prn", "aux", "nul"].contains(&l.as_str())
            || ((l.starts_with("com") || l.starts_with("lpt")) && l.len() == 4 && l.as_bytes()[3].is_ascii_digit())
    };
    let n = if reserved { format!("_{}", n) } else { n };
    Ok(n.chars().take(80).collect())
}

// ---------- объём текста ----------

fn is_word_char(c: char) -> bool { c.is_alphabetic() || c.is_numeric() }

/// Слова: буквы и цифры, внутри слова допустимы дефис, короткое тире и апострофы (как WORD_RE в Electron-версии).
pub fn count_words(text: &str) -> usize {
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    let mut n = 0;
    while i < chars.len() {
        if !is_word_char(chars[i]) { i += 1; continue; }
        n += 1;
        while i < chars.len() {
            if is_word_char(chars[i]) { i += 1; continue; }
            if "-–’'".contains(chars[i]) && i + 1 < chars.len() && is_word_char(chars[i + 1]) { i += 2; continue; }
            break;
        }
    }
    n
}

fn strip_line_prefix(line: &str) -> String {
    let t = line.trim_start();
    let b: Vec<char> = t.chars().collect();
    let ws = |c: char| c.is_whitespace();
    // заголовок: от одного до шести «#» и пробел
    let hashes = b.iter().take_while(|c| **c == '#').count();
    if (1..=6).contains(&hashes) && b.get(hashes).map(|c| ws(*c)).unwrap_or(false) {
        let mut k = hashes;
        while k < b.len() && ws(b[k]) { k += 1; }
        return b[k..].iter().collect();
    }
    if b.first() == Some(&'>') {
        let k = if b.get(1).map(|c| ws(*c)).unwrap_or(false) { 2 } else { 1 };
        return b[k..].iter().collect();
    }
    if matches!(b.first(), Some('-') | Some('*') | Some('+')) && b.get(1).map(|c| ws(*c)).unwrap_or(false) {
        let mut k = 1;
        while k < b.len() && ws(b[k]) { k += 1; }
        return b[k..].iter().collect();
    }
    let digits = b.iter().take_while(|c| c.is_ascii_digit()).count();
    if digits > 0 && matches!(b.get(digits), Some('.') | Some(')')) && b.get(digits + 1).map(|c| ws(*c)).unwrap_or(false) {
        let mut k = digits + 1;
        while k < b.len() && ws(b[k]) { k += 1; }
        return b[k..].iter().collect();
    }
    line.to_string()
}

/// Знаки с пробелами: Markdown без разметки и без переводов строк (как charCount в Electron-версии).
pub fn count_chars(md: &str) -> usize {
    let normalized = md.replace("\r\n", "\n").replace('\r', "\n");
    let joined: String = normalized
        .split('\n')
        .filter(|l| {
            let t = l.trim();
            let mut cs = t.chars();
            match cs.next() {
                Some(f) if (f == '-' || f == '*' || f == '_') && t.chars().count() >= 3 => !t.chars().all(|c| c == f),
                _ => true,
            }
        })
        .map(strip_line_prefix)
        .collect::<Vec<_>>()
        .join("");
    let cs: Vec<char> = joined.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < cs.len() {
        if cs[i] == '\\' && i + 1 < cs.len() && "*_#>-\\".contains(cs[i + 1]) { out.push(cs[i + 1]); i += 2; continue; }
        out.push(cs[i]);
        i += 1;
    }
    out.chars().filter(|c| *c != '*' && *c != '_').map(|c| c.len_utf16()).sum()
}

/// Слова личного словаря проекта; None, если у проекта своего списка ещё нет.
pub fn project_words(dir: &Path) -> R<Option<Vec<String>>> {
    let meta = load_meta(dir)?;
    Ok(meta.get("words").and_then(|w| w.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()))
}

pub fn set_project_words(dir: &Path, words: &[String]) -> R<Vec<String>> {
    let mut meta = load_meta(dir)?;
    let clean = crate::dict::clean_words(&words.iter().map(|w| Value::String(w.clone())).collect::<Vec<_>>());
    meta.insert("words".into(), json!(clean));
    save_meta(dir, &meta)?;
    Ok(clean)
}

pub fn project_stats(dir: &Path) -> R<Value> {
    let meta = load_meta(dir)?;
    let mut total = 0usize;
    let mut total_chars = 0usize;
    let mut chapters = Vec::new();
    for c in meta["chapters"].as_array().cloned().unwrap_or_default() {
        let id = c["id"].as_str().unwrap_or("");
        let text = read_chapter_lenient(dir, id)?;
        let (w, ch) = (count_words(&text), count_chars(&text));
        total += w;
        total_chars += ch;
        chapters.push(json!({ "id": id, "words": w, "chars": ch }));
    }
    Ok(json!({ "total": total, "totalChars": total_chars, "chapters": chapters }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_like_electron() {
        assert_eq!(count_words("Привет, мир! Что-то 12 и don't"), 6);
        assert_eq!(count_words(""), 0);
        assert_eq!(count_words("a - b"), 2);
    }

    #[test]
    fn chars_like_electron() {
        assert_eq!(count_chars("# Заголовок\n\nТекст *курсив*\n---\n> цитата"), 27);
        assert_eq!(count_chars("a\\*b"), 2); // как в Electron: экранирование снимается, затем убираются знаки разметки
    }

    #[test]
    fn titles_and_ids() {
        assert!(valid_id("abc123"));
        assert!(!valid_id("ABC123"));
        assert!(is_auto_title("Глава 12"));
        assert!(!is_auto_title("Глава"));
        assert_eq!(safe_folder_name("a/b:c").unwrap(), "a-b-c");
        assert_eq!(safe_folder_name("con").unwrap(), "_con");
    }

    #[test]
    fn project_roundtrip_keeps_unknown_fields() {
        let dir = std::env::temp_dir().join(format!("kab-rs-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let proj = create_project(&dir, "Книга", None).unwrap();
        assert_eq!(proj["chapters"].as_array().unwrap().len(), 1);
        let mut meta = load_meta(&dir).unwrap();
        meta.insert("futureField".into(), json!({ "a": 1 }));
        meta.get_mut("chapters").unwrap()[0].as_object_mut().unwrap().insert("future".into(), json!("x"));
        save_meta(&dir, &meta).unwrap();
        let added = add_chapter(&dir, None).unwrap();
        let id = added["id"].as_str().unwrap().to_string();
        write_chapter(&dir, &id, "Текст").unwrap();
        assert_eq!(read_chapter(&dir, &id).unwrap(), "Текст");
        let again = load_meta(&dir).unwrap();
        assert_eq!(again["futureField"]["a"], 1);
        assert_eq!(again["chapters"][0]["future"], "x");
        let after = delete_chapter(&dir, &id).unwrap();
        assert_eq!(after["trash"].as_array().unwrap().len(), 1);
        let tid = after["trash"][0]["tid"].as_str().unwrap().to_string();
        restore_trash(&dir, &tid).unwrap();
        assert_eq!(read_chapter(&dir, &id).unwrap(), "Текст");
        assert_eq!(load_meta(&dir).unwrap()["chapters"].as_array().unwrap().len(), 2);
        let _ = fs::remove_dir_all(&dir);
    }
}

// ---------- карточки персонажей, мест, предметов и заметки ----------

const FIELD_MAX: usize = 500_000;
const SHORT_MAX: usize = 50_000;

fn is_image_name(s: &str) -> bool {
    match s.rsplit_once('.') {
        Some((stem, ext)) => valid_id(stem) && ["png", "jpg", "jpeg", "webp", "gif"].contains(&ext),
        None => false,
    }
}

fn str_cut(v: Option<&Value>, max: usize) -> String {
    let s = match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    };
    s.chars().take(max).collect()
}

fn unique_strings(v: Option<&Value>, max_len: usize, max_count: usize) -> Vec<Value> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    if let Some(Value::Array(arr)) = v {
        for a in arr {
            let s = str_cut(Some(a), max_len).trim().to_string();
            if !s.is_empty() && seen.insert(s.clone()) { out.push(Value::String(s)); }
        }
    }
    out.truncate(max_count);
    out
}

pub fn sanitize_card(raw: &Value) -> R<Value> {
    let o = raw.as_object().ok_or_else(|| "Неверный формат карточки.".to_string())?;
    let fields: Vec<Value> = match o.get("fields") {
        Some(Value::Array(arr)) => arr.iter().take(80).map(|f| {
            let name = str_cut(f.get("name"), 100).trim().to_string();
            json!({ "name": if name.is_empty() { "Поле".to_string() } else { name }, "value": str_cut(f.get("value"), FIELD_MAX) })
        }).collect(),
        _ => Vec::new(),
    };
    let image = match o.get("image") { Some(Value::String(s)) if is_image_name(s) => s.clone(), _ => String::new() };
    let mut card = Map::new();
    card.insert("short".into(), json!(str_cut(o.get("short"), SHORT_MAX)));
    card.insert("aliases".into(), Value::Array(unique_strings(o.get("aliases"), 80, 100)));
    card.insert("ignore".into(), Value::Array(unique_strings(o.get("ignore"), 80, 100)));
    card.insert("image".into(), json!(image));
    card.insert("fields".into(), Value::Array(fields));
    card.insert("protagonist".into(), json!(o.get("protagonist") == Some(&Value::Bool(true))));
    if o.get("inflect") == Some(&Value::Bool(false)) { card.insert("inflect".into(), json!(false)); }
    Ok(Value::Object(card))
}

fn card_text(card: &Value) -> R<String> { serde_json::to_string_pretty(card).map_err(|e| e.to_string()) }

fn empty_card_for(meta: &Map<String, Value>, kind: &str) -> R<Value> {
    let fields: Vec<Value> = meta["templates"].get(kind).and_then(|t| t.as_array()).map(|a| a.iter().map(|n| json!({ "name": n, "value": "" })).collect()).unwrap_or_default();
    sanitize_card(&json!({ "short": "", "aliases": [], "fields": fields }))
}

fn item_index(meta: &Map<String, Value>, kind: &str, id: &str) -> R<usize> {
    let list = kind_info(kind)?.0;
    meta[list].as_array().and_then(|a| a.iter().position(|c| c["id"] == id)).ok_or_else(|| "Запись не найдена в проекте.".to_string())
}

fn list_mut<'a>(meta: &'a mut Map<String, Value>, list: &str) -> &'a mut Vec<Value> {
    meta.get_mut(list).and_then(|c| c.as_array_mut()).expect("списки проверены при чтении")
}

pub fn add_item(dir: &Path, kind: &str, after: Option<&str>) -> R<Value> {
    let (list, _, ext) = kind_info(kind)?;
    let mut meta = load_meta(dir)?;
    let taken: HashSet<String> = meta[list].as_array().map(|a| a.iter().filter_map(|c| c["id"].as_str().map(String::from)).collect()).unwrap_or_default();
    let id = new_id(&taken);
    let content = if ext == "json" { card_text(&empty_card_for(&meta, kind)?)? } else { String::new() };
    write_atomic(&item_file(dir, kind, &id)?, &content)?;
    let mut at = list_mut(&mut meta, list).len();
    if let Some(a) = after.filter(|a| !a.is_empty()) {
        if let Some(i) = list_mut(&mut meta, list).iter().position(|c| c["id"] == a) { at = i + 1; }
    }
    let title = match kind { "character" => "Новый персонаж", "place" => "Новое место", "item" => "Новый предмет", _ => "Новая заметка" };
    list_mut(&mut meta, list).insert(at, json!({ "id": id, "title": title }));
    save_meta(dir, &meta)?;
    Ok(json!({ "project": view(dir, &meta), "id": id }))
}

pub fn rename_item(dir: &Path, kind: &str, id: &str, title: &str) -> R<Value> {
    let list = kind_info(kind)?.0;
    let mut meta = load_meta(dir)?;
    let i = item_index(&meta, kind, id)?;
    let t = clean_title(Some(&json!(title)));
    if !t.is_empty() { list_mut(&mut meta, list)[i]["title"] = json!(t); }
    save_meta(dir, &meta)?;
    Ok(view(dir, &meta))
}

pub fn move_item(dir: &Path, kind: &str, id: &str, new_index: f64) -> R<Value> {
    let list = kind_info(kind)?.0;
    let mut meta = load_meta(dir)?;
    let from = item_index(&meta, kind, id)?;
    let item = list_mut(&mut meta, list).remove(from);
    let n = if new_index.is_finite() { new_index.trunc() as i64 } else { 0 };
    let to = n.clamp(0, list_mut(&mut meta, list).len() as i64) as usize;
    list_mut(&mut meta, list).insert(to, item);
    save_meta(dir, &meta)?;
    Ok(view(dir, &meta))
}

pub fn set_item_icon(dir: &Path, kind: &str, id: &str, icon: Option<&Value>) -> R<Value> {
    let list = kind_info(kind)?.0;
    let mut meta = load_meta(dir)?;
    let i = item_index(&meta, kind, id)?;
    match clean_icon(icon) {
        Some(c) => { list_mut(&mut meta, list)[i]["icon"] = json!(c); }
        None => { if let Some(o) = list_mut(&mut meta, list)[i].as_object_mut() { o.remove("icon"); } }
    }
    save_meta(dir, &meta)?;
    Ok(view(dir, &meta))
}

pub fn delete_item(dir: &Path, kind: &str, id: &str) -> R<Value> {
    let (list, _, ext) = kind_info(kind)?;
    let mut meta = load_meta(dir)?;
    let i = item_index(&meta, kind, id)?;
    let removed = list_mut(&mut meta, list).remove(i);
    let title = removed["title"].as_str().unwrap_or("").to_string();
    let file = move_to_trash(dir, &item_file(dir, kind, id)?, &title, id, ext)?;
    push_trash(&mut meta, kind, &removed, i, &file);
    save_meta(dir, &meta)?;
    Ok(view(dir, &meta))
}

fn read_item_impl(dir: &Path, kind: &str, id: &str, track: bool) -> R<String> {
    let (_, _, ext) = kind_info(kind)?;
    let file = item_file(dir, kind, id)?;
    match fs::read_to_string(&file) {
        Ok(s) => {
            if track {
                crate::syncguard::note_read(&file, &s); // карточку открыли в окне: эту версию защищаем от затирания
            }
            Ok(s)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if ext == "json" { card_text(&sanitize_card(&json!({}))?) } else { Ok(String::new()) }
        }
        Err(e) => Err(format!("Не удалось прочитать запись: {}", e)),
    }
}

/// Чтение карточки или заметки для окна (item:read): запоминаем версию файла для защиты от затирания.
pub fn read_item(dir: &Path, kind: &str, id: &str) -> R<String> {
    read_item_impl(dir, kind, id, true)
}

/// Чтение без запоминания версии для массовых операций (индекс карточек, поиск, замена):
/// они не должны обновлять «известный» хэш, иначе защита не заметит чужую правку открытого файла.
pub fn read_item_lenient(dir: &Path, kind: &str, id: &str) -> R<String> {
    read_item_impl(dir, kind, id, false)
}

pub fn write_item(dir: &Path, kind: &str, id: &str, text: &str) -> R<Value> {
    let (list, _, ext) = kind_info(kind)?;
    let meta = load_meta(dir)?;
    let i = meta[list].as_array().and_then(|a| a.iter().position(|c| c["id"] == id)).ok_or_else(|| "Запись не найдена в проекте.".to_string())?;
    let title = meta[list][i]["title"].as_str().unwrap_or("").to_string();
    let out = if ext == "json" {
        let parsed: Value = serde_json::from_str(text).map_err(|_| "Карточка имеет неверный формат.".to_string())?;
        card_text(&sanitize_card(&parsed)?)?
    } else { text.to_string() };
    let file = item_file(dir, kind, id)?;
    // Файл изменили снаружи: чужую версию сохраняем в «Конфликты», потом пишем свою.
    let _guard = sync_save_lock().lock().map_err(|_| "Внутренний замок сохранения недоступен.".to_string())?;
    let conflict = crate::syncguard::guard_write(dir, &file, &out, &title)?;
    write_atomic(&file, &out)?;
    Ok(json!({ "conflict": conflict }))
}

pub fn set_template(dir: &Path, kind: &str, names: Option<&Value>) -> R<Value> {
    if kind != "character" && kind != "place" { return Err("Неизвестный шаблон.".into()); }
    let mut meta = load_meta(dir)?;
    let clean = clean_template(names).ok_or_else(|| "Шаблон должен быть списком названий полей.".to_string())?;
    meta["templates"].as_object().ok_or("Внутренняя ошибка шаблонов.")?;
    if let Some(Value::Object(t)) = meta.get_mut("templates") { t.insert(kind.to_string(), Value::Array(clean)); }
    save_meta(dir, &meta)?;
    Ok(view(dir, &meta))
}

/// Индекс карточек для подсветки имён в тексте. Падежные формы (`forms`) считаются здесь, на Rust.
pub fn card_index(dir: &Path) -> R<Value> {
    let meta = load_meta(dir)?;
    let mut out = Vec::new();
    for kind in ["character", "place", "item"] {
        let list = kind_info(kind)?.0;
        for item in meta[list].as_array().cloned().unwrap_or_default() {
            let id = item["id"].as_str().unwrap_or("");
            let card = read_item_lenient(dir, kind, id).ok()
                .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                .and_then(|v| sanitize_card(&v).ok())
                .unwrap_or_else(|| sanitize_card(&json!({})).unwrap_or(Value::Null));
            let mut short = card["short"].as_str().unwrap_or("").trim().to_string();
            if short.is_empty() {
                for f in card["fields"].as_array().cloned().unwrap_or_default() {
                    let n = f["name"].as_str().unwrap_or("").trim().to_lowercase();
                    let v = f["value"].as_str().unwrap_or("").trim().to_string();
                    if (n == "общее описание" || n == "general description") && !v.is_empty() { short = v; break; }
                }
            }
            let title = item["title"].as_str().unwrap_or("").to_string();
            let aliases: Vec<String> = card["aliases"].as_array()
                .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                .unwrap_or_default();
            let inflect = card.get("inflect") != Some(&Value::Bool(false));
            let decl_kind = if kind == "item" { "place" } else { kind };
            let forms = if inflect { crate::declension::name_forms(&title, &aliases, decl_kind) } else { Vec::new() };
            out.push(json!({
                "kind": kind, "id": id, "title": item["title"], "icon": item.get("icon").cloned().unwrap_or_else(|| json!("")),
                "short": short.chars().take(400).collect::<String>(),
                "aliases": card["aliases"], "ignore": card["ignore"], "image": card["image"],
                "protagonist": card["protagonist"], "inflect": inflect,
                "forms": forms,
            }));
        }
    }
    Ok(Value::Array(out))
}

// ---------- настройки проекта и данные главы ----------

pub fn set_project_goal(dir: &Path, goal: Option<&Value>) -> R<Value> {
    let mut meta = load_meta(dir)?;
    match clean_goal(goal) { Some(g) => { meta.insert("projectGoal".into(), json!(g)); } None => { meta.remove("projectGoal"); } }
    save_meta(dir, &meta)?;
    Ok(view(dir, &meta))
}

pub fn set_project_deadline(dir: &Path, date: Option<&Value>) -> R<Value> {
    let mut meta = load_meta(dir)?;
    match clean_deadline(date) { Some(d) => { meta.insert("deadline".into(), json!(d)); } None => { meta.remove("deadline"); } }
    save_meta(dir, &meta)?;
    Ok(view(dir, &meta))
}

/// Исключения подсветки «Не отмечать здесь»: { adv, passive, long, repeat, filler } — ключи в нижнем регистре, «ё» как «е».
pub fn set_analysis_skip(dir: &Path, raw: &Value) -> R<Value> {
    let mut meta = load_meta(dir)?;
    let mut skip = Map::new();
    if let Some(obj) = raw.as_object() {
        for cat in ["adv", "passive", "long", "repeat", "filler"] {
            let Some(list) = obj.get(cat).and_then(|v| v.as_array()) else { continue };
            let mut seen = HashSet::new();
            let mut out: Vec<String> = vec![];
            for x in list {
                let Some(t) = x.as_str() else { continue };
                let low = t.to_lowercase().replace('ё', "е");
                let squeezed = low.split(|c: char| c.is_whitespace() || c == '\u{a0}').filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" ");
                let units: Vec<u16> = squeezed.encode_utf16().take(160).collect();
                let key = String::from_utf16_lossy(&units).trim().to_string();
                if !key.is_empty() && seen.insert(key.clone()) { out.push(key); }
            }
            out.truncate(300);
            if !out.is_empty() { skip.insert(cat.into(), json!(out)); }
        }
    }
    if skip.is_empty() { meta.remove("analysisSkip"); } else { meta.insert("analysisSkip".into(), Value::Object(skip)); }
    save_meta(dir, &meta)?;
    Ok(view(dir, &meta))
}

/// Копирует выбранную картинку в папку «Картинки» проекта, возвращает имя файла.
pub fn add_image(dir: &Path, src: &Path) -> R<String> {
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if !["png", "jpg", "jpeg", "webp", "gif"].contains(&ext.as_str()) { return Err("Поддерживаются картинки png, jpg, webp и gif.".into()); }
    let bytes = fs::read(src).map_err(|e| e.to_string())?;
    if bytes.len() > 10 * 1024 * 1024 { return Err("Картинка слишком большая (больше 10 МБ).".into()); }
    let folder = dir.join("Картинки");
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let taken: HashSet<String> = fs::read_dir(&folder).map(|rd| rd.filter_map(|e| e.ok())
        .filter_map(|e| e.path().file_stem().map(|s| s.to_string_lossy().to_string())).collect()).unwrap_or_default();
    let file = format!("{}.{}", new_id(&taken), if ext == "jpeg" { "jpg" } else { &ext });
    write_atomic_bytes(&folder.join(&file), &bytes)?;
    Ok(file)
}

pub fn set_project_mode(dir: &Path, mode: Option<&str>) -> R<Value> {
    let mut meta = load_meta(dir)?;
    if mode == Some("stories") { meta.insert("mode".into(), json!("stories")); } else { meta.remove("mode"); }
    renumber(&mut meta);
    save_meta(dir, &meta)?;
    Ok(view(dir, &meta))
}

pub fn set_goal_unit(dir: &Path, unit: Option<&str>) -> R<Value> {
    let mut meta = load_meta(dir)?;
    if meta.get("mode").and_then(|m| m.as_str()) == Some("stories") {
        meta.insert("goalUnit".into(), json!(if unit == Some("words") { "words" } else { "chars" }));
    }
    save_meta(dir, &meta)?;
    Ok(view(dir, &meta))
}

pub fn set_char_limit(dir: &Path, limit: Option<&Value>) -> R<Value> {
    let mut meta = load_meta(dir)?;
    if meta.get("mode").and_then(|m| m.as_str()) == Some("stories") {
        match clean_goal(limit) { Some(g) => { meta.insert("charLimit".into(), json!(g)); } None => { meta.remove("charLimit"); } }
        save_meta(dir, &meta)?;
    }
    Ok(view(dir, &meta))
}

pub fn read_chapter_meta(dir: &Path, id: &str) -> R<Value> {
    let meta = load_meta(dir)?;
    let c = &meta["chapters"][find_index(&meta, id)?];
    let mut out = Map::new();
    out.insert("synopsis".into(), json!(c.get("synopsis").and_then(|s| s.as_str()).unwrap_or("")));
    out.insert("notes".into(), json!(c.get("notes").and_then(|s| s.as_str()).unwrap_or("")));
    if let Some(cm) = c.get("comments") { out.insert("comments".into(), cm.clone()); }
    Ok(Value::Object(out))
}

pub fn write_chapter_meta(dir: &Path, id: &str, data: &Value) -> R<Value> {
    let d = data.as_object().ok_or_else(|| "Неверные данные главы.".to_string())?;
    let mut meta = load_meta(dir)?;
    let i = find_index(&meta, id)?;
    let has_comments = d.get("comments").map(|c| c.is_array()).unwrap_or(false);
    let c = chapters_mut(&mut meta)[i].as_object_mut().ok_or("Внутренняя ошибка главы.")?;
    if d.contains_key("synopsis") || d.contains_key("notes") || !has_comments {
        let synopsis = str_cut(d.get("synopsis"), SYNOPSIS_MAX);
        let notes = str_cut(d.get("notes"), NOTES_MAX);
        if synopsis.is_empty() { c.remove("synopsis"); } else { c.insert("synopsis".into(), json!(synopsis)); }
        if notes.is_empty() { c.remove("notes"); } else { c.insert("notes".into(), json!(notes)); }
    }
    if has_comments {
        let comments = clean_comments(d.get("comments"));
        if comments.is_empty() { c.remove("comments"); } else { c.insert("comments".into(), Value::Array(comments)); }
    }
    save_meta(dir, &meta)?;
    Ok(json!(true))
}

pub fn board_data(dir: &Path) -> R<Value> {
    let meta = load_meta(dir)?;
    let mut out = Vec::new();
    for c in meta["chapters"].as_array().cloned().unwrap_or_default() {
        let words = count_words(&read_chapter_lenient(dir, c["id"].as_str().unwrap_or(""))?);
        out.push(json!({
            "id": c["id"], "title": c["title"], "marker": c.get("marker").cloned().unwrap_or(Value::Null),
            "synopsis": c.get("synopsis").cloned().unwrap_or_else(|| json!("")), "words": words,
        }));
    }
    Ok(Value::Array(out))
}

/// Картинка карточки в виде data: URL (окно показывает её без доступа к файлам).
pub fn read_image(dir: &Path, file: &str) -> R<Value> {
    if !is_image_name(file) { return Err("Неверное имя картинки.".into()); }
    let bytes = fs::read(dir.join("Картинки").join(file)).map_err(|_| "Картинка не найдена.".to_string())?;
    let ext = file.rsplit('.').next().unwrap_or("png");
    let mime = match ext { "jpg" | "jpeg" => "image/jpeg", "webp" => "image/webp", "gif" => "image/gif", _ => "image/png" };
    Ok(json!(format!("data:{};base64,{}", mime, base64(&bytes))))
}

fn base64(data: &[u8]) -> String {
    use ::base64::Engine as _;
    ::base64::engine::general_purpose::STANDARD.encode(data)
}

#[cfg(test)]
mod meta_race_tests {
    use super::*;
    use crate::foldersync::FolderSync;
    use crate::remote::{Item, Remote};
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc, Barrier};
    use std::thread;
    use std::time::Duration;

    const LOCAL_TITLE: &str = "Локальное переименование во время синхронизации";
    const CLOUD_TITLE: &str = "Переименование с другого устройства";
    const LOCAL_GOAL: i64 = 123;
    /// Таймаут — страховка от бесконечного зависания, а не доказательство порядка.
    /// Порядок доказывается каналами/барьерами и контрольным чтением файла между шагами.
    const TIMEOUT: Duration = Duration::from_secs(10);

    struct TempProject(PathBuf);

    impl TempProject {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "kabinet-meta-race-{}-{:016x}",
                std::process::id(),
                rand::random::<u64>()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempProject {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Подставная папка. Для проверок правила (B2–B4) в ней есть точки прохода:
    /// `wait_on_read_project` — проход ждёт здесь, пока локальная команда не завершится;
    /// `signal_on_write_chapter` — проход сообщает здесь, что project.json уже записан.
    #[derive(Default)]
    struct HookRemote {
        files: BTreeMap<String, Vec<u8>>,
        wait_on_read_project: Option<Arc<Barrier>>,
        wait_fired: bool,
        signal_on_write_chapter: Option<Arc<Barrier>>,
        signal_fired: bool,
    }

    impl Remote for HookRemote {
        fn list(&mut self, rel: &str) -> R<Vec<Item>> {
            let prefix = if rel.is_empty() { String::new() } else { format!("{rel}/") };
            let mut entries = BTreeMap::new();
            for (path, bytes) in &self.files {
                let Some(tail) = path.strip_prefix(&prefix) else { continue };
                if tail.is_empty() {
                    continue;
                }
                let (name, dir) = match tail.split_once('/') {
                    Some((name, _)) => (name, true),
                    None => (tail, false),
                };
                entries.entry(name.to_string()).or_insert_with(|| Item {
                    name: name.to_string(),
                    dir,
                    size: if dir { -1 } else { bytes.len() as i64 },
                    mtime: 0,
                });
            }
            Ok(entries.into_values().collect())
        }

        fn read(&mut self, rel: &str) -> R<Option<Vec<u8>>> {
            if rel == "project.json" {
                if let Some(barrier) = self.wait_on_read_project.take() {
                    self.wait_fired = true;
                    barrier.wait();
                }
            }
            Ok(self.files.get(rel).cloned())
        }

        fn write(&mut self, rel: &str, bytes: &[u8]) -> R<()> {
            if rel.starts_with("Главы/") {
                if let Some(barrier) = self.signal_on_write_chapter.take() {
                    self.signal_fired = true;
                    barrier.wait();
                }
            }
            self.files.insert(rel.to_string(), bytes.to_vec());
            Ok(())
        }

        fn remove(&mut self, rel: &str) -> R<()> {
            self.files.remove(rel);
            Ok(())
        }

        fn mkdir(&mut self, _rel: &str) -> R<()> {
            Ok(())
        }
    }

    fn remote_meta(remote: &HookRemote) -> Value {
        serde_json::from_slice(remote.files.get("project.json").unwrap()).unwrap()
    }

    fn conflicts_text(dir: &Path) -> Vec<String> {
        fs::read_dir(dir.join("Конфликты"))
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .filter_map(|e| fs::read_to_string(e.path()).ok())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Проект с одной главой, выгруженный в подставную папку.
    fn setup(remote: HookRemote) -> (TempProject, String, FolderSync<HookRemote>) {
        let project = TempProject::new();
        let view = create_project(&project.0, "Meta race", None).unwrap();
        let first = view["chapters"][0]["id"].as_str().unwrap().to_string();
        write_chapter(&project.0, &first, "base first chapter").unwrap();
        let mut sync = FolderSync::new(&project.0, remote, None);
        sync.export_all().unwrap();
        (project, first, sync)
    }

    /// Облако переименовало первую главу.
    fn cloud_rename(sync: &mut FolderSync<HookRemote>) {
        let mut cloud = remote_meta(&sync.remote);
        cloud["chapters"][0]["title"] = json!(CLOUD_TITLE);
        let bytes = serde_json::to_vec_pretty(&cloud).unwrap();
        sync.remote.files.insert("project.json".into(), bytes);
    }

    /// ОСНОВНАЯ РЕГРЕССИЯ (красная на текущем коде, зелёная после lock-based исправления).
    /// Настоящая команда `rename_chapter` читает мету, проход скачивает облачный project.json,
    /// затем команда сохраняет прочитанную ранее устаревшую копию. Это НЕ безопасная
    /// последовательная правка: облачная версия обязана остаться доступной.
    #[test]
    fn real_rename_during_sync_keeps_both_versions() {
        let (project, first, mut sync) = setup(HookRemote::default());
        cloud_rename(&mut sync);

        let (loaded_tx, loaded_rx) = mpsc::channel::<()>();
        let (resume_tx, resume_rx) = mpsc::channel::<()>();
        let (done_tx, done_rx) = mpsc::channel::<()>();
        let fired = Arc::new(AtomicBool::new(false));

        let dir = project.0.clone();
        let first2 = first.clone();
        let f = fired.clone();
        let command = thread::spawn(move || {
            // Точка между чтением меты и её сохранением. Замка sync_save_lock команда здесь НЕ держит.
            meta_hook::set(move || {
                f.store(true, Ordering::SeqCst);
                loaded_tx.send(()).expect("тест: канал loaded недоступен");
                resume_rx
                    .recv_timeout(TIMEOUT)
                    .expect("тест: локальная команда ждала разрешения дольше таймаута");
            });
            let result = rename_chapter(&dir, &first2, LOCAL_TITLE);
            done_tx.send(()).ok();
            result.unwrap();
        });

        // 1) дождаться, что команда прочитала мету (иначе — понятная ошибка, а не зависание)
        loaded_rx
            .recv_timeout(TIMEOUT)
            .expect("тест: локальная команда не прочитала мету вовремя");
        // 2) пока команда ждёт, проход скачивает облачный project.json
        sync.sync().unwrap();
        // 3) доказательство порядка: на диске уже облачная версия, а команда ещё не сохранила
        assert_eq!(
            load_meta(&project.0).unwrap()["chapters"][0]["title"],
            CLOUD_TITLE,
            "проход должен записать облачную версию до сохранения локальной команды"
        );
        // 4) отпустить сохранение
        resume_tx.send(()).expect("тест: канал resume недоступен");
        // 5) дождаться завершения команды
        done_rx
            .recv_timeout(TIMEOUT)
            .expect("тест: локальная команда не завершилась вовремя");
        command.join().unwrap();

        assert!(fired.load(Ordering::SeqCst), "тестовая точка не сработала");

        // СОХРАННОСТЬ: своя правка в живой мете, облачная версия доступна в «Конфликты»
        let local = load_meta(&project.0).unwrap();
        assert_eq!(
            local["chapters"][0]["title"], LOCAL_TITLE,
            "локальная правка должна остаться в живой мете"
        );
        assert!(
            conflicts_text(&project.0).iter().any(|t| t.contains(CLOUD_TITLE)),
            "облачная версия не должна теряться молча (ожидается копия в «Конфликты»)"
        );

        // 2-й проход: ничего не теряется
        sync.sync().unwrap();
        let local2 = load_meta(&project.0).unwrap();
        assert_eq!(local2["chapters"][0]["title"], LOCAL_TITLE);
        assert!(conflicts_text(&project.0).iter().any(|t| t.contains(CLOUD_TITLE)));
    }

    /// ПРАВИЛО (разные поля, порядок «локальная команда раньше прохода»): обе стороны изменились
    /// с момента прошлой синхронизации → конфликт; своя правка в живой мете, облачная версия целиком
    /// доступна в «Конфликты»; второй проход ничего не теряет.
    #[test]
    fn goal_before_pass_keeps_cloud_title_in_conflicts() {
        let barrier = Arc::new(Barrier::new(2));
        let mut remote = HookRemote::default();
        remote.wait_on_read_project = Some(barrier.clone());
        let (project, first, mut sync) = setup(remote);
        cloud_rename(&mut sync);
        let finished = Arc::new(AtomicBool::new(false));

        let dir = project.0.clone();
        let first2 = first.clone();
        let b = barrier.clone();
        let f = finished.clone();
        let command = thread::spawn(move || {
            set_chapter_goal(&dir, &first2, Some(&json!(LOCAL_GOAL))).unwrap();
            b.wait();
            f.store(true, Ordering::SeqCst);
        });
        sync.sync().unwrap();
        command.join().unwrap();

        assert!(sync.remote.wait_fired, "точка ожидания прохода не сработала");
        assert!(finished.load(Ordering::SeqCst), "локальная команда не завершилась");

        let local = load_meta(&project.0).unwrap();
        assert_eq!(local["chapters"][0]["goal"], json!(LOCAL_GOAL), "локальная правка другого поля не применилась");
        assert_ne!(local["chapters"][0]["title"], CLOUD_TITLE, "облачный title не должен молча попасть в живую мету");
        assert!(
            conflicts_text(&project.0).iter().any(|t| t.contains(CLOUD_TITLE)),
            "облачная версия должна оставаться доступной в «Конфликты»"
        );

        sync.sync().unwrap();
        let local2 = load_meta(&project.0).unwrap();
        assert_eq!(local2["chapters"][0]["goal"], json!(LOCAL_GOAL));
        assert!(conflicts_text(&project.0).iter().any(|t| t.contains(CLOUD_TITLE)));
        assert_eq!(remote_meta(&sync.remote)["chapters"][0]["title"], local2["chapters"][0]["title"]);
    }

    /// ПРАВИЛО (одно поле, порядок «локальная команда раньше прохода»): обе версии поля остаются
    /// доступными — своя в живой мете, чужая в «Конфликты».
    #[test]
    fn rename_before_pass_keeps_both_titles_accessible() {
        let barrier = Arc::new(Barrier::new(2));
        let mut remote = HookRemote::default();
        remote.wait_on_read_project = Some(barrier.clone());
        let (project, first, mut sync) = setup(remote);
        cloud_rename(&mut sync);

        let dir = project.0.clone();
        let first2 = first.clone();
        let b = barrier.clone();
        let command = thread::spawn(move || {
            rename_chapter(&dir, &first2, LOCAL_TITLE).unwrap();
            b.wait();
        });
        sync.sync().unwrap();
        command.join().unwrap();

        assert!(sync.remote.wait_fired, "точка ожидания прохода не сработала");
        let local = load_meta(&project.0).unwrap();
        assert_eq!(local["chapters"][0]["title"], LOCAL_TITLE, "своя версия остаётся в живой мете");
        assert!(
            conflicts_text(&project.0).iter().any(|t| t.contains(CLOUD_TITLE)),
            "чужая версия того же поля должна оставаться доступной в «Конфликты»"
        );

        sync.sync().unwrap();
        assert_eq!(load_meta(&project.0).unwrap()["chapters"][0]["title"], LOCAL_TITLE);
        assert!(conflicts_text(&project.0).iter().any(|t| t.contains(CLOUD_TITLE)));
    }

    /// ПРАВИЛО (разные поля, безопасная последовательная правка): команда читает УЖЕ актуальную
    /// (скачанную) мету и сохраняет обе правки. Здесь нет конфликта и нет потери.
    #[test]
    fn goal_after_pull_keeps_cloud_title() {
        let barrier = Arc::new(Barrier::new(2));
        let (project, first, mut sync) = setup(HookRemote::default());
        // взводим сигнал ПОСЛЕ export_all, иначе барьер сработает на выгрузке проекта
        sync.remote.signal_on_write_chapter = Some(barrier.clone());
        cloud_rename(&mut sync);
        write_chapter(&project.0, &first, "local chapter edit").unwrap(); // push главы после project.json

        let dir = project.0.clone();
        let first2 = first.clone();
        let b = barrier.clone();
        let command = thread::spawn(move || {
            b.wait(); // ждём, пока проход запишет облачный project.json
            set_chapter_goal(&dir, &first2, Some(&json!(LOCAL_GOAL))).unwrap();
        });
        let mut sync = thread::spawn(move || {
            sync.sync().unwrap();
            sync
        })
        .join()
        .unwrap();
        command.join().unwrap();

        assert!(sync.remote.signal_fired, "точка сигнала прохода не сработала");
        let local = load_meta(&project.0).unwrap();
        assert_eq!(local["chapters"][0]["title"], CLOUD_TITLE, "облачная правка другого поля должна примениться");
        assert_eq!(local["chapters"][0]["goal"], json!(LOCAL_GOAL), "локальная правка после pull должна примениться");

        sync.sync().unwrap();
        let local2 = load_meta(&project.0).unwrap();
        assert_eq!(local2["chapters"][0]["title"], CLOUD_TITLE);
        assert_eq!(remote_meta(&sync.remote)["chapters"][0]["title"], CLOUD_TITLE);
        assert_eq!(remote_meta(&sync.remote)["chapters"][0]["goal"], json!(LOCAL_GOAL));
    }
}
