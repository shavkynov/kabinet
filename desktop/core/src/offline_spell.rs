//! Офлайн-проверка орфографии на основе Hunspell-словарей (крейт `spellbook`).
//! Словари лениво загружаются при первом обращении и автоматически выгружаются из RAM при простое.
//! Позиции замечаний (offset, length) возвращаются строго в единицах UTF-16, как ожидает ProseMirror.

use crate::store::R;
use serde_json::{json, Value};
use spellbook::Dictionary;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const MAX_SUGGESTIONS: usize = 6;
const MAX_UNIQUE_SUGGEST_WORDS: usize = 500;

#[derive(Copy, Clone, Debug, Eq, PartialEq, Hash)]
pub enum DictLang {
    Ru,
    En,
}

struct LoadedDicts {
    ru: Option<Dictionary>,
    en: Option<Dictionary>,
    last_used: Instant,
}

pub struct OfflineSpell {
    dir: PathBuf,
    state: Mutex<Option<LoadedDicts>>,
}

fn dir_has_any_dict(dir: &Path) -> bool {
    (dir.join("ru.dic").is_file() && dir.join("ru.aff").is_file())
        || (dir.join("en.dic").is_file() && dir.join("en.aff").is_file())
}

pub fn resolve_dict_dir(env_override: Option<PathBuf>, data_dir: &Path, resource_dir: Option<&Path>) -> PathBuf {
    if let Some(d) = env_override {
        if dir_has_any_dict(&d) {
            return d;
        }
    }
    if let Some(res) = resource_dir {
        let bundled = res.join("dictionaries");
        if dir_has_any_dict(&bundled) {
            return bundled;
        }
        let nested = res.join("resources").join("dictionaries");
        if dir_has_any_dict(&nested) {
            return nested;
        }
    }
    let user_dir = data_dir.join("dictionaries");
    if dir_has_any_dict(&user_dir) {
        return user_dir;
    }
    if let Some(res) = resource_dir {
        return res.join("dictionaries");
    }
    user_dir
}

fn read_text(path: &Path) -> R<String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("Не удалось прочитать словарь ({}): {}", path.display(), e))?;
    Ok(raw.strip_prefix('\u{feff}').unwrap_or(&raw).to_string())
}

fn load_pair(dir: &Path, code: &str) -> R<Option<Dictionary>> {
    let dic_path = dir.join(format!("{}.dic", code));
    let aff_path = dir.join(format!("{}.aff", code));
    if !dic_path.is_file() || !aff_path.is_file() {
        return Ok(None);
    }
    let aff = read_text(&aff_path)?;
    let dic = read_text(&dic_path)?;
    let dict = Dictionary::new(&aff, &dic)
        .map_err(|e| format!("Не удалось загрузить словарь {}: {:?}", code, e))?;
    Ok(Some(dict))
}

fn is_cyrillic(c: char) -> bool {
    matches!(c, 'а'..='я' | 'А'..='Я' | 'ё' | 'Ё' | '\u{0400}'..='\u{04FF}')
}

fn is_word_body(c: char) -> bool {
    c.is_alphanumeric() || is_cyrillic(c)
}

fn is_apostrophe(c: char) -> bool {
    c == '\'' || c == '\u{2019}'
}

fn yo_to_e(s: &str) -> String {
    if !s.contains(['ё', 'Ё']) {
        return s.to_string();
    }
    s.chars()
        .map(|c| match c {
            'ё' => 'е',
            'Ё' => 'Е',
            other => other,
        })
        .collect()
}

fn is_roman_numeral(s: &str) -> bool {
    let n = s.chars().count();
    (2..=12).contains(&n) && s.chars().all(|c| matches!(c, 'I' | 'V' | 'X' | 'L' | 'C' | 'D' | 'M'))
}

fn is_short_all_caps(s: &str) -> bool {
    let mut letters = 0usize;
    for c in s.chars() {
        if c == '-' {
            continue;
        }
        if !c.is_alphabetic() || !c.is_uppercase() {
            return false;
        }
        letters += 1;
    }
    (2..=5).contains(&letters)
}

fn is_russian_hyphen_particle(lower: &str) -> bool {
    matches!(
        lower,
        "то" | "либо"
            | "нибудь"
            | "таки"
            | "ка"
            | "де"
            | "с"
            | "кое"
            | "кой"
            | "по"
            | "во"
            | "в"
            | "из"
            | "под"
            | "над"
            | "от"
            | "до"
            | "за"
            | "на"
            | "об"
            | "со"
    )
}

