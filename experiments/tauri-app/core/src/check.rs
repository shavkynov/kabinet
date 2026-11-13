//! Проверка орфографии, пунктуации и грамматики через LanguageTool (публичный сервер или свой). Порт src/langcheck.js
//! и обработчиков check:* из main.js. Ничего не правит сама: возвращает замечания, автор принимает или пропускает каждое.
//! Позиции считаются в единицах UTF-16, как в JavaScript и в ответе сервера.
use crate::dict;
use crate::store::{self, write_atomic, R};
use crate::webdav::{Http, Req};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const PUBLIC_SERVER: &str = "https://api.languagetool.org/v2";
pub const MAX_CHUNK: usize = 12000;
const PUBLIC_GAP_MS: u64 = 3200;
pub const CHECK_KINDS: [&str; 6] = ["spelling", "punctuation", "grammar", "style", "typography", "other"];

pub fn normalize_server(url: &str) -> String {
    let mut s = url.trim().to_string();
    if s.is_empty() { return PUBLIC_SERVER.to_string(); }
    if !(s.to_lowercase().starts_with("http://") || s.to_lowercase().starts_with("https://")) { s = format!("http://{}", s); }
    while s.ends_with('/') { s.pop(); }
    if !s.to_lowercase().ends_with("/v2") { s.push_str("/v2"); }
    s
}

pub fn is_local_server(url: &str) -> bool {
    url::Url::parse(&normalize_server(url)).ok().and_then(|u| u.host_str().map(String::from))
        .map(|h| matches!(h.as_str(), "localhost" | "127.0.0.1" | "[::1]" | "::1")).unwrap_or(false)
}

#[derive(Clone, Debug, PartialEq)]
pub struct Part { pub para: usize, pub start: usize, pub len: usize, pub off: usize }
#[derive(Clone, Debug, PartialEq)]
pub struct Chunk { pub text: Vec<u16>, pub parts: Vec<Part> }

fn last_index_of(hay: &[u16], needle: &[u16]) -> i64 {
    if needle.len() > hay.len() { return -1; }
    (0..=hay.len() - needle.len()).rev().find(|&i| hay[i..i + needle.len()] == *needle).map(|i| i as i64).unwrap_or(-1)
}

fn is_blank(u: &[u16]) -> bool { String::from_utf16_lossy(u).trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}').is_empty() }

/// Режет абзацы на куски не длиннее max знаков.
pub fn build_chunks(paragraphs: &[String], max: usize) -> Vec<Chunk> {
    struct Piece { para: usize, start: usize, text: Vec<u16> }
    let mut pieces: Vec<Piece> = Vec::new();
    for (para, p) in paragraphs.iter().enumerate() {
        let s: Vec<u16> = p.encode_utf16().collect();
        if is_blank(&s) { continue; }
        if s.len() <= max { pieces.push(Piece { para, start: 0, text: s }); continue; }
        let mut i = 0;
        while i < s.len() {
            let mut end = (i + max).min(s.len());
            if end < s.len() {
                let win = &s[i..end];
                let enc = |t: &str| t.encode_utf16().collect::<Vec<u16>>();
                let mut cut = last_index_of(win, &enc(". ")).max(last_index_of(win, &enc("! "))).max(last_index_of(win, &enc("? ")));
                if (cut as f64) < max as f64 * 0.5 { cut = last_index_of(win, &enc(" ")); }
                if cut > 0 { end = i + cut as usize + 1; }
            }
            pieces.push(Piece { para, start: i, text: s[i..end].to_vec() });
            i = end;
        }
    }
    let mut chunks = Vec::new();
    let mut cur = Chunk { text: vec![], parts: vec![] };
    for pc in pieces {
        let add = pc.text.len() + 1;
        if !cur.parts.is_empty() && cur.text.len() + add > max { chunks.push(std::mem::replace(&mut cur, Chunk { text: vec![], parts: vec![] })); }
        cur.parts.push(Part { para: pc.para, start: pc.start, len: pc.text.len(), off: cur.text.len() });
        cur.text.extend_from_slice(&pc.text);
        cur.text.push(10);
    }
    if !cur.parts.is_empty() { chunks.push(cur); }
    chunks
}

