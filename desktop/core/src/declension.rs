//! Падежные формы имён и названий: «Анна» → «Анны, Анне, Анну, Анной».
//! Порт src/declension.js. Словаря языка здесь нет: формы строятся по типовым
//! моделям склонения и окончаниям. Модель может ошибиться на редком слове —
//! лишняя неверная форма почти безвредна, а пропущенную автор добавит в «Имена в тексте».

use std::collections::BTreeSet;

const MAX_WORDS: usize = 5;
const MAX_COMBOS: usize = 40;

const PARTICLES: [&str; 23] = [
    "на", "в", "во", "под", "над", "за", "при", "у", "от", "из", "с", "со", "о", "об", "по", "де",
    "ван", "фон", "ла", "ле", "дель", "ди", "и",
];

const NOT_ADJ: [&str; 3] = ["аглая", "исая", "георгий"];

fn lo(s: &str) -> String {
    s.to_lowercase()
}

fn is_cyr(c: char) -> bool {
    matches!(c, 'а'..='я' | 'А'..='Я' | 'ё' | 'Ё')
}

fn is_word(w: &str) -> bool {
    !w.is_empty() && w.chars().all(is_cyr)
}

/// Последний символ строки принадлежит набору (строка уже в нижнем регистре).
fn last_in(w: &str, set: &str) -> bool {
    w.chars().last().map(|c| set.contains(c)).unwrap_or(false)
}

/// Нижний регистр слова оканчивается на один из суффиксов.
fn ends_lower(w: &str, sufs: &[&str]) -> bool {
    let l = lo(w);
    sufs.iter().any(|s| l.ends_with(s))
}

/// Отбросить последние `n` символов.
fn drop_chars(w: &str, n: usize) -> String {
    let len = w.chars().count();
    w.chars().take(len.saturating_sub(n)).collect()
}

fn one(s: &str) -> Vec<String> {
    vec![s.to_string()]
}

fn many(xs: &[&str]) -> Vec<String> {
    xs.iter().map(|s| s.to_string()).collect()
}

fn mk(a: Vec<String>, b: Vec<String>, c: Vec<String>, d: Vec<String>, e: Vec<String>) -> [Vec<String>; 5] {
    [a, b, c, d, e]
}

fn merge(a: [Vec<String>; 5], b: [Vec<String>; 5]) -> [Vec<String>; 5] {
    let mut out: [Vec<String>; 5] = Default::default();
    for i in 0..5 {
        let mut seen = BTreeSet::new();
        let mut v = Vec::new();
        for x in a[i].iter().chain(b[i].iter()) {
            if seen.insert(x.clone()) {
                v.push(x.clone());
            }
        }
        out[i] = v;
    }
    out
}

// ---------- прилагательные ----------

#[derive(Clone, Copy)]
struct Opts {
    kind: &'static str,
    multi: bool,
    last: bool,
}

fn adj_type(w: &str, o: Opts) -> Option<&'static str> {
    let l = lo(w);
    if NOT_ADJ.contains(&l.as_str()) || l.chars().count() < 4 {
        return None;
    }
    if l.ends_with("ая") {
        return Some("f-hard");
    }
    if l.ends_with("яя") {
        return Some("f-soft");
    }
    if l.ends_with("ое") {
        return Some("n-hard");
    }
    if l.ends_with("ее") {
        return Some("n-soft");
    }
    if l.ends_with("ые") {
        return Some("p-hard");
    }
    if l.ends_with("ие") && (ends_lower(&l, &["гие", "кие", "хие", "жие", "чие", "шие", "щие"]) || (o.multi && !o.last)) {
        return Some("p-soft");
    }
    if l.ends_with("ый") || l.ends_with("ой") {
        return Some("m-hard");
    }
    if l.ends_with("ий") {
        if ends_lower(&l, &["гий", "кий", "хий"]) {
            return Some("m-velar");
        }
        if ends_lower(&l, &["жий", "чий", "ший", "щий"]) {
            return Some("m-soft");
        }
        if l.ends_with("ний") && o.multi && !o.last {
            return Some("m-soft");
        }
    }
    None
}