fn check_single_word(dict: &Dictionary, lang: DictLang, word: &str, custom: &HashSet<String>) -> bool {
    let norm_apos: String = word.chars().map(|c| if c == '\u{2019}' { '\'' } else { c }).collect();
    let lower = norm_apos.to_lowercase();
    let e_lower = yo_to_e(&lower);
    if custom.contains(&lower) || custom.contains(&e_lower) {
        return true;
    }
    if dict.check(&norm_apos) || (lower != norm_apos && dict.check(&lower)) {
        return true;
    }
    if lang == DictLang::Ru && norm_apos.contains(['е', 'Е']) {
        let mut sugg = Vec::new();
        dict.suggest(&lower, &mut sugg);
        if sugg.iter().any(|cand| {
            let cand_lower = cand.to_lowercase();
            cand_lower != lower && yo_to_e(&cand_lower) == e_lower
        }) {
            return true;
        }
    }
    false
}

fn check_token(dict: &Dictionary, lang: DictLang, token: &str, custom: &HashSet<String>) -> bool {
    if check_single_word(dict, lang, token, custom) {
        return true;
    }
    if token.contains('-') {
        let parts: Vec<&str> = token.split('-').filter(|p| !p.is_empty()).collect();
        if parts.len() >= 2 {
            let all_ok = parts.iter().all(|part| {
                let low = part.to_lowercase();
                if lang == DictLang::Ru && is_russian_hyphen_particle(&low) {
                    return true;
                }
                if part.chars().count() >= 2 && check_single_word(dict, lang, part, custom) {
                    return true;
                }
                false
            });
            if all_ok {
                return true;
            }
        }
    }
    false
}

fn build_custom_set(custom_words: &[String]) -> HashSet<String> {
    let mut set = HashSet::with_capacity(custom_words.len() * 2);
    for raw in custom_words {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let lower = trimmed.chars().map(|c| if c == '\u{2019}' { '\'' } else { c }).collect::<String>().to_lowercase();
        let e = yo_to_e(&lower);
        set.insert(lower.clone());
        set.insert(e);
        for part in lower.split(|c: char| c.is_whitespace() || c == '-') {
            if part.chars().count() >= 2 {
                set.insert(part.to_string());
                set.insert(yo_to_e(part));
            }
        }
    }
    set
}

struct TokenSpan<'a> {
    text: &'a str,
    u16_start: usize,
    u16_len: usize,
}

fn tokenize_paragraph(para: &str) -> Vec<TokenSpan<'_>> {
    let chars: Vec<(usize, usize, char)> = {
        let mut v = Vec::new();
        let mut u16 = 0usize;
        for (byte_i, c) in para.char_indices() {
            v.push((byte_i, u16, c));
            u16 += c.len_utf16();
        }
        v
    };
    let mut out = Vec::new();
    let n = chars.len();
    let mut i = 0usize;
    while i < n {
        let (start_byte, start_u16, ch) = chars[i];
        if !ch.is_alphabetic() {
            i += 1;
            continue;
        }
        // Не трогаем URL и адреса электронной почты
        let prev_is_url = i > 0 && matches!(chars[i - 1].2, '@' | '/' | ':');
        let prev_is_domain = i >= 2 && chars[i - 1].2 == '.' && chars[i - 2].2.is_ascii_alphanumeric();
        let mut j = i + 1;
        while j < n {
            let c = chars[j].2;
            if is_word_body(c) {
                j += 1;
            } else if (c == '-' || is_apostrophe(c)) && j + 1 < n && is_word_body(chars[j + 1].2) {
                j += 1;
            } else {
                break;
            }
        }
        let end_byte = if j < n { chars[j].0 } else { para.len() };
        let end_u16 = if j < n { chars[j].1 } else { start_u16 + para[start_byte..].encode_utf16().count() };
        let word = &para[start_byte..end_byte];
        let next_c = if j < n { Some(chars[j].2) } else { None };
        let after_c = if j + 1 < n { Some(chars[j + 1].2) } else { None };
        let next_is_url = matches!(next_c, Some('@') | Some('/'))
            || (next_c == Some(':') && after_c == Some('/'))
            || (next_c == Some('.') && matches!(after_c, Some(ac) if ac.is_ascii_alphanumeric()) && word.is_ascii());

        if !prev_is_url && !prev_is_domain && !next_is_url {
            out.push(TokenSpan {
                text: word,
                u16_start: start_u16,
                u16_len: end_u16 - start_u16,
            });
        }
        i = j;
    }
    out
}