fn kind_of(m: &Value) -> &'static str {
    let cat = m["rule"]["category"]["id"].as_str().unwrap_or("");
    let issue = m["rule"]["issueType"].as_str().unwrap_or("").to_lowercase();
    let id = m["rule"]["id"].as_str().unwrap_or("");
    let rule_id_up = id.to_uppercase();
    if cat == "TYPOS" || issue == "misspelling" { "spelling" }
    else if cat == "PUNCTUATION" || rule_id_up.contains("COMMA") || rule_id_up.contains("PUNCT") { "punctuation" }
    else if cat == "TYPOGRAPHY" || issue == "typographical" { "typography" }
    else if cat == "STYLE" || cat == "REDUNDANCY" || issue == "style" { "style" }
    else if cat == "GRAMMAR" || issue == "grammar" { "grammar" }
    else { "other" }
}

/// Ответ сервера по куску → замечания с позициями внутри абзацев.
pub fn map_matches(chunk: &Chunk, matches: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for m in matches.as_array().cloned().unwrap_or_default() {
        let (Some(off), len) = (m["offset"].as_u64().map(|x| x as usize), m["length"].as_u64().unwrap_or(0) as usize) else { continue };
        let Some(part) = chunk.parts.iter().find(|p| off >= p.off && off < p.off + p.len + 1) else { continue };
        let offset = part.start + (off - part.off);
        let end = (off + len).min(chunk.text.len());
        let text = String::from_utf16_lossy(&chunk.text[off.min(end)..end]);
        if len == 0 || text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}').is_empty() { continue; }
        let repl: Vec<String> = m["replacements"].as_array().map(|a| a.iter().take(6).map(|r| r["value"].as_str().map(String::from).unwrap_or_else(|| r["value"].to_string())).filter(|v| *v != text).collect()).unwrap_or_default();
        out.push(json!({
            "para": part.para, "offset": offset, "length": len, "text": text,
            "message": m["message"].as_str().unwrap_or(""), "short": m["shortMessage"].as_str().unwrap_or(""),
            "ruleId": m["rule"]["id"].as_str().unwrap_or(""), "kind": kind_of(&m), "replacements": repl,
        }));
    }
    out
}

pub fn clean_kinds(list: &Value) -> Vec<String> {
    let set: Vec<String> = list.as_array().map(|a| a.iter().map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).collect()).unwrap_or_default();
    CHECK_KINDS.iter().filter(|k| set.iter().any(|s| s == *k)).map(|k| k.to_string()).collect()
}

pub fn filter_issues(issues: Vec<Value>, disabled: &[String], words: &[String], hidden: &[String]) -> Vec<Value> {
    let known: Vec<String> = words.iter().map(|w| w.to_lowercase()).collect();
    issues.into_iter().filter(|i| {
        if disabled.iter().any(|d| Some(d.as_str()) == i["ruleId"].as_str()) { return false; }
        if hidden.iter().any(|h| Some(h.as_str()) == i["kind"].as_str()) { return false; }
        !(i["kind"] == "spelling" && known.contains(&i["text"].as_str().unwrap_or("").to_lowercase()))
    }).collect()
}

pub struct Opts {
    pub server: String,
    pub lang: String,
    pub disabled_rules: Vec<String>,
    pub hidden_kinds: Vec<String>,
    pub words: Vec<String>,
    pub max_chunk: usize,
    pub gap_ms: Option<u64>,
    pub retry_wait_ms: Option<u64>,
}

fn sleep_abortable(ms: u64, cancel: &AtomicBool) {
    let mut left = ms;
    while left > 0 && !cancel.load(Ordering::SeqCst) { let step = left.min(100); std::thread::sleep(Duration::from_millis(step)); left -= step; }
}

