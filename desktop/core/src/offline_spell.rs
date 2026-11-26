//! Офлайн-проверка орфографии на основе Hunspell-словарей (крейт `spellbook`).
//! Словари лениво загружаются при первом обращении и автоматически выгружаются из RAM при простое.
//! Позиции замечаний (offset, length) возвращаются строго в единицах UTF-16, как ожидает ProseMirror.

use crate::offline_spell_extra;
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
const MAX_SLOW_SUGGEST_WORDS: usize = 25;
const RU_SUGGEST_ALPHA: &str = "оеёаинтсрвлкмдпуяыьгзбчйхжшюцщэфъ";
const EN_SUGGEST_ALPHA: &str = "etaoinshrdlcumwfgypbvkjxqz";

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

fn is_russian_hyphen_prefix(lower: &str) -> bool {
    matches!(
        lower,
        "пол" | "полу"
            | "мини"
            | "макси"
            | "супер"
            | "мега"
            | "экс"
            | "вице"
            | "интернет"
            | "онлайн"
            | "офлайн"
            | "видео"
            | "аудио"
            | "фото"
            | "веб"
            | "пресс"
            | "бизнес"
            | "арт"
            | "топ"
            | "кибер"
            | "био"
            | "эко"
            | "квази"
            | "псевдо"
            | "анти"
            | "контр"
            | "темно"
            | "тёмно"
            | "светло"
            | "ярко"
            | "бледно"
            | "густо"
            | "серо"
            | "красно"
            | "бело"
            | "черно"
            | "чёрно"
            | "сине"
            | "зелено"
            | "зелёно"
            | "желто"
            | "жёлто"
            | "золотисто"
            | "серебристо"
            | "тускло"
            | "мутно"
            | "нежно"
            | "иссиня"
            | "изжелта"
    )
}

fn check_ru_dict_or_yo(dict: &Dictionary, orig: &str, lower: &str) -> bool {
    if offline_spell_extra::contains(lower) {
        return true;
    }
    if dict.check(orig) || (lower != orig && dict.check(lower)) {
        return true;
    }
    if !lower.contains('е') {
        return false;
    }
    let mut chars: Vec<char> = lower.chars().collect();
    let e_pos: Vec<usize> = chars
        .iter()
        .enumerate()
        .filter_map(|(idx, &c)| (c == 'е').then_some(idx))
        .collect();
    // Быстрый прямой перебор 1 и 2 подстановок «е → ё» через dict.check() вместо медленного dict.suggest().
    for &p in &e_pos {
        chars[p] = 'ё';
        let cand: String = chars.iter().collect();
        chars[p] = 'е';
        if offline_spell_extra::contains(&cand) || dict.check(&cand) {
            return true;
        }
    }
    if e_pos.len() <= 4 && e_pos.len() >= 2 {
        for a in 0..e_pos.len() {
            for b in (a + 1)..e_pos.len() {
                chars[e_pos[a]] = 'ё';
                chars[e_pos[b]] = 'ё';
                let cand: String = chars.iter().collect();
                chars[e_pos[a]] = 'е';
                chars[e_pos[b]] = 'е';
                if offline_spell_extra::contains(&cand) || dict.check(&cand) {
                    return true;
                }
            }
        }
    }
    false
}

fn check_ru_morphology(dict: &Dictionary, lower: &str) -> bool {
    let char_len = lower.chars().count();
    // 1. Литературный вариант «-нье/-нья/-нью/-ньем/-ньи» ↔ «-ние/-ния/-нию/-нием/-нии».
    if char_len >= 6 {
        for (from, to) in [
            ("нье", "ние"),
            ("нья", "ния"),
            ("нью", "нию"),
            ("ньем", "нием"),
            ("ньи", "нии"),
        ] {
            if let Some(stem) = lower.strip_suffix(from) {
                if !stem.is_empty() {
                    let alt = format!("{}{}", stem, to);
                    if check_ru_dict_or_yo(dict, &alt, &alt) {
                        return true;
                    }
                }
                break;
            }
        }
    }
    // 2. Литературные деепричастия «-вши» / «-вшись».
    if char_len >= 6 {
        if let Some(stem) = lower.strip_suffix("вши") {
            let v_form = format!("{}в", stem);
            let vshiy = format!("{}вший", stem);
            if check_ru_dict_or_yo(dict, &v_form, &v_form)
                || check_ru_dict_or_yo(dict, &vshiy, &vshiy)
            {
                return true;
            }
        }
    }
    if char_len >= 7 {
        if let Some(stem) = lower.strip_suffix("вшись") {
            let vsh = format!("{}вшийся", stem);
            if check_ru_dict_or_yo(dict, &vsh, &vsh) {
                return true;
            }
        }
    }
    // 3. Продуктивные префиксы «полу-», «свеже-» и «пол-» при слитном написании.
    if char_len >= 8 {
        for pref in ["полу", "свеже"] {
            if let Some(rest) = lower.strip_prefix(pref) {
                if rest.chars().count() >= 4 && check_ru_dict_or_yo(dict, rest, rest) {
                    return true;
                }
            }
        }
    }
    if char_len >= 7 {
        if let Some(rest) = lower.strip_prefix("пол") {
            if rest.chars().count() >= 4
                && matches!(
                    rest.chars().next(),
                    Some(c) if c != 'л' && !matches!(c, 'а' | 'е' | 'ё' | 'и' | 'о' | 'у' | 'ы' | 'э' | 'ю' | 'я')
                )
                && check_ru_dict_or_yo(dict, rest, rest)
            {
                return true;
            }
        }
    }
    false
}

