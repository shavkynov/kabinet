//! Статистика письма по дням (stats.json в папке проекта) и расчёт «сколько слов в день до срока». Порт src/stats.js.
//! Слова считаются как прибавка за день: стирание итог не уменьшает.
use crate::store::{write_atomic, R};
use chrono::NaiveDate;
use serde_json::{json, Map, Value};
use std::path::Path;

const FILE: &str = "stats.json";
const KEEP_DAYS: usize = 400;

pub fn valid_date(s: &str) -> bool {
    s.len() == 10 && NaiveDate::parse_from_str(s, "%Y-%m-%d").map(|d| d.format("%Y-%m-%d").to_string() == s).unwrap_or(false)
}

fn day_num(s: &str) -> i64 { NaiveDate::parse_from_str(s, "%Y-%m-%d").map(|d| d.signed_duration_since(NaiveDate::from_ymd_opt(1970, 1, 1).unwrap()).num_days()).unwrap_or(0) }
fn day_str(n: i64) -> String { (NaiveDate::from_ymd_opt(1970, 1, 1).unwrap() + chrono::Duration::days(n)).format("%Y-%m-%d").to_string() }

/// Ленивое чтение для показа: ошибка/порча → пусто. Для записи использовать `read_days_strict`.
pub fn read_days(dir: &Path) -> Map<String, Value> {
    read_days_strict(dir).unwrap_or_default()
}

/// Строгое чтение перед записью: отсутствие файла → пустая статистика; ошибка чтения, порча JSON или
/// неподдерживаемая структура → Err. Запись после Err запрещена, чтобы не затереть исходные дни пустым файлом.
fn read_days_strict(dir: &Path) -> R<Map<String, Value>> {
    let text = match std::fs::read_to_string(dir.join(FILE)) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(e) => return Err(format!("Не удалось прочитать статистику: {}. Запись остановлена, чтобы не затереть данные.", e)),
    };
    let raw: Value = serde_json::from_str(&text)
        .map_err(|e| format!("Файл статистики повреждён: {}. Запись остановлена, чтобы не затереть данные.", e))?;
    // Формат stats.json: объект { "days": { "YYYY-MM-DD": число } } — так пишут все писатели
    // (Rust, общий JS, синхронизация). Отсутствие `days` или null — пустая статистика (совместимость).
    // Массив/скаляр вместо `days` или не-объект верхнего уровня — неподдерживаемая структура:
    // писать поверх нельзя, иначе непрочитанные данные будут потеряны.
    let Some(obj) = raw.as_object() else {
        return Err("Файл статистики имеет неподдерживаемую структуру: ожидается объект «days». Запись остановлена, чтобы не затереть данные.".into());
    };
    let days = match obj.get("days") {
        None | Some(Value::Null) => return Ok(Map::new()),
        Some(Value::Object(m)) => m,
        Some(_) => return Err("Файл статистики имеет неподдерживаемую структуру: поле «days» должно быть объектом. Запись остановлена, чтобы не затереть данные.".into()),
    };
    let mut out = Map::new();
    for (k, v) in days {
        let n = v.as_f64().map(|x| x.floor()).unwrap_or(0.0);
        if valid_date(k) && n.is_finite() && n > 0.0 { out.insert(k.clone(), json!(n.min(1_000_000.0) as i64)); }
    }
    Ok(out)
}

fn get(days: &Map<String, Value>, d: &str) -> i64 { days.get(d).and_then(|v| v.as_i64()).unwrap_or(0) }

/// Записывает слова за день. При записи с другого устройства берём большее значение.
pub fn set_day_words(dir: &Path, date: &str, words: &Value) -> R<()> {
    if !valid_date(date) { return Err("Неверная дата.".into()); }
    let n = words.as_f64().or_else(|| words.as_str().and_then(|s| s.trim().parse().ok())).map(|x| x.floor());
    let n = match n { Some(n) if n.is_finite() && n >= 0.0 => n.min(1_000_000.0) as i64, _ => return Err("Неверное число слов.".into()) };
    // Сериализуем со всеми писателями (главы, мета, синхронизация): read–modify–write не должен пересекаться.
    let _guard = crate::store::sync_save_lock().lock().map_err(|_| "Внутренний замок сохранения недоступен.".to_string())?;
    let mut days = read_days_strict(dir)?; // порча/ошибка чтения → Err; исходный файл не трогаем
    let v = get(&days, date).max(n);
    days.insert(date.into(), json!(v));
    let mut keys: Vec<String> = days.keys().cloned().collect();
    keys.sort();
    let extra = keys.len().saturating_sub(KEEP_DAYS);
    for k in keys.into_iter().take(extra) { days.remove(&k); }
    write_atomic(&dir.join(FILE), &serde_json::to_string_pretty(&json!({ "days": days })).unwrap())
}

