//! Где встречается карточка: в каких главах и сколько раз. Порт src/mentions.js.
//! Правила те же, что у подсветки имён: название и «Имена в тексте», без учёта регистра,
//! слово целиком, слова из «Не считать ссылкой» пропускаются.

use crate::namematch;
use crate::store;
use crate::store::R;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::Path;

/// Список карточек в project.json для вида: как kindOf в src/project.js.
fn list_of(kind: &str) -> Option<&'static str> {
    match kind {
        "character" => Some("characters"),
        "place" => Some("places"),
        "item" => Some("items"),
        _ => None,
    }
}

/// Явные имена: название карточки и «Имена в тексте», без «не считать ссылкой», в нижнем регистре.
fn names_of(title: &str, card: &Value) -> Vec<String> {
    let ignore: BTreeSet<String> = card["ignore"]
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.trim().to_lowercase())).collect())
        .unwrap_or_default();
    let mut names: Vec<String> = vec![title.to_string()];
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
/// Формы считаем только для этой карточки, а не для всех: как cardIndex считает их по одной.
/// Предметы склоняются как места — так же, как в src/project.js и подсветке: «кольцо», «кольца», «Кольцом».
fn generated_of(title: &str, card: &Value, explicit: &[String], kind: &str) -> (Vec<String>, BTreeSet<String>) {
    if card.get("inflect") == Some(&Value::Bool(false)) {
        return (Vec::new(), BTreeSet::new());
    }
    let ignore: BTreeSet<String> = card["ignore"]
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.trim().to_lowercase())).collect())
        .unwrap_or_default();
    let aliases: Vec<String> = card["aliases"].as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let decl_kind = if kind == "item" { "place" } else { kind };
    let forms = crate::declension::name_forms(title, &aliases, decl_kind);
    let mut keys: Vec<String> = Vec::new();
    let mut cap_keys: BTreeSet<String> = BTreeSet::new();
    for f in forms.iter() {
        let key = f.to_lowercase();
        if key.chars().count() < 2 || ignore.contains(&key) || explicit.contains(&key) {
            continue;
        }
        keys.push(key.clone());
        if namematch::is_capital(f) {
            cap_keys.insert(key);
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
    // Читаем проект и одну карточку, формы считаем только для неё: card_index здесь не нужен.
    // По замерам автора (release, 301 карточка, 60 глав) значимого ускорения это не дало:
    // около 120–140 мс и до, и после правки. Весь card_index (формы всех карточек) занимает 8–15 мс;
    // основное время уходит на подсчёт регуляркой. JS на том же проекте считает за ~25 мс.
    let meta = store::load_meta(dir)?;
    let list = list_of(kind).ok_or_else(|| "Карточка не найдена.".to_string())?;
    let title = meta[list]
        .as_array()
        .and_then(|a| a.iter().find(|c| c["id"] == id))
        .ok_or_else(|| "Карточка не найдена.".to_string())?["title"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let card = store::read_item_lenient(dir, kind, id).ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| store::sanitize_card(&v).ok())
        .unwrap_or_else(|| store::sanitize_card(&json!({})).unwrap_or(Value::Null));
    if card.get("protagonist") == Some(&Value::Bool(true)) {
        return Ok(json!({ "protagonist": true, "chapters": [] }));
    }
    let explicit = names_of(&title, &card);
    let (keys, cap_keys) = generated_of(&title, &card, &explicit, kind);
    let mut all_keys: Vec<String> = explicit.clone();
    all_keys.extend(keys);
    let re = namematch::name_regex(&all_keys);
    let view = store::view(dir, &meta);
    let mut chapters = Vec::new();
    if let Some(list) = view["chapters"].as_array() {
        for (i, c) in list.iter().enumerate() {
            let cid = c["id"].as_str().unwrap_or("");
            let text = store::read_chapter_lenient(dir, cid)?;
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

    #[test]
    fn mentions_item_declined_like_place() {
        let base = std::env::temp_dir().join(format!("kab-men-item-{}", std::process::id()));
        let dir = base.join("Роман");
        let _ = fs::remove_dir_all(&base);
        let p = store::create_project(&dir, "Роман", None).unwrap();
        let c1 = p["chapters"][0]["id"].as_str().unwrap().to_string();
        store::write_chapter(&dir, &c1, "На столе лежало Кольцо. Блеск кольца привлекал. Кольцом можно было гордиться.").unwrap();
        let id = store::add_item(&dir, "item", None).unwrap()["id"].as_str().unwrap().to_string();
        store::rename_item(&dir, "item", &id, "кольцо").unwrap();
        store::write_item(&dir, "item", &id, "{}").unwrap();

        let r = card_mentions(&dir, "item", &id).unwrap();
        assert_eq!(r["protagonist"], false);
        let got: Vec<(i64, i64)> = r["chapters"].as_array().unwrap().iter()
            .map(|c| (c["n"].as_i64().unwrap(), c["count"].as_i64().unwrap())).collect();
        // Предмет склоняется как место: «Кольцо», «кольца», «Кольцом».
        assert_eq!(got, vec![(1, 3)]);

        let _ = fs::remove_dir_all(&base);
    }

    /// Прежний путь счёта «как в cardIndex»: формы всех карточек берутся из индекса.
    /// Нужен, чтобы сверить счётчики после перехода на расчёт форм одной карточки.
    fn counts_via_card_index(dir: &Path, kind: &str, id: &str) -> Value {
        let cards = store::card_index(dir).unwrap();
        let card = cards.as_array().unwrap().iter().find(|c| c["kind"] == kind && c["id"] == id).unwrap().clone();
        if card.get("protagonist") == Some(&Value::Bool(true)) {
            return json!({ "protagonist": true, "chapters": [] });
        }
        let explicit = names_of(card["title"].as_str().unwrap_or(""), &card);
        let ignore: BTreeSet<String> = card["ignore"].as_array()
            .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.trim().to_lowercase())).collect())
            .unwrap_or_default();
        let mut keys: Vec<String> = explicit.clone();
        let mut cap_keys: BTreeSet<String> = BTreeSet::new();
        for f in card["forms"].as_array().into_iter().flatten().filter_map(|x| x.as_str()) {
            let key = f.to_lowercase();
            if key.chars().count() < 2 || ignore.contains(&key) || explicit.contains(&key) { continue; }
            keys.push(key.clone());
            if namematch::is_capital(f) { cap_keys.insert(key); }
        }
        let re = namematch::name_regex(&keys);
        let view = store::open_project(dir).unwrap();
        let mut chapters = Vec::new();
        for (i, c) in view["chapters"].as_array().unwrap().iter().enumerate() {
            let cid = c["id"].as_str().unwrap_or("");
            let text = store::read_chapter_lenient(dir, cid).unwrap();
            let count = count_in(&text, &re, &cap_keys);
            if count > 0 { chapters.push(json!({ "id": cid, "title": c["title"], "n": i + 1, "count": count })); }
        }
        json!({ "protagonist": false, "chapters": chapters })
    }

    #[test]
    fn counts_stay_the_same_as_the_card_index_path_for_every_card() {
        let base = std::env::temp_dir().join(format!("kab-men-same-{}", std::process::id()));
        let dir = base.join("Роман");
        let _ = fs::remove_dir_all(&base);
        let p = store::create_project(&dir, "Роман", None).unwrap();
        let c1 = p["chapters"][0]["id"].as_str().unwrap().to_string();
        let c2 = store::add_chapter(&dir, None).unwrap()["id"].as_str().unwrap().to_string();
        store::write_chapter(&dir, &c1, "Анна и Аня пришли. Веру видели. На столе лежало Кольцо. Блеск кольца и Кольцом любовались. В Москве тихо.").unwrap();
        store::write_chapter(&dir, &c2, "Анны не было. Веру ждали. Кольцо потеряли. Москва спала.").unwrap();

        let anna = store::add_item(&dir, "character", None).unwrap()["id"].as_str().unwrap().to_string();
        store::rename_item(&dir, "character", &anna, "Анна").unwrap();
        store::write_item(&dir, "character", &anna, r#"{"aliases":["Аня"],"ignore":[]}"#).unwrap();
        let vera = store::add_item(&dir, "character", None).unwrap()["id"].as_str().unwrap().to_string();
        store::rename_item(&dir, "character", &vera, "Вера").unwrap();
        store::write_item(&dir, "character", &vera, r#"{"inflect":false}"#).unwrap();
        let moscow = store::add_item(&dir, "place", None).unwrap()["id"].as_str().unwrap().to_string();
        store::rename_item(&dir, "place", &moscow, "Москва").unwrap();
        store::write_item(&dir, "place", &moscow, "{}").unwrap();
        let ring = store::add_item(&dir, "item", None).unwrap()["id"].as_str().unwrap().to_string();
        store::rename_item(&dir, "item", &ring, "кольцо").unwrap();
        store::write_item(&dir, "item", &ring, r#"{"ignore":["Кольцом"]}"#).unwrap();
        let protagonist = store::add_item(&dir, "character", None).unwrap()["id"].as_str().unwrap().to_string();
        store::rename_item(&dir, "character", &protagonist, "Иван").unwrap();
        store::write_item(&dir, "character", &protagonist, r#"{"protagonist":true}"#).unwrap();

        for (kind, id) in [("character", &anna), ("character", &vera), ("place", &moscow), ("item", &ring), ("character", &protagonist)] {
            let single = card_mentions(&dir, kind, id).unwrap();
            let via_index = counts_via_card_index(dir.as_path(), kind, id);
            assert_eq!(single, via_index, "счётчики разошлись для {} {}", kind, id);
        }
        // заодно: у предмета «кольцо» ровно 3 вхождения, а «Кольцом» исключено как «не считать ссылкой»
        let ring_counts: Vec<i64> = card_mentions(&dir, "item", &ring).unwrap()["chapters"].as_array().unwrap()
            .iter().map(|c| c["count"].as_i64().unwrap()).collect();
        assert_eq!(ring_counts.iter().sum::<i64>(), 3);

        let _ = fs::remove_dir_all(&base);
    }
}