fn format_like_source(source: &str, cand_lower: &str) -> String {
    let mut has_alpha = false;
    let mut all_upper = true;
    for c in source.chars() {
        if c.is_alphabetic() {
            has_alpha = true;
            if !c.is_uppercase() {
                all_upper = false;
                break;
            }
        }
    }
    if has_alpha && all_upper {
        return cand_lower.to_uppercase();
    }
    if matches!(source.chars().next(), Some(c) if c.is_uppercase()) {
        let mut chars = cand_lower.chars();
        if let Some(first) = chars.next() {
            let mut out: String = first.to_uppercase().collect();
            out.push_str(chars.as_str());
            return out;
        }
    }
    cand_lower.to_string()
}

fn dict_has_candidate(dict: &Dictionary, lang: DictLang, cand_lower: &str, source_upper: bool) -> bool {
    match lang {
        DictLang::Ru => {
            if offline_spell_extra::contains(cand_lower) || dict.check(cand_lower) {
                return true;
            }
            if source_upper {
                let titled = format_like_source("А", cand_lower);
                if dict.check(&titled) {
                    return true;
                }
            }
            false
        }
        DictLang::En => {
            if dict.check(cand_lower) {
                return true;
            }
            if source_upper {
                let titled = format_like_source("A", cand_lower);
                if dict.check(&titled) {
                    return true;
                }
            }
            false
        }
    }
}

fn push_suggest_candidate(
    dict: &Dictionary,
    lang: DictLang,
    source: &str,
    source_upper: bool,
    cand_lower: &str,
    out: &mut Vec<String>,
) -> bool {
    if !dict_has_candidate(dict, lang, cand_lower, source_upper) {
        return false;
    }
    let formatted = format_like_source(source, cand_lower);
    if formatted != source && !out.contains(&formatted) {
        out.push(formatted);
    }
    out.len() >= MAX_SUGGESTIONS
}

fn fast_suggest(dict: &Dictionary, lang: DictLang, word: &str) -> Vec<String> {
    let norm_apos: String = word.chars().map(|c| if c == '\u{2019}' { '\'' } else { c }).collect();
    let lower = norm_apos.to_lowercase();
    let chars: Vec<char> = lower.chars().collect();
    let n = chars.len();
    if n < 2 || n > 40 {
        return Vec::new();
    }
    let source_upper = matches!(word.chars().next(), Some(c) if c.is_uppercase());
    let alpha = match lang {
        DictLang::Ru => RU_SUGGEST_ALPHA,
        DictLang::En => EN_SUGGEST_ALPHA,
    };
    let mut out = Vec::with_capacity(MAX_SUGGESTIONS);
    let mut buf = chars.clone();

    // 1. Перестановки двух соседних букв.
    for i in 0..(n - 1) {
        if buf[i] == buf[i + 1] {
            continue;
        }
        buf.swap(i, i + 1);
        let cand: String = buf.iter().collect();
        buf.swap(i, i + 1);
        if push_suggest_candidate(dict, lang, word, source_upper, &cand, &mut out) {
            return out;
        }
    }

    // 2. Удаление одной буквы.
    for i in 0..n {
        if i > 0 && chars[i] == chars[i - 1] {
            continue;
        }
        let mut cand = String::with_capacity(lower.len());
        for (idx, &c) in chars.iter().enumerate() {
            if idx != i {
                cand.push(c);
            }
        }
        if push_suggest_candidate(dict, lang, word, source_upper, &cand, &mut out) {
            return out;
        }
    }

    // 3. Вставка одной буквы.
    for i in 0..=n {
        for ch in alpha.chars() {
            if i < n && chars[i] == ch {
                continue;
            }
            let mut cand = String::with_capacity(lower.len() + ch.len_utf8());
            for &c in &chars[..i] {
                cand.push(c);
            }
            cand.push(ch);
            for &c in &chars[i..] {
                cand.push(c);
            }
            if push_suggest_candidate(dict, lang, word, source_upper, &cand, &mut out) {
                return out;
            }
        }
    }

    // 4. Замена одной буквы.
    for i in 0..n {
        let orig_c = buf[i];
        for ch in alpha.chars() {
            if ch == orig_c {
                continue;
            }
            buf[i] = ch;
            let cand: String = buf.iter().collect();
            if push_suggest_candidate(dict, lang, word, source_upper, &cand, &mut out) {
                return out;
            }
        }
        buf[i] = orig_c;
    }

    // 5. Разбиение пробелом на два отдельных слова.
    if n >= 4 {
        for i in 2..=(n - 2) {
            let left: String = chars[..i].iter().collect();
            let right: String = chars[i..].iter().collect();
            if dict_has_candidate(dict, lang, &left, source_upper)
                && dict_has_candidate(dict, lang, &right, false)
            {
                let formatted = format!("{} {}", format_like_source(word, &left), right);
                if !out.contains(&formatted) {
                    out.push(formatted);
                    if out.len() >= MAX_SUGGESTIONS {
                        return out;
                    }
                }
            }
        }
    }

    out
}