/// Серия подряд идущих дней с текстом; если сегодня ещё пусто, считаем до вчера.
fn streak(days: &Map<String, Value>, today: &str) -> i64 {
    let mut n = day_num(today);
    if get(days, &day_str(n)) <= 0 { n -= 1; }
    let mut s = 0;
    while get(days, &day_str(n)) > 0 { s += 1; n -= 1; }
    s
}

/// Сколько слов в день нужно до срока. Null, если нет цели или срока.
fn daily_plan(goal: Option<i64>, total: i64, deadline: Option<&str>, today: &str) -> Value {
    let (Some(goal), Some(deadline)) = (goal.filter(|g| *g != 0), deadline.filter(|d| valid_date(d))) else { return Value::Null };
    let left = (goal - total).max(0);
    let days_left = day_num(deadline) - day_num(today) + 1; // сегодня и день срока включены
    if left == 0 { return json!({ "left": left, "daysLeft": days_left.max(0), "perDay": 0, "overdue": false, "done": true }); }
    if days_left < 1 { return json!({ "left": left, "daysLeft": 0, "perDay": left, "overdue": true, "done": false }); }
    json!({ "left": left, "daysLeft": days_left, "perDay": (left + days_left - 1) / days_left, "overdue": false, "done": false })
}

pub struct SummaryIn<'a> { pub today: &'a str, pub today_words: &'a Value, pub goal: Option<i64>, pub deadline: Option<&'a str>, pub total: i64 }