fn adj_cases(w: &str, ty: &str) -> [Vec<String>; 5] {
    let b = drop_chars(w, 2);
    match ty {
        "m-hard" => mk(
            one(&format!("{b}ого")), one(&format!("{b}ому")), one(&format!("{b}ого")), one(&format!("{b}ым")), one(&format!("{b}ом")),
        ),
        "m-velar" => mk(
            one(&format!("{b}ого")), one(&format!("{b}ому")), one(&format!("{b}ого")), one(&format!("{b}им")), one(&format!("{b}ом")),
        ),
        "m-soft" => mk(
            one(&format!("{b}его")), one(&format!("{b}ему")), one(&format!("{b}его")), one(&format!("{b}им")), one(&format!("{b}ем")),
        ),
        "f-hard" => mk(
            one(&format!("{b}ой")), one(&format!("{b}ой")), one(&format!("{b}ую")), one(&format!("{b}ой")), one(&format!("{b}ой")),
        ),
        "f-soft" => mk(
            one(&format!("{b}ей")), one(&format!("{b}ей")), one(&format!("{b}юю")), one(&format!("{b}ей")), one(&format!("{b}ей")),
        ),
        "n-hard" => mk(
            one(&format!("{b}ого")), one(&format!("{b}ому")), one(w), one(&format!("{b}ым")), one(&format!("{b}ом")),
        ),
        "n-soft" => mk(
            one(&format!("{b}его")), one(&format!("{b}ему")), one(w), one(&format!("{b}им")), one(&format!("{b}ем")),
        ),
        "p-hard" => mk(
            one(&format!("{b}ых")), one(&format!("{b}ым")), many(&[w, &format!("{b}ых")]), one(&format!("{b}ыми")), one(&format!("{b}ых")),
        ),
        _ => mk(
            one(&format!("{b}их")), one(&format!("{b}им")), many(&[w, &format!("{b}их")]), one(&format!("{b}ими")), one(&format!("{b}их")),
        ),
    }
}

// ---------- существительные ----------

fn masc_hard(w: &str) -> [Vec<String>; 5] {
    let mut stems = vec![w.to_string()];
    if ends_lower(w, &["ел", "ёл", "ек", "ёк", "ок", "ец", "ёц"]) && w.chars().count() >= 4 {
        let dropped = drop_chars(w, 2);
        let last = w.chars().last().unwrap();
        stems.push(format!("{dropped}{last}"));
    }
    if lo(w) == "лев" {
        stems.push(format!("{}ьв", w.chars().next().unwrap()));
    }
    let mut out: [Vec<String>; 5] = [vec![], vec![], vec![], vec![], vec![]];
    for s in &stems {
        out[0].push(format!("{s}а"));
        out[1].push(format!("{s}у"));
        out[2].push(format!("{s}а"));
        out[3].push(format!("{s}ом"));
        if ends_lower(s, &["ж", "ч", "ш", "щ", "ц"]) {
            out[3].push(format!("{s}ем"));
        }
        out[4].push(format!("{s}е"));
    }
    if w.chars().count() >= 5 && ends_lower(w, &["ов", "ев", "ёв", "ин", "ын"]) {
        out[3].push(format!("{w}ым"));
    }
    out
}

fn masc_j(w: &str) -> [Vec<String>; 5] {
    if ends_lower(w, &["ий"]) {
        let b = drop_chars(w, 2);
        return mk(
            one(&format!("{b}ия")), one(&format!("{b}ию")), one(&format!("{b}ия")), one(&format!("{b}ием")), one(&format!("{b}ии")),
        );
    }
    let b = drop_chars(w, 1);
    mk(
        one(&format!("{b}я")), one(&format!("{b}ю")), one(&format!("{b}я")), one(&format!("{b}ем")), one(&format!("{b}е")),
    )
}

fn soft(w: &str) -> [Vec<String>; 5] {
    let b = drop_chars(w, 1);
    let male = mk(
        one(&format!("{b}я")), one(&format!("{b}ю")), one(&format!("{b}я")), many(&[&format!("{b}ем"), &format!("{b}ём")]), one(&format!("{b}е")),
    );
    let mut bases = vec![b.clone()];
    if ends_lower(w, &["овь"]) && w.chars().count() >= 5 {
        bases.push(format!("{}в", drop_chars(w, 3)));
    }
    let mut female: [Vec<String>; 5] = [vec![], vec![], vec![w.to_string()], vec![], vec![]];
    for s in &bases {
        female[0].push(format!("{s}и"));
        female[1].push(format!("{s}и"));
        female[3].push(format!("{s}ью"));
        female[4].push(format!("{s}и"));
    }
    merge(male, female)
}

