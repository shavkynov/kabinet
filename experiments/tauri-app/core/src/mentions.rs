//! Где встречается карточка: в каких главах и сколько раз. Порт src/mentions.js.
//! Правила те же, что у подсветки имён: название и «Имена в тексте», без учёта регистра,
//! слово целиком, слова из «Не считать ссылкой» пропускаются.

use crate::namematch;
use crate::store;
use crate::store::R;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::Path;

/// Явные имена: название карточки и «Имена в тексте», без «не считать ссылкой», в нижнем регистре.
fn names_of(card: &Value) -> Vec<String> {
    let ignore: BTreeSet<String> = card["ignore"]
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.trim().to_lowercase())).collect())
        .unwrap_or_default();
    let mut names: Vec<String> = vec![card["title"].as_str().unwrap_or("").to_string()];
    if let Some(a) = card["aliases"].as_array() {
        names.extend(a.iter().filter_map(|x| x.as_str().map(String::from)));
    }
    let mut out: Vec<String> = Vec::new();
    let mut seen = BTreeSet::new();
    for name in names {
        let key = name.trim().to_lowercase();
        if key.chars().count() >= 2 && !ignore.contains(&key) && seen.insert(key.clone()) {
            out.push(key);
        }
    }
    out
}

/// Падежные формы (как в подсветке): не перекрывают явные имена, учитывают «не считать ссылкой»;
/// форма с большой буквы считается только с большой буквы в тексте, чтобы «Веру» не путалось с «веру».
fn generated_of(card: &Value, explicit: &[String]) -> (Vec<String>, BTreeSet<String>) {
    if card.get("inflect") == Some(&Value::Bool(false)) {
        return (Vec::new(), BTreeSet::new());
    }
    let ignore: BTreeSet<String> = card["ignore"]
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.trim().to_lowercase())).collect())
        .unwrap_or_default();
    let mut keys: Vec<String> = Vec::new();
    let mut cap_keys: BTreeSet<String> = BTreeSet::new();
    if let Some(forms) = card["forms"].as_array() {
        for f in forms.iter().filter_map(|x| x.as_str()) {
            let key = f.to_lowercase();
            if key.chars().count() < 2 || ignore.contains(&key) || explicit.contains(&key) {
                continue;
            }
            keys.push(key.clone());
            if namematch::is_capital(f) {
                cap_keys.insert(key);
            }
        }
    }
    (keys, cap_keys)
}

/// Число вхождений набора имён в текст. Пустые совпадения и формы, которые должны быть с большой буквы,
/// но встретились со строчной, не считаются.
pub fn count_in(text: &str, re: &Option<fancy_regex::Regex>, cap_keys: &BTreeSet<String>) -> usize {
    let Some(re) = re else { return 0 };
    let flat = text.replace('\u{a0}', " ");
    let mut n = 0;
    for m in re.find_iter(&flat) {
        let Ok(m) = m else { continue };
        let s = m.as_str();
        if s.is_empty() {
            continue;
        }
        if cap_keys.contains(&s.to_lowercase()) && !namematch::is_capital(s) {
            continue;
        }
        n += 1;
    }
    n
}

/// { protagonist, chapters: [{ id, title, n (номер главы), count }] }. У протагониста список не считаем.
pub fn card_mentions(dir: &Path, kind: &str, id: &str) -> R<Value> {
    let cards = store::card_index(dir)?;
    let card = cards
        .as_array()
        .and_then(|a| a.iter().find(|c| c["kind"] == kind && c["id"] == id))
        .cloned()
        .ok_or_else(|| "Карточка не найдена.".to_string())?;
    if card.get("protagonist") == Some(&Value::Bool(true)) {
        return Ok(json!({ "protagonist": true, "chapters": [] }));
    }
    let explicit = names_of(&card);
    let (keys, cap_keys) = generated_of(&card, &explicit);
    let mut all_keys: Vec<String> = explicit.clone();
    all_keys.extend(keys);
    let re = namematch::name_regex(&all_keys);
    let view = store::open_project(dir)?;
    let mut chapters = Vec::new();
    if let Some(list) = view["chapters"].as_array() {
        for (i, c) in list.iter().enumerate() {
            let cid = c["id"].as_str().unwrap_or("");
            let text = store::read_chapter(dir, cid)?;
            let count = count_in(&text, &re, &cap_keys);
            if count > 0 {
                chapters.push(json!({ "id": cid, "title": c["title"], "n": i + 1, "count": count }));
            }
        }
    }
    Ok(json!({ "protagonist": false, "chapters": chapters }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn mentions_chapters_aliases_ignore_protagonist() {
        let base = std::env::temp_dir().join(format!("kab-men-{}", std::process::id()));
        let dir = base.join("Роман");
        let _ = fs::remove_dir_all(&base);
        let p = store::create_project(&dir, "Роман", None).unwrap();
        let c1 = p["chapters"][0]["id"].as_str().unwrap().to_string();
        let c2 = store::add_chapter(&dir, None).unwrap()["id"].as_str().unwrap().to_string();
        store::add_chapter(&dir, None).unwrap();
        store::write_chapter(&dir, &c1, "Иван пришёл. Ивана не ждали, а Иванов спал.").unwrap();
        store::write_chapter(&dir, &c2, "Только *Иван* и ваня\u{a0}лежали.").unwrap();
        let id = store::add_item(&dir, "character", None).unwrap()["id"].as_str().unwrap().to_string();
        store::rename_item(&dir, "character", &id, "Иван").unwrap();
        store::write_item(&dir, "character", &id, r#"{"aliases":["Ивана","Ваня"],"ignore":["ваня"]}"#).unwrap();

        let r = card_mentions(&dir, "character", &id).unwrap();
        assert_eq!(r["protagonist"], false);
        let got: Vec<(i64, i64)> = r["chapters"].as_array().unwrap().iter()
            .map(|c| (c["n"].as_i64().unwrap(), c["count"].as_i64().unwrap())).collect();
        assert_eq!(got, vec![(1, 2), (2, 1)]);

        store::write_item(&dir, "character", &id, r#"{"aliases":["Ивана"],"protagonist":true}"#).unwrap();
        let r = card_mentions(&dir, "character", &id).unwrap();
        assert_eq!(r["protagonist"], true);
        assert_eq!(r["chapters"].as_array().unwrap().len(), 0);

        let _ = fs::remove_dir_all(&base);
    }
}