fn request_check(http: &dyn Http, server: &str, text: &str, o: &Opts, cancel: &AtomicBool) -> R<Value> {
    let lang = match o.lang.as_str() { "en" => "en-US", "auto" => "auto", _ => "ru-RU" };
    let mut form = url::form_urlencoded::Serializer::new(String::new());
    form.append_pair("text", text).append_pair("language", lang);
    if lang == "auto" { form.append_pair("preferredVariants", "en-US"); }
    if !o.disabled_rules.is_empty() { form.append_pair("disabledRules", &o.disabled_rules.join(",")); }
    let body = form.finish();
    for attempt in 0..2 {
        let res = http.request(Req {
            method: "POST".into(), url: format!("{}/check", server),
            headers: vec![("Content-Type".into(), "application/x-www-form-urlencoded".into()), ("Accept".into(), "application/json".into())],
            body: Some(body.clone().into_bytes()),
        });
        let res = match res {
            Ok(r) => r,
            Err(_) => {
                if cancel.load(Ordering::SeqCst) { return Err("Проверка остановлена.".into()); }
                return Err(format!("Не удалось связаться со службой проверки ({}). Проверьте интернет или адрес сервера.", server.trim_end_matches("/v2")));
            }
        };
        if res.status == 429 && attempt == 0 { sleep_abortable(o.retry_wait_ms.unwrap_or(PUBLIC_GAP_MS * 4), cancel); continue; }
        if res.status == 429 { return Err("Служба проверки просит подождать (слишком много запросов). Попробуйте через минуту.".into()); }
        if !(200..300).contains(&res.status) { return Err(format!("Служба проверки ответила ошибкой {}.", res.status)); }
        return serde_json::from_slice(&res.body).map_err(|_| "Служба проверки вернула непонятный ответ.".to_string());
    }
    Ok(json!({ "matches": [] }))
}

pub fn check_paragraphs(http: &dyn Http, paragraphs: &[String], o: &Opts, cancel: &AtomicBool, progress: &dyn Fn(usize, usize)) -> R<Vec<Value>> {
    let server = normalize_server(&o.server);
    let gap = o.gap_ms.unwrap_or(if server == PUBLIC_SERVER { PUBLIC_GAP_MS } else { 0 });
    let chunks = build_chunks(paragraphs, o.max_chunk);
    let mut all: Vec<Value> = Vec::new();
    for (i, ch) in chunks.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) { return Err("Проверка остановлена.".into()); }
        progress(i, chunks.len());
        if i > 0 && gap > 0 { sleep_abortable(gap, cancel); }
        let json = request_check(http, &server, &String::from_utf16_lossy(&ch.text), o, cancel)?;
        all.extend(map_matches(ch, &json["matches"]));
    }
    progress(chunks.len(), chunks.len());
    all.sort_by_key(|x| (x["para"].as_u64().unwrap_or(0), x["offset"].as_u64().unwrap_or(0)));
    let mut all = filter_issues(all, &o.disabled_rules, &o.words, &o.hidden_kinds);
    for (n, x) in all.iter_mut().enumerate() { x["id"] = json!(n + 1); }
    Ok(all)
}

// ---------- настройки и словарь (main.js) ----------

fn strs(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().map(|x| x.as_str().map(|s| s.trim().to_string()).unwrap_or_else(|| x.to_string().trim().to_string())).filter(|s| !s.is_empty()).take(5000).collect()).unwrap_or_default()
}

pub struct CheckApi {
    data_dir: PathBuf,
    make_http: Arc<dyn Fn() -> Box<dyn Http> + Send + Sync>,
    running: Mutex<Option<Arc<AtomicBool>>>,
}

impl CheckApi {
    pub fn new(data_dir: &Path, make_http: Arc<dyn Fn() -> Box<dyn Http> + Send + Sync>) -> Self {
        CheckApi { data_dir: data_dir.to_path_buf(), make_http, running: Mutex::new(None) }
    }

    fn file(&self) -> PathBuf { self.data_dir.join("check.json") }

