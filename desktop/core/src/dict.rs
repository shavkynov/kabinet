//! Личный словарь («В словарь» при проверке текста). Порт src/dict.js.
//! Слова лежат в project.json проекта и переезжают вместе с ним; общий список в check.json остаётся запасным.
use serde_json::Value;
use std::collections::{BTreeSet, HashSet};

pub const MAX_WORDS: usize = 5000;
pub const MAX_LEN: usize = 80;

const ADJ_PLURAL_SKIP: [&str; 9] = ["ая", "яя", "ое", "ее", "ые", "ие", "ый", "ой", "ий"];

fn is_cyr_word(w: &str) -> bool {
    !w.is_empty() && w.chars().all(|c| matches!(c, 'а'..='я' | 'А'..='Я' | 'ё' | 'Ё'))
}

fn push_unique_form(out: &mut Vec<String>, seen: &mut HashSet<String>, form: &str) {
    let trimmed = form.trim();
    if trimmed.is_empty() {
        return;
    }
    let key = trimmed.to_lowercase();
    if seen.insert(key) {
        out.push(trimmed.to_string());
    }
    if trimmed.contains('ё') || trimmed.contains('Ё') {
        let e = trimmed.replace('ё', "е").replace('Ё', "Е");
        let e_key = e.to_lowercase();
        if seen.insert(e_key) {
            out.push(e);
        }
    }
}

/// Расширяет пользовательский словарь («Мой словарь») падежными и множественными формами слов.
pub fn expand_words(words: &[String]) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::with_capacity(words.len() * 8);
    let mut out: Vec<String> = Vec::with_capacity(words.len() * 6);

    for raw in words {
        let w = raw.trim();
        if w.is_empty() {
            continue;
        }
        push_unique_form(&mut out, &mut seen, w);
        for form in crate::declension::case_forms(w, "place") {
            push_unique_form(&mut out, &mut seen, &form);
        }

        let char_len = w.chars().count();
        if char_len < 4 || !is_cyr_word(w) || w == w.to_uppercase() {
            continue;
        }
        let low = w.to_lowercase();
        if ADJ_PLURAL_SKIP.iter().any(|s| low.ends_with(s)) {
            continue;
        }
        let stem: String = w.chars().take(char_len - 1).collect();
        let last = low.chars().last().unwrap();
        if "бвгджзклмнпрстфхцчшщ".contains(last) {
            let nom_sfx = if "гкхжчшщ".contains(last) { "и" } else { "ы" };
            let gen_sfx = if "жчшщ".contains(last) { "ей" } else { "ов" };
            for sfx in [nom_sfx, gen_sfx, "ам", "ами", "ах"] {
                push_unique_form(&mut out, &mut seen, &format!("{w}{sfx}"));
            }
        } else {
            let suffixes: &[&str] = match last {
                'а' | 'о' => &["ам", "ами", "ах"],
                'я' | 'е' => &["ям", "ями", "ях"],
                'ь' => &["ей", "ям", "ями", "ях"],
                'й' => &["ев", "ям", "ями", "ях"],
                _ => &[],
            };
            for sfx in suffixes {
                push_unique_form(&mut out, &mut seen, &format!("{stem}{sfx}"));
            }
        }
    }
    out
}

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

    #[test]
    fn expands_dictionary_with_cases_and_plurals() {
        let lower_set = |ws: Vec<String>| ws.into_iter().map(|w| w.to_lowercase()).collect::<BTreeSet<_>>();

        let a = lower_set(expand_words(&v(&["астралит"])));
        for expected in ["астралит", "астралита", "астралиту", "астралитом", "астралите", "астралиты", "астралитов", "астралитам", "астралитами", "астралитах"] {
            assert!(a.contains(expected), "не хватило формы {expected}: {:?}", a);
        }

        let e = lower_set(expand_words(&v(&["эльфийка"])));
        for expected in ["эльфийка", "эльфийки", "эльфийке", "эльфийку", "эльфийкой", "эльфийкам", "эльфийками", "эльфийках"] {
            assert!(e.contains(expected), "не хватило формы {expected}: {:?}", e);
        }

        let z = lower_set(expand_words(&v(&["зазеркалье"])));
        for expected in ["зазеркалье", "зазеркалья", "зазеркалью", "зазеркальем", "зазеркальям", "зазеркальях"] {
            assert!(z.contains(expected), "не хватило формы {expected}: {:?}", z);
        }

        assert_eq!(expand_words(&v(&["Ли", "Мэри", "API"])), v(&["Ли", "Мэри", "API"]));
    }
}