fn fem_hard(w: &str) -> [Vec<String>; 5] {
    let b = drop_chars(w, 1);
    let instr = if ends_lower(&b, &["ж", "ч", "ш", "щ", "ц"]) {
        many(&[&format!("{b}ей"), &format!("{b}ой")])
    } else {
        one(&format!("{b}ой"))
    };
    let gen = if ends_lower(&b, &["г", "к", "х"]) || ends_lower(&b, &["ж", "ч", "ш", "щ"]) {
        one(&format!("{b}и"))
    } else {
        one(&format!("{b}ы"))
    };
    let mut out = mk(gen, one(&format!("{b}е")), one(&format!("{b}у")), instr, one(&format!("{b}е")));
    if w.chars().count() >= 5 && ends_lower(&b, &["ов", "ев", "ёв", "ин", "ын"]) {
        out[0].push(format!("{b}ой"));
        out[1].push(format!("{b}ой"));
        out[4].push(format!("{b}ой"));
    }
    out
}

fn fem_soft(w: &str) -> [Vec<String>; 5] {
    if ends_lower(w, &["ия"]) {
        let b = drop_chars(w, 1);
        return mk(
            one(&format!("{b}и")), one(&format!("{b}и")), one(&format!("{b}ю")), one(&format!("{b}ей")), one(&format!("{b}и")),
        );
    }
    let b = drop_chars(w, 1);
    if ends_lower(w, &["ья"]) {
        return mk(
            one(&format!("{b}и")), one(&format!("{b}е")), one(&format!("{b}ю")), many(&[&format!("{b}ей"), &format!("{b}ёй")]), one(&format!("{b}е")),
        );
    }
    mk(
        one(&format!("{b}и")), one(&format!("{b}е")), one(&format!("{b}ю")), one(&format!("{b}ей")), one(&format!("{b}е")),
    )
}

fn neuter(w: &str) -> [Vec<String>; 5] {
    if ends_lower(w, &["о"]) {
        let b = drop_chars(w, 1);
        return mk(
            one(&format!("{b}а")), one(&format!("{b}у")), one(w), one(&format!("{b}ом")), one(&format!("{b}е")),
        );
    }
    if ends_lower(w, &["ие"]) {
        let b = drop_chars(w, 2);
        return mk(
            one(&format!("{b}ия")), one(&format!("{b}ию")), one(w), one(&format!("{b}ием")), one(&format!("{b}ии")),
        );
    }
    let b = drop_chars(w, 1);
    if ends_lower(w, &["ье"]) {
        return mk(
            one(&format!("{b}я")), one(&format!("{b}ю")), one(w), many(&[&format!("{b}ем"), &format!("{b}ём")]), one(&format!("{b}е")),
        );
    }
    mk(
        one(&format!("{b}я")), one(&format!("{b}ю")), one(w), one(&format!("{b}ем")), one(&format!("{b}е")),
    )
}

fn same(w: &str) -> [Vec<String>; 5] {
    let s = w.to_string();
    [vec![s.clone()], vec![s.clone()], vec![s.clone()], vec![s.clone()], vec![s]]
}

fn word_cases(w: &str, o: Opts) -> [Vec<String>; 5] {
    if !is_word(w) || w.chars().count() < 2 {
        return same(w);
    }
    let l = lo(w);
    if w == w.to_uppercase() && w.chars().count() > 1 {
        return same(w); // аббревиатура
    }
    if PARTICLES.iter().any(|&p| p == l) && w == l {
        return same(w);
    }
    if (l.ends_with("ых") || l.ends_with("их")) && l.chars().count() > 3 {
        return same(w);
    }
    if let Some(adj) = adj_type(w, o) {
        return adj_cases(w, adj);
    }
    if l.ends_with("ия") || l.ends_with("я") {
        return fem_soft(w);
    }
    if l.ends_with("а") {
        return fem_hard(w);
    }
    if l.ends_with("ь") {
        return soft(w);
    }
    if l.ends_with("й") {
        return masc_j(w);
    }
    if last_in(&l, "бвгджзклмнпрстфхцчшщ") {
        return masc_hard(w);
    }
    if (l.ends_with("о") || l.ends_with("е")) && o.kind == "place" && w.chars().count() >= 4 {
        return neuter(w);
    }
    same(w)
}