fn is_mid_sentence_proper(para: &str, byte_start: usize, token: &str) -> bool {
    let Some(first) = token.chars().next() else {
        return false;
    };
    if !first.is_uppercase() || !token.chars().any(|c| c.is_lowercase()) {
        return false;
    }
    let before = para[..byte_start].trim_end_matches(|c: char| {
        c.is_whitespace() || matches!(c, '«' | '„' | '“' | '"' | '\'' | '(' | '—' | '–' | '-')
    });
    if before.is_empty() {
        return false;
    }
    !matches!(before.chars().last(), Some('.' | '!' | '?' | '…' | ':'))
}

fn is_known_abbreviation(lower: &str) -> bool {
    matches!(
        lower,
        "dr" | "mr" | "mrs" | "ms" | "prof" | "st" | "vs" | "etc" | "eg" | "ie" | "jr" | "sr"
            | "inc" | "ltd" | "corp" | "fig" | "no" | "vol" | "ch" | "pp" | "ed" | "eds" | "al"
            | "jan" | "feb" | "mar" | "apr" | "jun" | "jul" | "aug" | "sep" | "sept" | "oct"
            | "nov" | "dec" | "др" | "пр" | "см" | "ср" | "напр" | "стр" | "ст" | "рис" | "табл"
            | "гл" | "разд" | "им" | "ул" | "пер" | "пр-т" | "просп" | "пл" | "наб" | "бул"
            | "обл" | "р-н" | "пос" | "дер" | "гор" | "тыс" | "млн" | "млрд" | "руб" | "коп"
            | "долл" | "экз" | "шт" | "кг" | "гг" | "вв" | "нэ" | "доц" | "проф" | "акад"
            | "инж" | "тов" | "гр" | "тел" | "факс" | "кв" | "корп" | "эт" | "оф" | "мин"
            | "сек" | "час" | "суб" | "вс" | "пн" | "вт" | "чт" | "пт" | "сб" | "янв" | "фев"
            | "мар" | "апр" | "июн" | "июл" | "авг" | "сен" | "сент" | "окт" | "ноя" | "дек"
            | "изд" | "ред" | "сост" | "прим" | "лат" | "греч" | "англ" | "нем" | "фр" | "рус"
            | "устар" | "разг" | "книжн" | "перен"
    )
}

fn ends_with_sentence_punct(s: &str) -> bool {
    let trimmed = s.trim_end_matches(|c: char| matches!(c, '»' | '”' | '’' | '"' | '\''));
    if matches!(trimmed.chars().last(), Some(')' | ']')) {
        return false;
    }
    if trimmed.ends_with('…') || trimmed.ends_with("..") {
        return false;
    }
    let Some(last) = trimmed.chars().last() else {
        return false;
    };
    if matches!(last, '!' | '?') {
        return true;
    }
    if last != '.' {
        return false;
    }
    let before_dot = &trimmed[..trimmed.len() - '.'.len_utf8()];
    if matches!(before_dot.chars().last(), Some(c) if c.is_ascii_digit()) {
        return false;
    }
    let word: String = before_dot
        .chars()
        .rev()
        .take_while(|c| c.is_alphabetic() || *c == '-')
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let count = word.chars().count();
    if count <= 1 {
        return false;
    }
    !is_known_abbreviation(&word.to_lowercase())
}