fn token_lang(word: &str, mode: &str) -> Option<DictLang> {
    let mut has_cyr = false;
    let mut has_lat = false;
    for c in word.chars() {
        if is_cyrillic(c) {
            has_cyr = true;
        } else if c.is_ascii_alphabetic() {
            has_lat = true;
        }
    }
    match mode {
        "en" => (has_lat && !has_cyr).then_some(DictLang::En),
        "auto" => {
            if has_cyr {
                Some(DictLang::Ru)
            } else if has_lat {
                Some(DictLang::En)
            } else {
                None
            }
        }
        _ => has_cyr.then_some(DictLang::Ru),
    }
}

impl OfflineSpell {
    pub fn new(dir: PathBuf) -> Self {
        OfflineSpell {
            dir,
            state: Mutex::new(None),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn has_lang(&self, lang: &str) -> bool {
        match lang {
            "en" => self.dir.join("en.dic").is_file() && self.dir.join("en.aff").is_file(),
            "auto" => self.has_lang("ru") || self.has_lang("en"),
            _ => self.dir.join("ru.dic").is_file() && self.dir.join("ru.aff").is_file(),
        }
    }

    pub fn has_any_dict(&self) -> bool {
        dir_has_any_dict(&self.dir)
    }

    pub fn unload_if_idle(&self, max_idle: Duration) -> bool {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let Some(loaded) = guard.as_ref() else {
            return false;
        };
        if loaded.last_used.elapsed() < max_idle {
            return false;
        }
        *guard = None;
        true
    }

    fn ensure_loaded<'a>(&self, guard: &'a mut Option<LoadedDicts>, need_ru: bool, need_en: bool) -> R<&'a mut LoadedDicts> {
        if guard.is_none() {
            *guard = Some(LoadedDicts {
                ru: if need_ru { load_pair(&self.dir, "ru")? } else { None },
                en: if need_en { load_pair(&self.dir, "en")? } else { None },
                last_used: Instant::now(),
            });
        }
        let loaded = guard.as_mut().unwrap();
        if need_ru && loaded.ru.is_none() {
            loaded.ru = load_pair(&self.dir, "ru")?;
        }
        if need_en && loaded.en.is_none() {
            loaded.en = load_pair(&self.dir, "en")?;
        }
        loaded.last_used = Instant::now();
        Ok(loaded)
    }

    /// Быстрая проверка одного слова (запасной вариант для контекстного меню, например на Linux).
    pub fn check_word(&self, word: &str, english: bool) -> Option<(bool, Vec<String>)> {
        let lang = if english { DictLang::En } else { DictLang::Ru };
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let loaded = self.ensure_loaded(&mut guard, lang == DictLang::Ru, lang == DictLang::En).ok()?;
        let dict = match lang {
            DictLang::Ru => loaded.ru.as_ref()?,
            DictLang::En => loaded.en.as_ref()?,
        };
        let empty = HashSet::new();
        if check_token(dict, lang, word.trim(), &empty) {
            return Some((true, Vec::new()));
        }
        let mut raw = Vec::new();
        dict.suggest(word.trim(), &mut raw);
        raw.truncate(MAX_SUGGESTIONS);
        Some((false, raw))
    }

