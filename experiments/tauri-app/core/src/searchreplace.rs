//! Поиск и замена по всему проекту: главы, заметки, карточки. Порт src/search.js и src/replace.js.
//! Без учёта регистра; неразрывный пробел считается обычным. Названия глав и карточек при замене не меняются.
use crate::store::{self, R};
use regex::{NoExpand, Regex};
use serde_json::{json, Value};
use std::path::Path;

const MAX_DOCS: usize = 100;
const MAX_SNIPPETS: usize = 4;
const CONTEXT: usize = 48;
const MIN_LEN: usize = 2;
const MAX_LEN: usize = 200;

fn units(s: &str) -> usize { s.encode_utf16().count() }

fn lower_one(c: char) -> char {
    let c = if c == '\u{a0}' { ' ' } else { c };
    let mut it = c.to_lowercase();
    match (it.next(), it.next()) { (Some(l), None) => l, _ => c }
}

fn flat(s: &[char]) -> String {
    let mut out = String::new();
    let mut ws = false;
    for &c in s {
        if c.is_whitespace() { if !ws { out.push(' '); } ws = true; } else { out.push(c); ws = false; }
    }
    out
}

fn card_text(json_text: &str) -> String {
    let Ok(c) = serde_json::from_str::<Value>(json_text) else { return String::new() };
    let s = |v: &Value| v.as_str().unwrap_or("").to_string();
    let mut parts = vec![s(&c["short"])];
    if let Some(a) = c["aliases"].as_array() { parts.extend(a.iter().map(s)); }
    if let Some(f) = c["fields"].as_array() { parts.extend(f.iter().map(|f| format!("{}: {}", s(&f["name"]), s(&f["value"])))); }
    parts.into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join("\n")
}

fn scan(text: &str, q: &[char]) -> (usize, Vec<Value>) {
    let orig: Vec<char> = text.chars().collect();
    let hay: Vec<char> = orig.iter().map(|&c| lower_one(c)).collect();
    let (mut snippets, mut count, mut from) = (Vec::new(), 0usize, 0usize);
    while from + q.len() <= hay.len() {
        let Some(i) = (from..=hay.len() - q.len()).find(|&i| hay[i..i + q.len()] == *q) else { break };
        if snippets.len() < MAX_SNIPPETS {
            snippets.push(json!({
                "n": count,
                "before": flat(&orig[i.saturating_sub(CONTEXT)..i]),
                "match": orig[i..i + q.len()].iter().collect::<String>(),
                "after": flat(&orig[i + q.len()..(i + q.len() + CONTEXT).min(orig.len())]),
            }));
        }
        count += 1;
        from = i + q.len().max(1);
    }
    (count, snippets)
}

pub fn search_project(dir: &Path, query: &str) -> R<Value> {
    let qs = query.replace('\u{a0}', " ");
    let qs = qs.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    let q: Vec<char> = qs.chars().map(lower_one).collect();
    if units(qs) < 2 { return Ok(json!([])); }
    let view = store::open_project(dir)?;
    let mut out: Vec<Value> = Vec::new();
    let qlow: String = q.iter().collect();
    // Порядок прежний: главы, персонажи, места, предметы, заметки.
    // Ограничиваем число найденных документов, а не число просмотренных файлов.
    for (kind, key) in [("chapter", "chapters"), ("character", "characters"), ("place", "places"), ("item", "items"), ("note", "notes")] {
        let list = view[key].as_array().map(Vec::as_slice).unwrap_or(&[]);
        for item in list {
            let id = item["id"].as_str().unwrap_or("");
            let text = match kind {
                "chapter" => store::read_chapter_lenient(dir, id)?,
                "note" => store::read_item(dir, "note", id)?,
                _ => card_text(&store::read_item(dir, kind, id)?),
            };
            let title = item["title"].as_str().unwrap_or("");
            let in_title = title.to_lowercase().contains(&qlow);
            let (count, snippets) = scan(&text, &q);
            if count == 0 && !in_title { continue; }
            out.push(json!({ "kind": kind, "id": item["id"], "title": title,
                "icon": item.get("icon").cloned().filter(|i| !i.is_null()).unwrap_or(Value::Null),
                "count": count, "titleMatch": in_title, "snippets": snippets }));
            if out.len() >= MAX_DOCS { return Ok(Value::Array(out)); }
        }
    }
    Ok(Value::Array(out))
}

fn build_regex(find: &str) -> Regex {
    let q = find.replace('\u{a0}', " ");
    let src = regex::escape(&q).replace(' ', "[ \\x{a0}]");
    Regex::new(&format!("(?i){}", src)).unwrap()
}

/// Заменяет все вхождения в строке. Возвращает (текст, число замен).
pub fn replace_in_text(text: &str, find: &str, repl: &str) -> (String, usize) {
    let re = build_regex(find);
    let count = re.find_iter(text).count();
    (re.replace_all(text, NoExpand(repl)).into_owned(), count)
}