fn is_sentence_start(para: &str, byte_start: usize) -> bool {
    let raw = &para[..byte_start];
    let after_open = raw.trim_end_matches(|c: char| {
        c.is_whitespace() || matches!(c, '«' | '„' | '“' | '‘' | '"' | '\'' | '(' | '[')
    });
    if after_open.ends_with('…') || after_open.ends_with("..") {
        return false;
    }

    // Если в начале абзаца только пробелы, открывающие кавычки/скобки и маркеры списка или тире.
    let head_check = after_open.trim_end_matches(|c: char| {
        c.is_whitespace() || matches!(c, '—' | '–' | '-' | '•' | '*')
    });
    if head_check.is_empty() {
        return !para.trim_end().ends_with(';');
    }

    // Внутри абзаца граница предложения всегда отделена пробелом до открывающих кавычек/тире.
    let had_dash_before_tok = {
        let trimmed = after_open.trim_end_matches(|c: char| matches!(c, '—' | '–'));
        trimmed.len() < after_open.len() && trimmed.chars().last().map(|c| c.is_whitespace()).unwrap_or(false)
    };
    if !raw.chars().last().map(|c| c.is_whitespace() || matches!(c, '«' | '„' | '“' | '‘' | '"' | '\'' | '(' | '[' | '—' | '–' | '-')).unwrap_or(false) {
        return false;
    }

    if had_dash_before_tok {
        let before_dash = after_open.trim_end_matches(|c: char| c.is_whitespace() || matches!(c, '—' | '–'));
        let before_dash_clean = before_dash.trim_end_matches(|c: char| matches!(c, '»' | '”' | '’' | '"' | '\''));
        if matches!(before_dash_clean.chars().last(), Some('!' | '?' | '…')) || before_dash_clean.ends_with("..") {
            return false;
        }
        return ends_with_sentence_punct(before_dash);
    }

    let had_ws_before_open = raw[after_open.len()..].chars().any(|c| c.is_whitespace())
        || after_open.len() == raw.len();
    let _ = had_ws_before_open;
    if raw[after_open.len()..].chars().next().map(|c| !c.is_whitespace() && matches!(c, '«' | '„' | '“' | '‘' | '"' | '\'' | '(' | '[')).unwrap_or(false)
        && !after_open.chars().last().map(|c| c.is_whitespace()).unwrap_or(false)
    {
        return false;
    }
    if !raw[after_open.len()..].chars().any(|c| c.is_whitespace())
        && !after_open.chars().last().map(|c| c.is_whitespace()).unwrap_or(false)
    {
        return false;
    }
    ends_with_sentence_punct(after_open)
}

fn capitalize_first(word: &str) -> String {
    let mut chars = word.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    let mut out: String = first.to_uppercase().collect();
    out.push_str(chars.as_str());
    out
}

fn check_single_word(dict: &Dictionary, lang: DictLang, word: &str, custom: &HashSet<String>) -> bool {
    let norm_apos: String = word.chars().map(|c| if c == '\u{2019}' { '\'' } else { c }).collect();
    let lower = norm_apos.to_lowercase();
    let e_lower = yo_to_e(&lower);
    if custom.contains(&lower) || custom.contains(&e_lower) {
        return true;
    }
    match lang {
        DictLang::Ru => check_ru_dict_or_yo(dict, &norm_apos, &lower) || check_ru_morphology(dict, &lower),
        DictLang::En => dict.check(&norm_apos) || (lower != norm_apos && dict.check(&lower)),
    }
}