    pub fn load(&self) -> Map<String, Value> {
        let mut cfg: Map<String, Value> = json!({ "consent": false, "server": "", "lang": "ru", "disabledRules": [], "hiddenKinds": [], "words": [] }).as_object().unwrap().clone();
        if let Some(Value::Object(raw)) = std::fs::read_to_string(self.file()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
            for (k, v) in raw { cfg.insert(k, v); }
        }
        cfg
    }

    fn save(&self, cfg: &Map<String, Value>) -> R<()> {
        let _ = std::fs::create_dir_all(&self.data_dir);
        write_atomic(&self.file(), &serde_json::to_string_pretty(&Value::Object(cfg.clone())).unwrap())
    }

    fn shared_words(cfg: &Map<String, Value>) -> Vec<String> { strs(cfg.get("words").unwrap_or(&Value::Null)) }

    fn project_words(dir: Option<&Path>) -> Option<Vec<String>> { dir.and_then(|d| store::project_words(d).ok().flatten()) }

    pub fn set_lang_if_fixed(&self, next: &str) {
        let mut cfg = self.load();
        let cur = cfg["lang"].as_str().unwrap_or("ru").to_string();
        if cur != "auto" && cur != next { cfg.insert("lang".into(), json!(next)); let _ = self.save(&cfg); }
    }