fn yo(s: &str) -> String {
    s.replace('ё', "е").replace('Ё', "Е")
}

fn with_yo(cases: [Vec<String>; 5]) -> [Vec<String>; 5] {
    let mut out: [Vec<String>; 5] = Default::default();
    for i in 0..5 {
        let mut seen = BTreeSet::new();
        let mut v = Vec::new();
        for x in &cases[i] {
            let mut push = |s: &str| {
                if seen.insert(s.to_string()) {
                    v.push(s.to_string());
                }
            };
            if x.contains('ё') || x.contains('Ё') {
                push(x);
                push(&yo(x));
            } else {
                push(x);
            }
        }
        out[i] = v;
    }
    out
}

fn token_cases(token: &str, o: Opts) -> [Vec<String>; 5] {
    let parts: Vec<&str> = token.split('-').collect();
    if parts.len() == 1 {
        return with_yo(word_cases(token, o));
    }
    let part = |p: &str, o: Opts| word_cases(p, Opts { multi: false, last: true, ..o });
    let particle_inside = parts.iter().copied().enumerate().skip(1).any(|(_, p)| {
        let l = lo(p);
        PARTICLES.iter().any(|&x| x == l) && p == l
    });
    let capital = |p: &str| p.chars().count() >= 2 && p.chars().next().map(|c| c.is_uppercase()).unwrap_or(false);
    let declined: Vec<[Vec<String>; 5]> = if particle_inside {
        parts.iter().copied().enumerate().map(|(i, p)| if i == 0 { part(p, o) } else { same(p) }).collect()
    } else if o.kind == "character" && parts.iter().copied().all(|p| capital(p)) {
        parts.iter().copied().map(|p| part(p, o)).collect()
    } else {
        parts.iter().copied().enumerate().map(|(i, p)| if i == parts.len() - 1 { part(p, o) } else { same(p) }).collect()
    };
    with_yo(combine(&declined, "-"))
}

fn combine(per_word: &[[Vec<String>; 5]], glue: &str) -> [Vec<String>; 5] {
    let mut out: [Vec<String>; 5] = Default::default();
    for c in 0..5 {
        let mut acc: Vec<String> = vec![String::new()];
        for (i, cases) in per_word.iter().enumerate() {
            let mut next: Vec<String> = Vec::new();
            'outer: for prefix in &acc {
                for v in &cases[c] {
                    next.push(if i == 0 { v.clone() } else { format!("{prefix}{glue}{v}") });
                    if next.len() >= MAX_COMBOS {
                        break 'outer;
                    }
                }
            }
            acc = next;
        }
        let mut seen = BTreeSet::new();
        for x in acc {
            if seen.insert(x.clone()) {
                out[c].push(x);
            }
        }
    }
    out
}

/// Падежные формы названия или имени (без именительного падежа). kind: "character" | "place".
pub fn case_forms(name: &str, kind: &str) -> BTreeSet<String> {
    let text: String = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() || text.encode_utf16().count() > 80 {
        return BTreeSet::new();
    }
    let words: Vec<&str> = text.split(' ').collect();
    if words.len() > MAX_WORDS {
        return BTreeSet::new();
    }
    let kind: &'static str = match kind {
        "place" => "place",
        "character" => "character",
        _ => "",
    };
    let per_word: Vec<[Vec<String>; 5]> = words
        .iter()
        .copied()
        .enumerate()
        .map(|(i, w)| token_cases(w, Opts { kind, multi: words.len() > 1, last: i == words.len() - 1 }))
        .collect();
    let mut forms: BTreeSet<String> = combine(&per_word, " ").into_iter().flatten().collect();
    if text.contains('ё') || text.contains('Ё') {
        forms.insert(yo(&text));
    }
    forms.remove(&text);
    forms
}