fn replace_in_card(json_text: &str, find: &str, repl: &str) -> (String, usize) {
    let Ok(mut c) = serde_json::from_str::<Value>(json_text) else { return (json_text.to_string(), 0) };
    let mut count = 0;
    let mut one = |v: &Value| -> Value {
        let (t, n) = replace_in_text(v.as_str().unwrap_or(""), find, repl);
        count += n;
        Value::String(t)
    };
    if let Some(o) = c.as_object_mut() {
        let short = one(&o.get("short").cloned().unwrap_or(Value::Null));
        o.insert("short".into(), short);
        if let Some(Value::Array(a)) = o.get_mut("aliases") { for x in a.iter_mut() { *x = one(x); } }
        if let Some(Value::Array(f)) = o.get_mut("fields") {
            for x in f.iter_mut() {
                if let Some(fo) = x.as_object_mut() { let v = one(&fo.get("value").cloned().unwrap_or(Value::Null)); fo.insert("value".into(), v); }
            }
        }
    }
    (serde_json::to_string_pretty(&c).unwrap_or_else(|_| json_text.to_string()), count)
}

/// Замена во всём проекте. dry: ничего не пишет, только считает.
pub fn replace_project(dir: &Path, find: &str, repl: &str, dry: bool) -> R<Value> {
    let q = find.replace('\u{a0}', " ");
    let q = q.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if units(q) < MIN_LEN { return Err("Для замены введите хотя бы два символа.".into()); }
    if units(q) > MAX_LEN || units(repl) > MAX_LEN * 5 { return Err("Слишком длинный текст для замены.".into()); }
    let view = store::open_project(dir)?;
    let mut docs: Vec<Value> = Vec::new();
    let list = |k: &str| view[k].as_array().cloned().unwrap_or_default();
    let mut note = |kind: &str, item: &Value, n: usize| { docs.push(json!({ "kind": kind, "id": item["id"], "title": item["title"], "count": n })); };
    for c in list("chapters") {
        let id = c["id"].as_str().unwrap_or("");
        let (t, n) = replace_in_text(&store::read_chapter_lenient(dir, id)?, q, repl);
        if n == 0 { continue; }
        if !dry { store::write_chapter(dir, id, &t)?; }
        note("chapter", &c, n);
    }
    for (kind, key) in [("character", "characters"), ("place", "places"), ("item", "items")] {
        for c in list(key) {
            let id = c["id"].as_str().unwrap_or("");
            let (t, n) = replace_in_card(&store::read_item(dir, kind, id)?, q, repl);
            if n == 0 { continue; }
            if !dry { store::write_item(dir, kind, id, &t)?; }
            note(kind, &c, n);
        }
    }
    for c in list("notes") {
        let id = c["id"].as_str().unwrap_or("");
        let (t, n) = replace_in_text(&store::read_item(dir, "note", id)?, q, repl);
        if n == 0 { continue; }
        if !dry { store::write_item(dir, "note", id, &t)?; }
        note("note", &c, n);
    }
    let total: u64 = docs.iter().map(|d| d["count"].as_u64().unwrap_or(0)).sum();
    Ok(json!({ "total": total, "docs": docs }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::tmpdir;
    use std::fs;

    fn copy_dir(from: &Path, to: &Path) {
        fs::create_dir_all(to).unwrap();
        for e in fs::read_dir(from).unwrap().flatten() {
            let t = to.join(e.file_name());
            if e.path().is_dir() { copy_dir(&e.path(), &t); } else { fs::copy(e.path(), t).unwrap(); }
        }
    }

    #[test]
    fn matches_electron_search_and_replace() {
        let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/sr");
        let golden: Value = serde_json::from_str(&fs::read_to_string(base.join("golden.json")).unwrap()).unwrap();
        let dir = tmpdir("sr").join("p");
        copy_dir(&base.join("before"), &dir);
        for (q, want) in golden["search"].as_object().unwrap() {
            assert_eq!(search_project(&dir, q).unwrap(), *want, "поиск «{}»", q);
        }
        assert_eq!(replace_project(&dir, "дракон", "змей", true).unwrap(), golden["replace"]["dry"]);
        assert_eq!(replace_project(&dir, "д", "x", false).unwrap_err(), golden["replace"]["err"].as_str().unwrap());
        assert_eq!(replace_project(&dir, "дракон", "$& змей $1", false).unwrap(), golden["replace"]["real"]);
        let after: Value = serde_json::from_str(&fs::read_to_string(base.join("after.json")).unwrap()).unwrap();
        for (rel, want) in after.as_object().unwrap() {
            assert_eq!(fs::read_to_string(dir.join(rel)).unwrap(), want.as_str().unwrap(), "{}", rel);
        }
    }

    #[test]
    fn replacement_is_literal_and_nbsp_matches_space() {
        assert_eq!(replace_in_text("а\u{a0}б а б", "а б", "[$0]"), ("[$0] [$0]".to_string(), 2));
        assert_eq!(replace_in_text("Дракон ДРАКОН", "дракон", "x").1, 2);
    }
}