    pub fn call(&self, op: &str, a: &[Value], project: Option<&Path>, progress: &dyn Fn(usize, usize)) -> R<Value> {
        match op {
            "getConfig" => Ok(Value::Object(self.load())),
            "setConfig" => {
                let mut cur = self.load();
                let p = a.first().and_then(|v| v.as_object()).cloned().unwrap_or_default();
                if let Some(v) = p.get("consent") { cur.insert("consent".into(), json!(v.as_bool().unwrap_or(false))); }
                if let Some(v) = p.get("lang") { cur.insert("lang".into(), json!(match v.as_str() { Some("en") => "en", Some("auto") => "auto", _ => "ru" })); }
                if let Some(v) = p.get("server") {
                    let t = v.as_str().unwrap_or("").trim().to_string();
                    if !t.is_empty() {
                        let u = url::Url::parse(&normalize_server(&t)).map_err(|_| "Адрес сервера записан неверно.".to_string())?;
                        if u.scheme() != "http" && u.scheme() != "https" { return Err("Адрес сервера должен начинаться с http:// или https://".into()); }
                    }
                    cur.insert("server".into(), json!(t));
                }
                if let Some(v) = p.get("disabledRules") { cur.insert("disabledRules".into(), json!(strs(v))); }
                if let Some(v) = p.get("hiddenKinds") { cur.insert("hiddenKinds".into(), json!(clean_kinds(v))); }
                if let Some(v) = p.get("words") { cur.insert("words".into(), json!(strs(v))); }
                self.save(&cur)?;
                Ok(Value::Object(cur))
            }
            "run" => {
                let cfg = self.load();
                let paragraphs: Vec<String> = a.first().and_then(|v| v.as_array()).ok_or("Нет текста для проверки.")?
                    .iter().map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).collect();
                let server = cfg["server"].as_str().unwrap_or("").to_string();
                if cfg["consent"] != json!(true) && !is_local_server(&server) { return Err("Сначала нужно разрешить отправку текста службе проверки.".into()); }
                let cancel = Arc::new(AtomicBool::new(false));
                if let Some(old) = self.running.lock().unwrap().replace(cancel.clone()) { old.store(true, Ordering::SeqCst); }
                let mut words = dict::effective(Self::project_words(project).as_deref(), &Self::shared_words(&cfg));
                words.extend(strs(a.get(1).unwrap_or(&Value::Null)));
                let o = Opts {
                    server, lang: cfg["lang"].as_str().unwrap_or("ru").to_string(), disabled_rules: strs(&cfg["disabledRules"]),
                    hidden_kinds: clean_kinds(&cfg["hiddenKinds"]), words, max_chunk: MAX_CHUNK, gap_ms: None, retry_wait_ms: None,
                };
                let http = (self.make_http)();
                let res = check_paragraphs(http.as_ref(), &paragraphs, &o, &cancel, progress);
                let mut guard = self.running.lock().unwrap();
                if guard.as_ref().map(|c| Arc::ptr_eq(c, &cancel)).unwrap_or(false) { *guard = None; }
                Ok(Value::Array(res?))
            }
            "cancel" => { if let Some(c) = self.running.lock().unwrap().as_ref() { c.store(true, Ordering::SeqCst); } Ok(json!(true)) }
            "addWord" => {
                let w = a.first().and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
                if w.is_empty() || w.encode_utf16().count() > dict::MAX_LEN { return Ok(json!(false)); }
                let mut cfg = self.load();
                let mut shared = Self::shared_words(&cfg);
                if !shared.contains(&w) { shared.push(w.clone()); cfg.insert("words".into(), json!(shared)); self.save(&cfg)?; }
                if let Some(d) = project {
                    let next = dict::with_word(Self::project_words(project).as_deref(), &Self::shared_words(&cfg), &w);
                    store::set_project_words(d, &next)?;
                }
                Ok(json!(true))
            }
            "getDictionary" => Ok(json!(dict::effective(Self::project_words(project).as_deref(), &Self::shared_words(&self.load())))),
            "setDictionary" => {
                let mut cfg = self.load();
                let shared = Self::shared_words(&cfg);
                let before = dict::effective(Self::project_words(project).as_deref(), &shared);
                let next = dict::clean_words(a.first().and_then(|v| v.as_array()).map(|x| x.as_slice()).unwrap_or(&[]));
                if let Some(d) = project { store::set_project_words(d, &next)?; }
                cfg.insert("words".into(), json!(dict::merge_shared(&shared, &before, &next)));
                self.save(&cfg)?;
                Ok(json!(next))
            }
            "ignoreRule" => {
                let id = a.first().and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
                if id.is_empty() { return Ok(json!(false)); }
                let mut cfg = self.load();
                let mut rules = strs(&cfg["disabledRules"]);
                if !rules.contains(&id) { rules.push(id); cfg.insert("disabledRules".into(), json!(rules)); self.save(&cfg)?; }
                Ok(json!(rules))
            }
            other => Err(format!("Неизвестная операция проверки: {}", other)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::tmpdir;
    use crate::webdav::Resp;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn matches_electron_chunking_and_mapping() {
        let g: Value = serde_json::from_str(include_str!("../tests/langcheck-golden.json")).unwrap();
        let paras: Vec<String> = g["paras"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
        let chunks = build_chunks(&paras, g["max"].as_u64().unwrap() as usize);
        let got: Vec<Value> = chunks.iter().map(|c| json!({ "text": String::from_utf16_lossy(&c.text),
            "parts": c.parts.iter().map(|p| json!({ "para": p.para, "start": p.start, "len": p.len, "off": p.off })).collect::<Vec<_>>() })).collect();
        assert_eq!(Value::Array(got), g["chunks"]);
        for (i, ch) in chunks.iter().enumerate() { assert_eq!(Value::Array(map_matches(ch, &g["matches"][i])), g["mapped"][i], "chunk {}", i); }
        assert_eq!(normalize_server("localhost:8081/"), "http://localhost:8081/v2");
        assert!(is_local_server("127.0.0.1:8010") && !is_local_server("") && !is_local_server("example.com"));
        assert_eq!(clean_kinds(&json!(["style", "x", "spelling", "style"])), vec!["spelling".to_string(), "style".to_string()]);
    }

    struct Fake { calls: AtomicUsize, bodies: Mutex<Vec<String>>, fail_first_429: bool }
    impl Http for Fake {
        fn request(&self, r: Req) -> Result<Resp, String> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            self.bodies.lock().unwrap().push(String::from_utf8_lossy(&r.body.unwrap()).to_string());
            if self.fail_first_429 && n == 0 { return Ok(Resp { status: 429, body: vec![] }); }
            let body = json!({ "matches": [
                { "offset": 0, "length": 6, "message": "Ошибка", "rule": { "id": "MORFOLOGIK_RULE_RU_RU", "category": { "id": "TYPOS" } }, "replacements": [{ "value": "Привет" }, { "value": "Првиет" }] },
                { "offset": 6, "length": 4, "message": "Знаки", "rule": { "id": "COMMA_X", "category": { "id": "PUNCTUATION" } }, "replacements": [] }
            ]});
            Ok(Resp { status: 200, body: body.to_string().into_bytes() })
        }
    }
    fn opts() -> Opts { Opts { server: "".into(), lang: "ru".into(), disabled_rules: vec![], hidden_kinds: vec![], words: vec![], max_chunk: MAX_CHUNK, gap_ms: Some(0), retry_wait_ms: Some(0) } }

    #[test]
    fn checks_filters_and_retries() {
        let f = Fake { calls: AtomicUsize::new(0), bodies: Mutex::new(vec![]), fail_first_429: true };
        let cancel = AtomicBool::new(false);
        let mut o = opts();
        o.words = vec!["првиет".into()];
        let r = check_paragraphs(&f, &["Првиет мир".to_string()], &o, &cancel, &|_, _| {}).unwrap();
        assert_eq!(f.calls.load(Ordering::SeqCst), 2); // одна повторная попытка после 429
        assert_eq!(r.len(), 1); // слово из словаря не отмечается
        assert_eq!(r[0]["kind"], "punctuation");
        assert_eq!(r[0]["id"], 1);
        assert!(f.bodies.lock().unwrap()[0].contains("language=ru-RU") && f.bodies.lock().unwrap()[0].contains("text=%D0%9F"));
        o.words.clear();
        o.hidden_kinds = vec!["punctuation".into()];
        let r = check_paragraphs(&f, &["Првиет мир".to_string()], &o, &cancel, &|_, _| {}).unwrap();
        assert_eq!(r[0]["replacements"], json!(["Привет"]));
        cancel.store(true, Ordering::SeqCst);
        assert_eq!(check_paragraphs(&f, &["а".to_string()], &o, &cancel, &|_, _| {}).unwrap_err(), "Проверка остановлена.");
    }

    #[test]
    fn config_consent_and_dictionary() {
        let data = tmpdir("chk");
        let api = CheckApi::new(&data, Arc::new(|| Box::new(Fake { calls: AtomicUsize::new(0), bodies: Mutex::new(vec![]), fail_first_429: false }) as Box<dyn Http>));
        let none = |_: usize, _: usize| {};
        assert_eq!(api.call("run", &[json!(["текст"])], None, &none).unwrap_err(), "Сначала нужно разрешить отправку текста службе проверки.");
        assert!(api.call("setConfig", &[json!({ "server": "http://[bad" })], None, &none).is_err());
        api.call("setConfig", &[json!({ "consent": true, "hiddenKinds": ["style", "bad"] })], None, &none).unwrap();
        assert_eq!(api.call("getConfig", &[], None, &none).unwrap()["hiddenKinds"], json!(["style"]));
        assert_eq!(api.call("run", &[json!(["Првиет мир"])], None, &none).unwrap().as_array().unwrap().len(), 2);
        // словарь проекта
        let proj = tmpdir("chkp").join("p");
        store::create_project(&proj, "П", None).unwrap();
        api.call("addWord", &[json!("Кабинет")], Some(&proj), &none).unwrap();
        api.call("addWord", &[json!("Дракон")], Some(&proj), &none).unwrap();
        assert_eq!(api.call("getDictionary", &[], Some(&proj), &none).unwrap(), json!(["Кабинет", "Дракон"]));
        assert_eq!(api.call("setDictionary", &[json!(["Дракон", "Меч"])], Some(&proj), &none).unwrap(), json!(["Дракон", "Меч"]));
        assert_eq!(api.call("getConfig", &[], None, &none).unwrap()["words"], json!(["Дракон", "Меч"]));
        assert_eq!(api.call("ignoreRule", &[json!("RULE_1")], None, &none).unwrap(), json!(["RULE_1"]));
        assert_eq!(api.call("addWord", &[json!("")], None, &none).unwrap(), json!(false));
    }
}
