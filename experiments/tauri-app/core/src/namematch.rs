//! Общий сопоставитель имён для подсветки в тексте и счётчика «Встречается в главах».
//! Порт src/namematch.js: одна регулярка из дерева префиксов вместо длинного перечисления через «|».
//! С падежными формами имён вариантов становятся сотни, и обычная альтернация перебирала бы их в каждой позиции текста.

use std::collections::BTreeMap;

#[derive(Default)]
struct Trie {
    children: BTreeMap<char, Trie>,
    end: bool,
}

fn trie_regex(node: &Trie) -> String {
    if node.children.is_empty() {
        return String::new();
    }
    let parts: Vec<String> = node
        .children
        .iter()
        .map(|(k, child)| format!("{}{}", regex::escape(&k.to_string()), trie_regex(child)))
        .collect();
    if parts.len() == 1 && !node.end {
        return parts[0].clone();
    }
    format!("(?:{}){}", parts.join("|"), if node.end { "?" } else { "" })
}

/// Исходный текст регулярки для набора строк (в нижнем регистре): строки целиком, самые длинные пробуются первыми.
pub fn alternation(keys: &[String]) -> String {
    let mut root = Trie::default();
    for key in keys {
        let mut node = &mut root;
        for ch in key.chars() {
            node = node.children.entry(ch).or_default();
        }
        node.end = true;
    }
    trie_regex(&root)
}

/// Регулярка «слово целиком, без учёта регистра» для набора имён в нижнем регистре; None, если имён нет.
pub fn name_regex(keys: &[String]) -> Option<fancy_regex::Regex> {
    let mut list: Vec<String> = keys.to_vec();
    list.sort();
    list.dedup();
    if list.is_empty() {
        return None;
    }
    let alt = alternation(&list);
    let pattern = format!(r"(?i)(?<![\p{{L}}\p{{N}}])(?:{alt})(?![\p{{L}}\p{{N}}])");
    fancy_regex::Regex::new(&pattern).ok()
}

/// Признак «слово начинается с большой буквы».
pub fn is_capital(s: &str) -> bool {
    s.chars().next().map(|c| c.is_uppercase()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all(re: &fancy_regex::Regex, text: &str) -> Vec<String> {
        re.find_iter(text)
            .filter_map(|m| m.ok())
            .map(|m| m.as_str().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    }

    #[test]
    fn matcher_whole_words_longest_first_case_insensitive() {
        let keys = vec!["анна", "анны", "красная поляна", "красная", "ли", "санкт-петербург"]
            .into_iter().map(String::from).collect::<Vec<_>>();
        let re = name_regex(&keys).unwrap();
        assert_eq!(
            all(&re, "Анны не было. АННА видела Красная Поляна и красная роза. Ли ушёл из Санкт-Петербург."),
            vec!["Анны", "АННА", "Красная Поляна", "красная", "Ли", "Санкт-Петербург"]
        );
        assert_eq!(all(&re, "Аннушка, Анненский, Лиловый"), Vec::<String>::new());
        assert!(name_regex(&[]).is_none());
    }

    #[test]
    fn matcher_trie_matches_plain_alternation() {
        let mut words = Vec::new();
        for i in 0..120 {
            words.push(format!("имя{}а", radix(i)));
            words.push(format!("имя{}ой", radix(i)));
            words.push(format!("имя{}", radix(i)));
        }
        let fast = name_regex(&words).unwrap();
        let mut sorted = words.clone();
        sorted.sort_by(|a, b| b.chars().count().cmp(&a.chars().count()));
        let slow_pat = format!(r"(?i)(?<![\p{{L}}\p{{N}}])(?:{})(?![\p{{L}}\p{{N}}])", sorted.join("|"));
        let slow = fancy_regex::Regex::new(&slow_pat).unwrap();
        let text: String = (0..2000).map(|i| if i % 7 == 0 { format!("имя{}ой", radix(i % 120)) } else { "слово".to_string() }).collect::<Vec<_>>().join(" ");
        assert_eq!(all(&fast, &text), all(&slow, &text));
        assert!(alternation(&["ab".into(), "a".into()]).contains('?'), "префикс-слово сохраняется как необязательное продолжение");
    }

    #[test]
    fn matcher_capital_flag() {
        assert!(is_capital("Анны") && is_capital("Ёж"));
        assert!(!is_capital("анны") && !is_capital(""));
    }

    fn radix(mut n: usize) -> String {
        if n == 0 {
            return "0".to_string();
        }
        let mut s = String::new();
        while n > 0 {
            let d = n % 36;
            let c = if d < 10 { (b'0' + d as u8) as char } else { (b'a' + (d - 10) as u8) as char };
            s.insert(0, c);
            n /= 36;
        }
        s
    }
}
