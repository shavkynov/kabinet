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

pub fn read_days(dir: &Path) -> Map<String, Value> {
    let mut out = Map::new();
    let raw: Value = std::fs::read_to_string(dir.join(FILE)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    if let Some(days) = raw["days"].as_object() {
        for (k, v) in days {
            let n = v.as_f64().map(|x| x.floor()).unwrap_or(0.0);
            if valid_date(k) && n.is_finite() && n > 0.0 { out.insert(k.clone(), json!(n.min(1_000_000.0) as i64)); }
        }
    }
    out
}

fn get(days: &Map<String, Value>, d: &str) -> i64 { days.get(d).and_then(|v| v.as_i64()).unwrap_or(0) }

/// Записывает слова за день. При записи с другого устройства берём большее значение.
pub fn set_day_words(dir: &Path, date: &str, words: &Value) -> R<()> {
    if !valid_date(date) { return Err("Неверная дата.".into()); }
    let n = words.as_f64().or_else(|| words.as_str().and_then(|s| s.trim().parse().ok())).map(|x| x.floor());
    let n = match n { Some(n) if n.is_finite() && n >= 0.0 => n.min(1_000_000.0) as i64, _ => return Err("Неверное число слов.".into()) };
    let mut days = read_days(dir);
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
}