/// Всё для окна цели проекта. today_words — счёт за сегодня из окна (может быть свежее файла).
pub fn summary(dir: &Path, i: SummaryIn) -> R<Value> {
    if !valid_date(i.today) { return Err("Неверная дата.".into()); }
    let mut days = read_days(dir);
    let tw = i.today_words.as_f64().map(|x| x.floor().max(0.0) as i64).unwrap_or(0);
    if tw > get(&days, i.today) { days.insert(i.today.into(), json!(tw)); }
    let end = day_num(i.today);
    let last: Vec<Value> = (0..14).rev().map(|k| { let d = day_str(end - k); json!({ "words": get(&days, &d), "date": d }) })
        .map(|v| json!({ "date": v["date"], "words": v["words"] })).collect();
    let week: i64 = last[7..].iter().map(|d| d["words"].as_i64().unwrap_or(0)).sum();
    Ok(json!({
        "last": last, "streak": streak(&days, i.today),
        "avg7": ((week as f64) / 7.0).round() as i64,
        "plan": daily_plan(i.goal, i.total, i.deadline, i.today),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::tmpdir;
    use std::fs;

    #[test]
    fn matches_rules_of_electron_version() {
        let d = tmpdir("stats");
        assert!(set_day_words(&d, "2026-02-30", &json!(5)).is_err() && set_day_words(&d, "2026-11-01", &json!(-1)).is_err());
        set_day_words(&d, "2026-11-10", &json!(300)).unwrap();
        set_day_words(&d, "2026-11-10", &json!(120)).unwrap(); // стирание не уменьшает
        set_day_words(&d, "2026-11-11", &json!(50)).unwrap();
        assert_eq!(read_days(&d)["2026-11-10"], 300);
        let s = summary(&d, SummaryIn { today: "2026-11-12", today_words: &json!(0), goal: Some(1000), deadline: Some("2026-11-15"), total: 350 }).unwrap();
        assert_eq!(s["streak"], 2); // сегодня пусто: считаем до вчера
        assert_eq!(s["last"].as_array().unwrap().len(), 14);
        assert_eq!(s["last"][13], json!({ "date": "2026-11-12", "words": 0 }));
        assert_eq!(s["avg7"], 50); // 350 / 7
        assert_eq!(s["plan"], json!({ "left": 650, "daysLeft": 4, "perDay": 163, "overdue": false, "done": false }));
        let late = summary(&d, SummaryIn { today: "2026-11-20", today_words: &json!(40), goal: Some(1000), deadline: Some("2026-11-15"), total: 350 }).unwrap();
        assert_eq!((late["plan"]["overdue"].clone(), late["streak"].clone(), late["last"][13]["words"].clone()), (json!(true), json!(1), json!(40)));
        let done = summary(&d, SummaryIn { today: "2026-11-12", today_words: &json!(0), goal: Some(300), deadline: Some("2026-11-15"), total: 350 }).unwrap();
        assert_eq!(done["plan"]["done"], true);
        assert!(summary(&d, SummaryIn { today: "2026-11-12", today_words: &json!(0), goal: None, deadline: None, total: 0 }).unwrap()["plan"].is_null());
    }

    #[test]
    fn set_day_words_rejects_corrupt_and_unreadable_without_overwriting() {
        // Порча JSON: запись запрещена, исходный файл не меняется.
        let d = tmpdir("stats-corrupt");
        fs::write(d.join("stats.json"), "{ битый").unwrap();
        assert!(set_day_words(&d, "2026-11-10", &json!(5)).is_err());
        assert_eq!(fs::read_to_string(d.join("stats.json")).unwrap(), "{ битый");
        // Ошибка чтения (на месте файла каталог): запись запрещена, каталог не трогаем.
        let e = tmpdir("stats-readerr");
        fs::create_dir(e.join("stats.json")).unwrap();
        assert!(set_day_words(&e, "2026-11-10", &json!(5)).is_err());
        assert!(e.join("stats.json").is_dir());
    }

    #[test]
    fn set_day_words_rejects_unsupported_structure_without_overwriting() {
        // JSON разбирается, но структура не поддерживается писателями (все пишут {"days":{...}}):
        // запись должна остановиться, исходные байты — не меняться.
        for raw in [r#"{"days":[]}"#, r#"{"days":5}"#, r#"{"days":"x"}"#, r#"{"days":true}"#, "[]", r#""x""#, "5"] {
            let d = tmpdir("stats-structure");
            fs::write(d.join("stats.json"), raw).unwrap();
            let res = set_day_words(&d, "2026-11-10", &json!(5));
            let err = res.expect_err(&format!("неподдерживаемая структура должна останавливать запись: {raw}"));
            assert!(err.contains("Запись остановлена"), "понятная ошибка приложения: {err}");
            assert_eq!(fs::read_to_string(d.join("stats.json")).unwrap(), raw, "исходные байты не изменились: {raw}");
        }
        // Отсутствующее поле days или null — пустая статистика (совместимость: так же читает JS-версия).
        for raw in ["{}", r#"{"days":null}"#, r#"{"days":{}}"#] {
            let d = tmpdir("stats-empty-structure");
            fs::write(d.join("stats.json"), raw).unwrap();
            set_day_words(&d, "2026-11-10", &json!(7)).unwrap();
            assert_eq!(read_days(&d)["2026-11-10"], 7, "пустая структура принимается: {raw}");
        }
    }

    #[test]
    fn set_day_words_creates_when_absent_and_keeps_max() {
        let d = tmpdir("stats-absent");
        assert!(read_days(&d).is_empty());
        set_day_words(&d, "2026-11-10", &json!(100)).unwrap();
        set_day_words(&d, "2026-11-10", &json!(40)).unwrap(); // стирание не уменьшает
        set_day_words(&d, "2026-11-10", &json!(120)).unwrap();
        assert_eq!(read_days(&d)["2026-11-10"], 120);
    }

    #[test]
    fn set_day_words_serializes_parallel_writes() {
        use std::sync::Arc;
        // Разные даты: ни одна параллельная запись не теряется.
        let d = Arc::new(tmpdir("stats-par"));
        let mut threads = Vec::new();
        for i in 0..21u32 {
            let d = d.clone();
            threads.push(std::thread::spawn(move || {
                let day = format!("2026-11-{:02}", (i % 7) + 1);
                set_day_words(d.as_path(), &day, &json!(i + 1)).unwrap();
            }));
        }
        for t in threads { t.join().unwrap(); }
        let days = read_days(d.as_path());
        for k in 1..=7 {
            assert!(days.contains_key(&format!("2026-11-{:02}", k)), "параллельная запись потеряла день {}", k);
        }
        // Одинаковая дата: правило дневного максимума сохраняется и под параллелью.
        let same = tmpdir("stats-par-same");
        let mut threads = Vec::new();
        for i in 0..16u32 {
            let same = same.clone();
            threads.push(std::thread::spawn(move || { set_day_words(&same, "2026-11-15", &json!((i + 1) * 10)).unwrap(); }));
        }
        for t in threads { t.join().unwrap(); }
        assert_eq!(read_days(&same)["2026-11-15"], 160);
    }
}