    /// Проверяет массив абзацев и возвращает замечания в том же формате, что LanguageTool.
    pub fn check_paragraphs(
        &self,
        paragraphs: &[String],
        lang: &str,
        custom_words: &[String],
        cancel: &AtomicBool,
        progress: &dyn Fn(usize, usize),
    ) -> R<Vec<Value>> {
        if !self.has_lang(lang) {
            return Err("Встроенные словари орфографии не найдены.".into());
        }
        let custom = build_custom_set(custom_words);
        let need_ru = lang != "en";
        let need_en = lang == "en" || lang == "auto";

        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let loaded = self.ensure_loaded(&mut guard, need_ru, need_en)?;

        let mut word_cache: HashMap<(DictLang, String), bool> = HashMap::with_capacity(4096);
        let mut sugg_cache: HashMap<(DictLang, String), Vec<String>> = HashMap::new();
        let mut out: Vec<Value> = Vec::new();
        let total = paragraphs.len();

        for (para_idx, para) in paragraphs.iter().enumerate() {
            if cancel.load(Ordering::SeqCst) {
                return Err("Проверка остановлена.".into());
            }
            if total > 200 && para_idx % 200 == 0 {
                progress(para_idx, total);
            }
            if para.trim().is_empty() {
                continue;
            }
            for tok in tokenize_paragraph(para) {
                if tok.text.chars().count() < 2
                    || tok.text.chars().any(|c| c.is_ascii_digit())
                    || is_roman_numeral(tok.text)
                    || is_short_all_caps(tok.text)
                {
                    continue;
                }
                let Some(tlang) = token_lang(tok.text, lang) else {
                    continue;
                };
                let dict = match tlang {
                    DictLang::Ru => match loaded.ru.as_ref() {
                        Some(d) => d,
                        None => continue,
                    },
                    DictLang::En => match loaded.en.as_ref() {
                        Some(d) => d,
                        None => continue,
                    },
                };

                let cache_key = (tlang, tok.text.to_string());
                let ok = if let Some(&v) = word_cache.get(&cache_key) {
                    v
                } else {
                    let v = check_token(dict, tlang, tok.text, &custom);
                    word_cache.insert(cache_key.clone(), v);
                    v
                };
                if ok {
                    continue;
                }

                let replacements = if let Some(s) = sugg_cache.get(&cache_key) {
                    s.clone()
                } else if sugg_cache.len() < MAX_UNIQUE_SUGGEST_WORDS {
                    let mut raw = Vec::new();
                    dict.suggest(tok.text, &mut raw);
                    let mut clean = Vec::with_capacity(MAX_SUGGESTIONS);
                    for cand in raw {
                        if cand != tok.text && !clean.contains(&cand) {
                            clean.push(cand);
                            if clean.len() >= MAX_SUGGESTIONS {
                                break;
                            }
                        }
                    }
                    sugg_cache.insert(cache_key, clean.clone());
                    clean
                } else {
                    Vec::new()
                };

                out.push(json!({
                    "para": para_idx,
                    "offset": tok.u16_start,
                    "length": tok.u16_len,
                    "text": tok.text,
                    "message": "Возможная орфографическая ошибка.",
                    "short": "Орфография",
                    "ruleId": "OFFLINE_SPELL",
                    "kind": "spelling",
                    "replacements": replacements,
                }));
            }
        }

        loaded.last_used = Instant::now();
        progress(total, total);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::tmpdir;

    fn write_mini_ru_dict(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join("ru.aff"),
            "SET UTF-8\nTRY еиаостнрвклмпдуяьыбгзчйжхшюцщэфъё\nSFX A Y 1\nSFX A 0 а .\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("ru.dic"),
            "7\nпривет\nмир/A\nзеленый\nчёрный\nкто-то\nдом/A\nмашина\n",
        )
        .unwrap();
    }

    #[test]
    fn offline_spell_checks_utf16_custom_yo_and_unloads() {
        let tmp = tmpdir("offline-spell");
        let res = tmp.join("res");
        let dicts = res.join("dictionaries");
        write_mini_ru_dict(&dicts);

        let resolved = resolve_dict_dir(None, &tmp.join("data"), Some(&res));
        assert_eq!(resolved, dicts);

        let svc = OfflineSpell::new(resolved);
        assert!(svc.has_any_dict());
        assert!(svc.has_lang("ru"));
        assert!(!svc.has_lang("en"));

        let custom = vec!["Дракон".to_string(), "Илья Муромец".to_string()];
        let paras = vec![
            "😀 Првиет черный мир! Илья кто-то дом https://example.com/првиет".to_string(),
            "Дракон зеленый v2 СССР.".to_string(),
        ];
        let cancel = AtomicBool::new(false);
        let issues = svc.check_paragraphs(&paras, "ru", &custom, &cancel, &|_, _| {}).unwrap();
        assert_eq!(issues.len(), 1, "должна остаться только опечатка Првиет: {:?}", issues);
        assert_eq!(issues[0]["text"], json!("Првиет"));
        assert_eq!(issues[0]["para"], json!(0));
        // "😀 " занимает 2 (сурогатная пара) + 1 = 3 UTF-16 code units
        assert_eq!(issues[0]["offset"], json!(3));
        assert_eq!(issues[0]["length"], json!(6));
        assert_eq!(issues[0]["kind"], json!("spelling"));

        // Выгрузка при простое срабатывает корректно
        assert!(!svc.unload_if_idle(Duration::from_secs(60)));
        assert!(svc.unload_if_idle(Duration::from_secs(0)));
        assert!(!svc.unload_if_idle(Duration::from_secs(0)));
    }

    #[test]
    fn offline_spell_respects_cancel() {
        let tmp = tmpdir("offline-spell-cancel");
        write_mini_ru_dict(&tmp);
        let svc = OfflineSpell::new(tmp);
        let cancel = AtomicBool::new(true);
        let res = svc.check_paragraphs(&["Првиет".to_string()], "ru", &[], &cancel, &|_, _| {});
        assert!(res.is_err());
    }
}
