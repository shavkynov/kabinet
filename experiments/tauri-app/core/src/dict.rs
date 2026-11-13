//! Личный словарь («В словарь» при проверке текста). Порт src/dict.js.
//! Слова лежат в project.json проекта и переезжают вместе с ним; общий список в check.json остаётся запасным.
use serde_json::Value;
use std::collections::BTreeSet;

pub const MAX_WORDS: usize = 5000;
pub const MAX_LEN: usize = 80;

/// Строки без пробелов по краям, без пустых и повторов, не длиннее MAX_LEN, не больше MAX_WORDS.
pub fn clean_words(raw: &[Value]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for x in raw {
        let w = x.as_str().map(|s| s.trim().to_string()).unwrap_or_default();
        if w.is_empty() || w.encode_utf16().count() > MAX_LEN || w.chars().any(|c| (c as u32) < 0x20) || !seen.insert(w.clone()) { continue; }
        out.push(w);
        if out.len() >= MAX_WORDS { break; }
    }
    out
}

fn clean_strs(raw: &[String]) -> Vec<String> { clean_words(&raw.iter().map(|w| Value::String(w.clone())).collect::<Vec<_>>()) }

/// Какой словарь действует: список проекта, если он есть (даже пустой), иначе общий.
pub fn effective(project: Option<&[String]>, shared: &[String]) -> Vec<String> {
    match project { Some(p) => p.to_vec(), None => clean_strs(shared) }
}

/// Список проекта после добавления слова; если у проекта списка не было, он начинается с общего словаря.
pub fn with_word(project: Option<&[String]>, shared: &[String], word: &str) -> Vec<String> {
    let mut v = effective(project, shared);
    v.push(word.to_string());
    clean_strs(&v)
}

/// Общий список после правки словаря проекта: убранные слова уходят, добавленные появляются.
pub fn merge_shared(shared: &[String], before: &[String], next: &[String]) -> Vec<String> {
    let mut v: Vec<String> = clean_strs(shared).into_iter().filter(|w| !(before.contains(w) && !next.contains(w))).collect();
    v.extend(next.iter().filter(|w| !before.contains(w)).cloned());
    clean_strs(&v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> { a.iter().map(|s| s.to_string()).collect() }

    #[test]
    fn cleaning_and_merging() {
        assert_eq!(clean_strs(&v(&[" а ", "", "а", "б", "x\u{1}y"])), v(&["а", "б"]));
        assert_eq!(clean_strs(&[&"я".repeat(81)[..]].map(String::from)).len(), 0);
        assert_eq!(effective(Some(&v(&[])), &v(&["общее"])), Vec::<String>::new());
        assert_eq!(effective(None, &v(&["общее"])), v(&["общее"]));
        assert_eq!(with_word(None, &v(&["а"]), "б"), v(&["а", "б"]));
        assert_eq!(merge_shared(&v(&["а", "б", "в"]), &v(&["а", "б"]), &v(&["б", "г"])), v(&["б", "в", "г"]));
    }
}