fn check_token(dict: &Dictionary, lang: DictLang, token: &str, custom: &HashSet<String>) -> bool {
    if check_single_word(dict, lang, token, custom) {
        return true;
    }
    if token.contains('-') {
        let parts: Vec<&str> = token.split('-').filter(|p| !p.is_empty()).collect();
        if parts.len() >= 2 {
            let all_ok = parts.iter().enumerate().all(|(idx, part)| {
                let low = part.to_lowercase();
                if lang == DictLang::Ru
                    && (is_russian_hyphen_particle(&low)
                        || (idx + 1 < parts.len() && is_russian_hyphen_prefix(&low)))
                {
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
    byte_start: usize,
    byte_end: usize,
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
                byte_start: start_byte,
                byte_end: end_byte,
                u16_start: start_u16,
                u16_len: end_u16 - start_u16,
            });
        }
        i = j;
    }
    out
}

fn is_allowed_repeat(lower: &str) -> bool {
    matches!(
        lower,
        "ха" | "хи" | "хе" | "хо" | "ах" | "ох" | "эх" | "ух" | "ой" | "ай"
            | "ну" | "да" | "нет" | "так" | "вот" | "тук" | "тик" | "топ" | "кап"
            | "бум" | "бам" | "дзинь" | "мяу" | "гав" | "ку" | "чу" | "тсс" | "ля"
            | "бом" | "динь" | "дон" | "чик" | "пых" | "хлоп" | "стук" | "кря" | "ква"
            | "угу" | "ага" | "ha" | "he" | "hi" | "ho" | "la" | "na" | "oh" | "ah"
            | "uh" | "no" | "yes" | "blah" | "bla" | "had" | "that"
    )
}

fn push_unpaired(out: &mut Vec<Value>, para: usize, offset: usize, text: &str, short: &str, message: &str) {
    out.push(json!({
        "para": para,
        "offset": offset,
        "length": text.encode_utf16().count(),
        "text": text,
        "message": message,
        "short": short,
        "ruleId": "OFFLINE_UNPAIRED_PUNCT",
        "kind": "punctuation",
        "replacements": [],
    }));
}

fn check_paragraph_punctuation(
    para_idx: usize,
    para: &str,
    lang: &str,
    open_guillemet: &mut Option<(usize, usize)>,
    out: &mut Vec<Value>,
) {
    let mut paren_stack: Vec<usize> = Vec::new();
    let mut g_stack: Vec<usize> = Vec::new();
    let mut nested_stack: Vec<usize> = Vec::new();
    let check_nested = lang != "en" && para.contains('„');
    let mut u16_pos = 0usize;
    let mut prev_ch: Option<char> = None;
    let lead_g_byte = open_guillemet
        .is_some()
        .then(|| {
            let trimmed = para.trim_start();
            trimmed.starts_with('«').then_some(para.len() - trimmed.len())
        })
        .flatten();

    for (byte_i, ch) in para.char_indices() {
        let prefix = &para[..byte_i];
        let is_emoticon = matches!(prev_ch, Some(':' | ';' | '='))
            || (prev_ch == Some('-')
                && matches!(prefix[..prefix.len().saturating_sub(1)].chars().last(), Some(':' | ';')));

        match ch {
            '(' if !is_emoticon => paren_stack.push(u16_pos),
            ')' if !is_emoticon => {
                let trim_pref = prefix.trim_start();
                let list_marker = paren_stack.is_empty()
                    && (1..=2).contains(&trim_pref.chars().count())
                    && (trim_pref.chars().all(|c| c.is_ascii_digit())
                        || (trim_pref.chars().count() == 1 && trim_pref.chars().all(|c| c.is_alphabetic())));
                if !list_marker && paren_stack.pop().is_none() {
                    push_unpaired(out, para_idx, u16_pos, ")", "Непарная скобка", "Лишняя закрывающая скобка.");
                }
            }
            '«' => {
                if Some(byte_i) != lead_g_byte {
                    g_stack.push(u16_pos);
                }
            }
            '»' => {
                if g_stack.pop().is_none() && open_guillemet.take().is_none() {
                    push_unpaired(out, para_idx, u16_pos, "»", "Непарная кавычка", "Лишняя закрывающая кавычка.");
                }
            }
            '„' if check_nested => nested_stack.push(u16_pos),
            '“' if check_nested => {
                let _ = nested_stack.pop();
            }
            _ => {}
        }

        prev_ch = Some(ch);
        u16_pos += ch.len_utf16();
    }

    for pos in paren_stack {
        push_unpaired(out, para_idx, pos, "(", "Непарная скобка", "Незакрытая скобка.");
    }
    for pos in nested_stack {
        push_unpaired(out, para_idx, pos, "„", "Непарная кавычка", "Незакрытая кавычка.");
    }

    if g_stack.len() >= 2 {
        for &pos in &g_stack[..g_stack.len() - 1] {
            push_unpaired(out, para_idx, pos, "«", "Непарная кавычка", "Незакрытая кавычка.");
        }
    }
    if let Some(last_pos) = g_stack.pop() {
        if let Some((old_p, old_pos)) = open_guillemet.replace((para_idx, last_pos)) {
            push_unpaired(out, old_p, old_pos, "«", "Непарная кавычка", "Незакрытая кавычка.");
        }
    }
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
        let trimmed = word.trim();
        if check_token(dict, lang, trimmed, &empty) {
            return Some((true, Vec::new()));
        }
        let fast = fast_suggest(dict, lang, trimmed);
        if !fast.is_empty() {
            return Some((false, fast));
        }
        let mut raw = Vec::new();
        dict.suggest(trimmed, &mut raw);
        raw.truncate(MAX_SUGGESTIONS);
        Some((false, raw))
    }

    /// Подбор вариантов исправления для одного слова (включая полный slow `suggest` по запросу автора).
    pub fn suggest_word(&self, word: &str, lang: &str) -> R<Vec<String>> {
        let trimmed = word.trim();
        if trimmed.is_empty() || trimmed.encode_utf16().count() > 80 {
            return Ok(Vec::new());
        }
        let Some(tlang) = token_lang(trimmed, lang) else {
            return Ok(Vec::new());
        };
        let need_ru = tlang == DictLang::Ru;
        let need_en = tlang == DictLang::En;
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let loaded = self.ensure_loaded(&mut guard, need_ru, need_en)?;
        let dict = match tlang {
            DictLang::Ru => loaded.ru.as_ref(),
            DictLang::En => loaded.en.as_ref(),
        };
        let Some(dict) = dict else {
            return Ok(Vec::new());
        };
        let mut out = fast_suggest(dict, tlang, trimmed);
        if out.len() < MAX_SUGGESTIONS {
            let mut raw = Vec::new();
            dict.suggest(trimmed, &mut raw);
            for cand in raw {
                if cand != trimmed && !out.contains(&cand) {
                    out.push(cand);
                    if out.len() >= MAX_SUGGESTIONS {
                        break;
                    }
                }
            }
        }
        loaded.last_used = Instant::now();
        Ok(out)
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
        let mut slow_suggest_count = 0usize;
        let mut out: Vec<Value> = Vec::new();
        let total = paragraphs.len();
        let mut open_guillemet: Option<(usize, usize)> = None;

        for (para_idx, para) in paragraphs.iter().enumerate() {
            if cancel.load(Ordering::SeqCst) {
                return Err("Проверка остановлена.".into());
            }
            if total > 200 && para_idx % 200 == 0 {
                progress(para_idx, total);
            }
            if para.trim().is_empty() {
                if let Some((old_p, old_pos)) = open_guillemet.take() {
                    push_unpaired(&mut out, old_p, old_pos, "«", "Непарная кавычка", "Незакрытая кавычка.");
                }
                continue;
            }
            check_paragraph_punctuation(para_idx, para, lang, &mut open_guillemet, &mut out);

            let toks = tokenize_paragraph(para);
            for w in 1..toks.len() {
                let prev = &toks[w - 1];
                let curr = &toks[w];
                let between = &para[prev.byte_end..curr.byte_start];
                if between.is_empty() || !between.chars().all(|c| c.is_whitespace()) {
                    continue;
                }
                if prev.text.chars().any(|c| c.is_ascii_digit()) || curr.text.chars().any(|c| c.is_ascii_digit()) {
                    continue;
                }
                let curr_low = curr.text.to_lowercase();
                if prev.text.to_lowercase() == curr_low && !is_allowed_repeat(&curr_low) {
                    let end_u16 = curr.u16_start + curr.u16_len;
                    out.push(json!({
                        "para": para_idx,
                        "offset": prev.u16_start,
                        "length": end_u16 - prev.u16_start,
                        "text": &para[prev.byte_start..curr.byte_end],
                        "message": "Повтор слова подряд.",
                        "short": "Повтор слова",
                        "ruleId": "OFFLINE_REPEATED_WORD",
                        "kind": "typography",
                        "replacements": [prev.text],
                    }));
                }
            }

            for tok in toks {
                let Some(tlang) = token_lang(tok.text, lang) else {
                    continue;
                };
                let mut chars = tok.text.chars();
                let first_lower = chars.next().map(|c| c.is_lowercase()).unwrap_or(false);
                let has_later_upper = chars.any(|c| c.is_uppercase());
                let lower_sentence_start = first_lower
                    && !has_later_upper
                    && !tok.text.chars().any(|c| c.is_ascii_digit())
                    && is_sentence_start(para, tok.byte_start);

                let short_or_num = tok.text.chars().count() < 2
                    || tok.text.chars().any(|c| c.is_ascii_digit())
                    || is_roman_numeral(tok.text)
                    || is_short_all_caps(tok.text);

                let mut spell_bad = false;
                if !short_or_num {
                    let dict = match tlang {
                        DictLang::Ru => loaded.ru.as_ref(),
                        DictLang::En => loaded.en.as_ref(),
                    };
                    if let Some(dict) = dict {
                        let cache_key = (tlang, tok.text.to_string());
                        let ok = if let Some(&v) = word_cache.get(&cache_key) {
                            v
                        } else {
                            let v = check_token(dict, tlang, tok.text, &custom);
                            word_cache.insert(cache_key.clone(), v);
                            v
                        };
                        if !ok {
                            spell_bad = true;
                            let mut replacements = if let Some(s) = sugg_cache.get(&cache_key) {
                                s.clone()
                            } else if sugg_cache.len() < MAX_UNIQUE_SUGGEST_WORDS {
                                let mut clean = fast_suggest(dict, tlang, tok.text);
                                if clean.is_empty()
                                    && !is_mid_sentence_proper(para, tok.byte_start, tok.text)
                                    && slow_suggest_count < MAX_SLOW_SUGGEST_WORDS
                                {
                                    slow_suggest_count += 1;
                                    let mut raw = Vec::new();
                                    dict.suggest(tok.text, &mut raw);
                                    for cand in raw {
                                        if cand != tok.text && !clean.contains(&cand) {
                                            clean.push(cand);
                                            if clean.len() >= MAX_SUGGESTIONS {
                                                break;
                                            }
                                        }
                                    }
                                }
                                sugg_cache.insert(cache_key, clean.clone());
                                clean
                            } else {
                                Vec::new()
                            };
                            if lower_sentence_start {
                                let mut cap_repls = Vec::with_capacity(replacements.len());
                                for r in replacements {
                                    let c = capitalize_first(&r);
                                    if !cap_repls.contains(&c) {
                                        cap_repls.push(c);
                                    }
                                }
                                replacements = cap_repls;
                            }

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
                }

                if !spell_bad && lower_sentence_start {
                    out.push(json!({
                        "para": para_idx,
                        "offset": tok.u16_start,
                        "length": tok.u16_len,
                        "text": tok.text,
                        "message": "Предложение начинается со строчной буквы.",
                        "short": "Заглавная буква",
                        "ruleId": "OFFLINE_UPPERCASE_SENTENCE_START",
                        "kind": "typography",
                        "replacements": [capitalize_first(tok.text)],
                    }));
                }
            }
        }

        if let Some((old_p, old_pos)) = open_guillemet {
            push_unpaired(&mut out, old_p, old_pos, "«", "Непарная кавычка", "Незакрытая кавычка.");
        }
        out.sort_by_key(|v| (v["para"].as_u64().unwrap_or(0), v["offset"].as_u64().unwrap_or(0)));

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

    #[test]
    fn offline_spell_morphology_prefixes_and_fast_suggest() {
        let tmp = tmpdir("offline-spell-morph");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(
            tmp.join("ru.aff"),
            "SET UTF-8\nTRY еиаостнрвклмпдуяьыбгзчйжхшюцщэфъё\nSFX A Y 1\nSFX A 0 а .\n",
        )
        .unwrap();
        std::fs::write(
            tmp.join("ru.dic"),
            "14\nпривет\nчёрный\nтёплый\nзеленый\nзелёный\nпредвидение\nзакрывший\nвесёлой\nмолотым\nголовы\nмессенджер/A\nмир\nвчера\nвстретил\n",
        )
        .unwrap();

        let svc = OfflineSpell::new(tmp);
        let cancel = AtomicBool::new(false);
        let paras = vec![
            // -нье, -вши, полу-, свеже-, пол-, е→ё, дефисный префикс, extra-лексика
            "Черный теплый зеленый предвиденье закрывши полувеселой свежемолотым полголовы тёмно-зелёный мессенджере.".to_string(),
            // Реальная опечатка + быстрое исправление + проверка середины предложения (proper name)
            "Вчера Иванка встретил Првиет мир!".to_string(),
        ];
        let issues = svc.check_paragraphs(&paras, "ru", &[], &cancel, &|_, _| {}).unwrap();
        let bad: Vec<&str> = issues.iter().filter_map(|x| x["text"].as_str()).collect();
        assert_eq!(bad, vec!["Иванка", "Првиет"], "получено: {:?}", bad);
        // Для настоящей опечатки fast_suggest должен сразу вернуть "Привет" без медленного suggest()
        assert!(issues[1]["replacements"].as_array().unwrap().iter().any(|v| v == "Привет"));
        assert!(is_mid_sentence_proper(&paras[1], paras[1].find("Иванка").unwrap(), "Иванка"));
        assert!(!is_mid_sentence_proper("Иванка дома.", 0, "Иванка"));

        // Ленивый подбор вариантов по запросу
        let sugg = svc.suggest_word("мессенжир", "ru").unwrap();
        assert!(!sugg.is_empty() || svc.suggest_word("Првиет", "ru").unwrap().iter().any(|w| w == "Привет"));
        assert!(svc.suggest_word("Првиет", "ru").unwrap().iter().any(|w| w == "Привет"));
        assert!(svc.suggest_word("", "ru").unwrap().is_empty());
    }

    #[test]
    fn offline_spell_flags_lowercase_sentence_start_without_false_positives() {
        let tmp = tmpdir("offline-spell-caps");
        write_mini_ru_dict(&tmp);
        std::fs::write(
            tmp.join("ru.dic"),
            "16\nпривет\nмир/A\nзеленый\nчёрный\nкто-то\nдом/A\nмашина\nон\nона\nушел\nсказал\nкак\nдела\nи\nпункт\nпервый\n",
        )
        .unwrap();
        let svc = OfflineSpell::new(tmp);
        let cancel = AtomicBool::new(false);

        let paras = vec![
            "случайно встретил. а он ушел!".to_string(),
            "привет! как дела? он ушел. она сказала.".to_string(),
            "— Привет! — сказал он. — как дела?".to_string(),
            "«Привет?» — сказал он. Он (о чудо!) ушел… и не вернулся.".to_string(),
            "А. С. он т. е. мир см. дом 1. первый пункт;".to_string(),
            "…и он ушел.".to_string(),
            "iPhone работает.".to_string(),
            "первый пункт;".to_string(),
            "првиет мир.".to_string(),
        ];
        // Используем простой словарь с кастомным набором известных слов, чтобы сосредоточиться на регистре
        let custom: Vec<String> = [
            "случайно", "встретил", "он", "ушел", "привет", "как", "дела", "она", "сказала",
            "сказал", "чудо", "вернулся", "не", "мир", "см", "дом", "первый", "пункт",
            "работает", "о", "и", "а", "iPhone",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let issues = svc.check_paragraphs(&paras, "ru", &custom, &cancel, &|_, _| {}).unwrap();
        let caps: Vec<(usize, &str, &str)> = issues
            .iter()
            .filter(|x| x["ruleId"] == json!("OFFLINE_UPPERCASE_SENTENCE_START"))
            .map(|x| (
                x["para"].as_u64().unwrap() as usize,
                x["text"].as_str().unwrap(),
                x["replacements"][0].as_str().unwrap(),
            ))
            .collect();
        assert_eq!(
            caps,
            vec![
                (0, "случайно", "Случайно"),
                (0, "а", "А"),
                (1, "привет", "Привет"),
                (1, "как", "Как"),
                (1, "он", "Он"),
                (1, "она", "Она"),
                (2, "как", "Как"),
            ],
            "unexpected caps issues: {:?}",
            issues
        );
        // Для опечатки в начале предложения замена сразу начинается с заглавной, без дубля правила регистра
        let spell: Vec<&Value> = issues.iter().filter(|x| x["ruleId"] == json!("OFFLINE_SPELL")).collect();
        assert_eq!(spell.len(), 1);
        assert_eq!(spell[0]["text"], json!("првиет"));
        assert!(spell[0]["replacements"].as_array().unwrap().iter().any(|v| v == "Привет"));
    }

    #[test]
    fn offline_spell_flags_repeated_words_and_unpaired_punctuation() {
        let tmp = tmpdir("offline-spell-repeats-punct");
        write_mini_ru_dict(&tmp);
        let svc = OfflineSpell::new(tmp);
        let cancel = AtomicBool::new(false);

        let custom: Vec<String> = [
            "Он", "он", "пошел", "в", "дом", "ха", "да", "тук",
            "Первый", "абзац", "Второй", "привет", "пункт", "лишняя", "текст",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();

        let paras = vec![
            "Он он пошел в\u{00a0}в дом, но ха ха и тук тук, да, да.".to_string(),
            "Первый (незакрытая скобка.".to_string(),
            "Закрывающая лишняя) и смайл :) ок.".to_string(),
            "«Первый абзац цитаты.".to_string(),
            "Второй абзац» и «норм».".to_string(),
            "1) пункт.".to_string(),
            "«Многоабзацная 1.".to_string(),
            "«Многоабзацная 2».".to_string(),
            "«Незакрытая перед пустым.".to_string(),
            "".to_string(),
            "Лишняя» кавычка.".to_string(),
        ];

        let issues = svc.check_paragraphs(&paras, "ru", &custom, &cancel, &|_, _| {}).unwrap();

        let repeats: Vec<(usize, &str, &str)> = issues
            .iter()
            .filter(|x| x["ruleId"] == json!("OFFLINE_REPEATED_WORD"))
            .map(|x| (
                x["para"].as_u64().unwrap() as usize,
                x["text"].as_str().unwrap(),
                x["replacements"][0].as_str().unwrap(),
            ))
            .collect();
        assert_eq!(
            repeats,
            vec![(0, "Он он", "Он"), (0, "в\u{00a0}в", "в")],
            "unexpected repeats: {:?}",
            repeats
        );

        let punct: Vec<(usize, &str, &str)> = issues
            .iter()
            .filter(|x| x["ruleId"] == json!("OFFLINE_UNPAIRED_PUNCT"))
            .map(|x| (
                x["para"].as_u64().unwrap() as usize,
                x["text"].as_str().unwrap(),
                x["message"].as_str().unwrap(),
            ))
            .collect();
        assert_eq!(
            punct,
            vec![
                (1, "(", "Незакрытая скобка."),
                (2, ")", "Лишняя закрывающая скобка."),
                (8, "«", "Незакрытая кавычка."),
                (10, "»", "Лишняя закрывающая кавычка."),
            ],
            "unexpected punct issues: {:?}",
            punct
        );
    }
}