/// Все сгенерированные формы для названия карточки и «Имён в тексте». Явные имена в результат не входят.
pub fn name_forms(title: &str, aliases: &[String], kind: &str) -> Vec<String> {
    let names: Vec<String> = std::iter::once(title.to_string()).chain(aliases.iter().cloned()).collect();
    let explicit: BTreeSet<String> = names.iter().map(|x| lo(x.trim())).collect();
    let mut generated: BTreeSet<String> = BTreeSet::new();
    let mut out: Vec<String> = Vec::new();
    for name in names {
        let key = lo(name.trim());
        if key.is_empty() || generated.contains(&key) {
            continue;
        }
        for f in case_forms(&name, kind) {
            let fk = lo(&f);
            if generated.contains(&fk) {
                continue;
            }
            generated.insert(fk.clone());
            if !explicit.contains(&fk) && fk.chars().count() >= 2 {
                out.push(f);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn forms(name: &str, kind: &str) -> BTreeSet<String> {
        let mut all: BTreeSet<String> = case_forms(name, kind).into_iter().map(|x| lo(&x)).collect();
        all.insert(lo(name));
        all
    }

    // Имя или название, вид, родительный, дательный, винительный, творительный, предложный.
    const TABLE: &[(&str, &str, &str, &str, &str, &str, &str)] = &[
        ("Иван", "character", "Ивана", "Ивану", "Ивана", "Иваном", "Иване"),
        ("Пётр", "character", "Петра", "Петру", "Петра", "Петром", "Петре"),
        ("Павел", "character", "Павла", "Павлу", "Павла", "Павлом", "Павле"),
        ("Лев", "character", "Льва", "Льву", "Льва", "Львом", "Льве"),
        ("Сергей", "character", "Сергея", "Сергею", "Сергея", "Сергеем", "Сергее"),
        ("Андрей", "character", "Андрея", "Андрею", "Андрея", "Андреем", "Андрее"),
        ("Николай", "character", "Николая", "Николаю", "Николая", "Николаем", "Николае"),
        ("Василий", "character", "Василия", "Василию", "Василия", "Василием", "Василии"),
        ("Дмитрий", "character", "Дмитрия", "Дмитрию", "Дмитрия", "Дмитрием", "Дмитрии"),
        ("Игорь", "character", "Игоря", "Игорю", "Игоря", "Игорем", "Игоре"),
        ("Алексей", "character", "Алексея", "Алексею", "Алексея", "Алексеем", "Алексее"),
        ("Фёдор", "character", "Фёдора", "Фёдору", "Фёдора", "Фёдором", "Фёдоре"),
        ("Михаил", "character", "Михаила", "Михаилу", "Михаила", "Михаилом", "Михаиле"),
        ("Егор", "character", "Егора", "Егору", "Егора", "Егором", "Егоре"),
        ("Артём", "character", "Артёма", "Артёму", "Артёма", "Артёмом", "Артёме"),
        ("Илья", "character", "Ильи", "Илье", "Илью", "Ильёй/Ильей", "Илье"),
        ("Никита", "character", "Никиты", "Никите", "Никиту", "Никитой", "Никите"),
        ("Кузьма", "character", "Кузьмы", "Кузьме", "Кузьму", "Кузьмой", "Кузьме"),
        ("Евгений", "character", "Евгения", "Евгению", "Евгения", "Евгением", "Евгении"),
        ("Юрий", "character", "Юрия", "Юрию", "Юрия", "Юрием", "Юрии"),
        ("Георгий", "character", "Георгия", "Георгию", "Георгия", "Георгием", "Георгии"),
        ("Максим", "character", "Максима", "Максиму", "Максима", "Максимом", "Максиме"),
        ("Роман", "character", "Романа", "Роману", "Романа", "Романом", "Романе"),
        ("Тимофей", "character", "Тимофея", "Тимофею", "Тимофея", "Тимофеем", "Тимофее"),
        ("Анна", "character", "Анны", "Анне", "Анну", "Анной", "Анне"),
        ("Мария", "character", "Марии", "Марии", "Марию", "Марией", "Марии"),
        ("Наталья", "character", "Натальи", "Наталье", "Наталью", "Натальей", "Наталье"),
        ("Ольга", "character", "Ольги", "Ольге", "Ольгу", "Ольгой", "Ольге"),
        ("Елена", "character", "Елены", "Елене", "Елену", "Еленой", "Елене"),
        ("Катя", "character", "Кати", "Кате", "Катю", "Катей", "Кате"),
        ("Софья", "character", "Софьи", "Софье", "Софью", "Софьей", "Софье"),
        ("Любовь", "character", "Любови", "Любови", "Любовь", "Любовью", "Любови"),
        ("Татьяна", "character", "Татьяны", "Татьяне", "Татьяну", "Татьяной", "Татьяне"),
        ("Наташа", "character", "Наташи", "Наташе", "Наташу", "Наташей", "Наташе"),
        ("Юлия", "character", "Юлии", "Юлии", "Юлию", "Юлией", "Юлии"),
        ("Надежда", "character", "Надежды", "Надежде", "Надежду", "Надеждой", "Надежде"),
        ("Вера", "character", "Веры", "Вере", "Веру", "Верой", "Вере"),
        ("Роза", "character", "Розы", "Розе", "Розу", "Розой", "Розе"),
        ("Ксения", "character", "Ксении", "Ксении", "Ксению", "Ксенией", "Ксении"),
        ("Маша", "character", "Маши", "Маше", "Машу", "Машей", "Маше"),
        ("Алиса", "character", "Алисы", "Алисе", "Алису", "Алисой", "Алисе"),
        ("Иванов", "character", "Иванова", "Иванову", "Иванова", "Ивановым", "Иванове"),
        ("Кузнецов", "character", "Кузнецова", "Кузнецову", "Кузнецова", "Кузнецовым", "Кузнецове"),
        ("Пушкин", "character", "Пушкина", "Пушкину", "Пушкина", "Пушкиным", "Пушкине"),
        ("Достоевский", "character", "Достоевского", "Достоевскому", "Достоевского", "Достоевским", "Достоевском"),
        ("Толстой", "character", "Толстого", "Толстому", "Толстого", "Толстым", "Толстом"),
        ("Белый", "character", "Белого", "Белому", "Белого", "Белым", "Белом"),
        ("Горький", "character", "Горького", "Горькому", "Горького", "Горьким", "Горьком"),
        ("Иванова", "character", "Ивановой", "Ивановой", "Иванову", "Ивановой", "Ивановой"),
        ("Достоевская", "character", "Достоевской", "Достоевской", "Достоевскую", "Достоевской", "Достоевской"),
        ("Москва", "place", "Москвы", "Москве", "Москву", "Москвой", "Москве"),
        ("Лондон", "place", "Лондона", "Лондону", "Лондон", "Лондоном", "Лондоне"),
        ("Париж", "place", "Парижа", "Парижу", "Париж", "Парижем", "Париже"),
        ("Рязань", "place", "Рязани", "Рязани", "Рязань", "Рязанью", "Рязани"),
        ("Крым", "place", "Крыма", "Крыму", "Крым", "Крымом", "Крыме"),
        ("Кремль", "place", "Кремля", "Кремлю", "Кремль", "Кремлём", "Кремле"),
        ("Ростов", "place", "Ростова", "Ростову", "Ростов", "Ростовом", "Ростове"),
        ("Киев", "place", "Киева", "Киеву", "Киев", "Киевом", "Киеве"),
        ("Санкт-Петербург", "place", "Санкт-Петербурга", "Санкт-Петербургу", "Санкт-Петербург", "Санкт-Петербургом", "Санкт-Петербурге"),
        ("Нью-Йорк", "place", "Нью-Йорка", "Нью-Йорку", "Нью-Йорк", "Нью-Йорком", "Нью-Йорке"),
        ("Красная Поляна", "place", "Красной Поляны", "Красной Поляне", "Красную Поляну", "Красной Поляной", "Красной Поляне"),
        ("Нижний Новгород", "place", "Нижнего Новгорода", "Нижнему Новгороду", "Нижний Новгород", "Нижним Новгородом", "Нижнем Новгороде"),
        ("Белая Церковь", "place", "Белой Церкви", "Белой Церкви", "Белую Церковь", "Белой Церковью", "Белой Церкви"),
        ("Старый Оскол", "place", "Старого Оскола", "Старому Осколу", "Старый Оскол", "Старым Осколом", "Старом Осколе"),
        ("Подмосковье", "place", "Подмосковья", "Подмосковью", "Подмосковье", "Подмосковьем", "Подмосковье"),
        ("Чёрное море", "place", "Чёрного моря", "Чёрному морю", "Чёрное море", "Чёрным морем", "Чёрном море"),
        ("Озеро", "place", "Озера", "Озеру", "Озеро", "Озером", "Озере"),
        ("Дом Ростовых", "place", "Дома Ростовых", "Дому Ростовых", "Дом Ростовых", "Домом Ростовых", "Доме Ростовых"),
        ("Иван Петрович Сидоров", "character", "Ивана Петровича Сидорова", "Ивану Петровичу Сидорову", "Ивана Петровича Сидорова", "Иваном Петровичем Сидоровым", "Иване Петровиче Сидорове"),
        ("Мария Ивановна", "character", "Марии Ивановны", "Марии Ивановне", "Марию Ивановну", "Марией Ивановной", "Марии Ивановне"),
    ];

    #[test]
    fn declension_70_names_match_all_cases() {
        let mut total = 0;
        let mut found = 0;
        let mut missing = Vec::new();
        for (name, kind, g, d, a, i, p) in TABLE {
            let all: BTreeSet<String> = forms(name, kind);
            for variants in [g, d, a, i, p] {
                total += 1;
                if variants.split('/').any(|v| all.contains(&lo(v))) {
                    found += 1;
                } else {
                    missing.push(format!("{name}: {variants}"));
                }
            }
        }
        assert!(TABLE.len() >= 60);
        assert!(found as f64 / total as f64 >= 0.95, "найдено {found} из {total}; нет: {}", missing.join("; "));
        assert_eq!(missing, Vec::<String>::new(), "ожидается полное совпадение");
    }

    #[test]
    fn declension_no_unrelated_words() {
        let ivan = case_forms("Иван", "character");
        for w in ["Иванов", "Иванова", "Ивановым", "Иваныч", "Иванушка"] {
            assert!(!ivan.contains(w), "Иван не должен давать «{w}»");
        }
        let anna = case_forms("Анна", "character");
        for w in ["Анненский", "Анненского", "Аннушка", "Аня"] {
            assert!(!anna.contains(w), "Анна не должна давать «{w}»");
        }
        assert!(!case_forms("Анна", "character").contains("Анна"), "именительный в формы не входит");
    }

    #[test]
    fn declension_invariable_and_unsuitable() {
        for name in ["Ли", "Мэри", "Нелли", "Гюго", "Anna", "NASA", "Мими", "", "   "] {
            assert_eq!(case_forms(name, "character").len(), 0, "«{name}»");
        }
        assert_eq!(case_forms("Один Два Три Четыре Пять Шесть", "place").len(), 0, "слишком длинное");
        assert!(case_forms("Ростов на Дону", "place").contains("Ростовом на Дону"));
        assert!(case_forms("Ростов-на-Дону", "place").contains("Ростовом-на-Дону"));
    }

    #[test]
    fn declension_plain_words_and_yo() {
        let old = case_forms("старик", "character");
        assert!(old.contains("старика") && old.contains("старику") && old.contains("стариком") && old.contains("старике"));
        let semen = case_forms("Семён", "character");
        assert!(semen.contains("Семена") && semen.contains("Семёна") && semen.contains("Семен"));
    }

    #[test]
    fn declension_name_forms_skip_explicit() {
        let f = name_forms("Анна", &["Анны".into(), "Аня".into(), "Анне".into()], "character");
        let set: BTreeSet<String> = f.iter().map(|x| lo(x)).collect();
        assert!(set.contains("ане") && set.contains("аню"), "формы псевдонима «Аня»");
        assert!(set.contains("анну") && set.contains("анной"));
        assert!(!set.contains("анны") && !set.contains("анне"), "явные имена в результат не входят");
        assert!(!f.iter().any(|x| ["анного", "аному"].contains(&lo(x).as_str())), "«Анной» не склоняется как прилагательное");
        assert_eq!(f.iter().map(|x| lo(x)).collect::<BTreeSet<_>>().len(), f.len(), "без повторов");
    }
}
