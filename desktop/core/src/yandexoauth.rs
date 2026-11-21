//! Вход в Яндекс через браузер (OAuth с PKCE). Порт src/yandex-oauth.js и части src/yandex-desktop.js.
//! Приложение открывает страницу Яндекса, а ответ возвращается ссылкой kabinet://oauth/yandex?… (см. docs/oauth/yandex).
//! Окну отдаётся только одноразовый «билет»: сам токен остаётся в ядре и попадает в защищённое хранилище.
use crate::store::R;
use crate::http::{Http, Req};
use crate::yandexdisk::PREFIX;
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const CLIENT_ID: &str = "ad77a3cab040483a967554354d75d03a";
const REDIRECT_URI: &str = "https://shavkynov.github.io/kabinet/oauth/yandex/";
pub const CALLBACK_URI: &str = "kabinet://oauth/yandex";
const SCOPES: [&str; 2] = ["cloud_api:disk.read", "cloud_api:disk.write"];
const TTL: Duration = Duration::from_secs(600);
const TICKET_TTL: Duration = Duration::from_secs(90);

type Reply = R<(String, String)>;
type HttpFactory = Arc<dyn Fn() -> Box<dyn Http> + Send + Sync>;

struct Pending { verifier: String, state: String, deadline: Instant, receiving: bool, tx: Sender<Reply> }
struct Ticket { user: String, creds: String, until: Instant }

pub struct YandexAuth {
    pending: Mutex<Option<Pending>>,
    tickets: Mutex<HashMap<String, Ticket>>,
    make_http: HttpFactory,
}

fn b64url(b: &[u8]) -> String { base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b) }
fn rand_bytes() -> [u8; 32] { rand::random() }
fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{:02x}", x)).collect() }
fn now_ms() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0) }
fn same(a: &str, b: &str) -> bool { a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0 }
fn valid_code(c: &str) -> bool { !c.is_empty() && c.len() <= 2048 && c.bytes().all(|b| (0x20..=0x7e).contains(&b)) }

impl YandexAuth {
    pub fn new(make_http: HttpFactory) -> Self { YandexAuth { pending: Mutex::new(None), tickets: Mutex::new(HashMap::new()), make_http } }

    /// Открывает вход и ждёт возврата в приложение. Результат: { user, ticket }.
    pub fn run(&self, open: &dyn Fn(&str) -> bool) -> R<Value> {
        let (tx, rx) = channel();
        let (verifier, state) = (b64url(&rand_bytes()), b64url(&rand_bytes()));
        {
            let mut g = self.pending.lock().unwrap();
            if g.as_ref().map(|p| Instant::now() < p.deadline).unwrap_or(false) { return Err("Вход в Яндекс уже выполняется.".into()); }
            *g = Some(Pending { verifier: verifier.clone(), state: state.clone(), deadline: Instant::now() + TTL, receiving: false, tx });
        }
        let mut u = url::Url::parse("https://oauth.yandex.ru/authorize").unwrap();
        u.query_pairs_mut().append_pair("response_type", "code").append_pair("client_id", CLIENT_ID).append_pair("redirect_uri", REDIRECT_URI)
            .append_pair("scope", &SCOPES.join(" ")).append_pair("state", &state).append_pair("code_challenge_method", "S256")
            .append_pair("code_challenge", &b64url(&Sha256::digest(verifier.as_bytes())));
        if !open(u.as_str()) { self.clear(&state); return Err("Не удалось открыть браузер.".into()); }
        loop {
            match rx.recv_timeout(Duration::from_millis(300)) {
                Ok(r) => { let (user, ticket) = r?; return Ok(json!({ "user": user, "ticket": ticket })); }
                Err(RecvTimeoutError::Timeout) => {
                    let g = self.pending.lock().unwrap();
                    match g.as_ref() {
                        Some(p) if p.state == state => if Instant::now() >= p.deadline { drop(g); self.clear(&state); return Err("Время входа истекло. Повторите подключение.".into()); },
                        _ => return Err("Подключение отменено.".into()),
                    }
                }
                Err(RecvTimeoutError::Disconnected) => return Err("Подключение отменено.".into()),
            }
        }
    }

    fn clear(&self, state: &str) {
        let mut g = self.pending.lock().unwrap();
        if g.as_ref().map(|p| p.state == state).unwrap_or(false) { *g = None; }
    }

    pub fn cancel(&self) {
        if let Some(p) = self.pending.lock().unwrap().take() { let _ = p.tx.send(Err("Подключение отменено.".into())); }
    }

    /// Ссылка kabinet://… из системы. Чужие и устаревшие ссылки молча игнорируются. true — ссылка принята.
    pub fn receive(&self, raw: &str) -> bool {
        if raw.len() > 8192 { return false; }
        let Ok(u) = url::Url::parse(raw) else { return false };
        let mut base = u.clone();
        base.set_query(None);
        base.set_fragment(None);
        if base.as_str() != CALLBACK_URI { return false; }
        let get = |k: &str| -> Vec<String> { u.query_pairs().filter(|(n, _)| n == k).map(|(_, v)| v.to_string()).collect() };
        let state = get("state");
        let (verifier, my_state) = {
            let mut g = self.pending.lock().unwrap();
            let Some(p) = g.as_mut() else { return false };
            if state.len() != 1 || !same(&state[0], &p.state) || p.receiving { return false; }
            p.receiving = true;
            (p.verifier.clone(), p.state.clone())
        };
        let result = self.finish(&u, &verifier, &get("code"), &get("error"), u.fragment().is_some());
        let mut g = self.pending.lock().unwrap();
        if !g.as_ref().map(|p| p.state == my_state).unwrap_or(false) { return true; } // тем временем отменили
        let p = g.take().unwrap();
        let _ = p.tx.send(result.map(|creds| {
            let user = format!("{}{}", PREFIX, hex(&rand::random::<[u8; 16]>()));
            let ticket = hex(&rand_bytes());
            let mut t = self.tickets.lock().unwrap();
            t.retain(|_, x| x.until > Instant::now());
            t.insert(ticket.clone(), Ticket { user: user.clone(), creds, until: Instant::now() + TICKET_TTL });
            (user, ticket)
        }));
        true
    }

    fn finish(&self, u: &url::Url, verifier: &str, code: &[String], error: &[String], has_fragment: bool) -> R<String> {
        if has_fragment { return Err("Неверный адрес возврата.".into()); }
        for k in ["error_description"] { if u.query_pairs().filter(|(n, _)| n == k).count() > 1 { return Err("Повторяющиеся параметры OAuth.".into()); } }
        if code.len() > 1 || error.len() > 1 { return Err("Повторяющиеся параметры OAuth.".into()); }
        if !code.is_empty() && !error.is_empty() { return Err("Противоречивый ответ OAuth.".into()); }
        if !error.is_empty() { return Err("Доступ не предоставлен.".into()); }
        let code = code.first().filter(|c| valid_code(c)).ok_or("Некорректный код авторизации.")?;
        let body = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("grant_type", "authorization_code").append_pair("client_id", CLIENT_ID)
            .append_pair("code", code).append_pair("code_verifier", verifier).finish();
        let res = (self.make_http)().request(Req {
            method: "POST".into(), url: "https://oauth.yandex.ru/token".into(),
            headers: vec![("Content-Type".into(), "application/x-www-form-urlencoded".into())], body: Some(body.into_bytes()),
        }).map_err(|_| "Не удалось связаться с Яндексом. Повторите подключение.".to_string())?;
        if res.status != 200 { return Err("Яндекс не выдал токен. Повторите подключение.".into()); }
        let d: Value = serde_json::from_slice(&res.body).map_err(|_| "Некорректный ответ Яндекса.".to_string())?;
        let token = d["access_token"].as_str().unwrap_or("");
        let bad = || "Некорректные параметры токена.".to_string();
        let expires_in = d["expires_in"].as_f64().filter(|e| e.is_finite() && *e > 0.0).ok_or_else(bad)?;
        if token.is_empty() || token.len() > 16384 || !d["token_type"].as_str().unwrap_or("").eq_ignore_ascii_case("bearer")
            || (!d["refresh_token"].is_null() && !d["refresh_token"].is_string()) { return Err(bad()); }
        if !d["scope"].is_null() {
            let scope = d["scope"].as_str().ok_or_else(bad)?;
            if !SCOPES.iter().all(|s| scope.split_whitespace().any(|x| x == *s)) { return Err("Не предоставлены права чтения и записи Диска.".into()); }
        }
        Ok(json!({ "kind": "kabinet-yandex-oauth", "accessToken": token, "refreshToken": d["refresh_token"].as_str(),
            "expiresAt": now_ms() + (expires_in * 1000.0) as i64, "tokenType": "bearer" }).to_string())
    }

    /// Только для тестов: выдаёт билет на готовые данные входа, минуя браузер.
    #[cfg(test)]
    pub fn test_ticket(&self, user: &str, creds: &str) -> String {
        let t = hex(&rand_bytes());
        self.tickets.lock().unwrap().insert(t.clone(), Ticket { user: user.into(), creds: creds.into(), until: Instant::now() + TICKET_TTL });
        t
    }

    /// Обменивает билет из окна на данные входа (один раз).
    pub fn take_ticket(&self, ticket: &str, user: &str) -> R<String> {
        let t = self.tickets.lock().unwrap().remove(ticket);
        match t { Some(t) if t.user == user && Instant::now() < t.until => Ok(t.creds), _ => Err("Подключение устарело. Войдите в Яндекс заново.".into()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::Resp;

    struct Token(u16, Value, Arc<Mutex<Vec<String>>>);
    impl Http for Token {
        fn request(&self, r: Req) -> Result<Resp, String> {
            self.2.lock().unwrap().push(String::from_utf8_lossy(&r.body.unwrap()).to_string());
            Ok(Resp { status: self.0, body: self.1.to_string().into_bytes(), location: None })
        }
    }

    fn auth(status: u16, body: Value) -> (Arc<YandexAuth>, Arc<Mutex<Vec<String>>>) {
        let log = Arc::new(Mutex::new(vec![]));
        let l = log.clone();
        (Arc::new(YandexAuth::new(Arc::new(move || Box::new(Token(status, body.clone(), l.clone())) as Box<dyn Http>))), log)
    }

    fn start(a: &Arc<YandexAuth>) -> (std::thread::JoinHandle<R<Value>>, Arc<Mutex<Option<String>>>) {
        let url = Arc::new(Mutex::new(None));
        let (a2, u2) = (a.clone(), url.clone());
        let h = std::thread::spawn(move || a2.run(&|u| { *u2.lock().unwrap() = Some(u.to_string()); true }));
        for _ in 0..100 { if url.lock().unwrap().is_some() { break; } std::thread::sleep(Duration::from_millis(20)); }
        (h, url)
    }

    fn state_of(url: &str) -> String { url::Url::parse(url).unwrap().query_pairs().find(|(k, _)| k == "state").unwrap().1.to_string() }

    #[test]
    fn full_flow_and_ticket() {
        let (a, log) = auth(200, json!({ "access_token": "T0K", "token_type": "bearer", "expires_in": 3600, "refresh_token": "R", "scope": "cloud_api:disk.read cloud_api:disk.write" }));
        let (h, url) = start(&a);
        let url = url.lock().unwrap().clone().unwrap();
        assert!(url.starts_with("https://oauth.yandex.ru/authorize?") && url.contains("code_challenge_method=S256") && url.contains("client_id=ad77a3cab040483a967554354d75d03a"));
        let state = state_of(&url);
        assert_eq!(state.len(), 43);
        assert!(!a.receive("kabinet://oauth/yandex?state=чужой&code=1"));
        assert!(!a.receive("kabinet://other/yandex?state=x"));
        assert!(a.receive(&format!("kabinet://oauth/yandex?state={}&code=abc123", state)));
        assert!(!a.receive(&format!("kabinet://oauth/yandex?state={}&code=abc123", state)), "вход завершён: повтор игнорируется");
        let r = h.join().unwrap().unwrap();
        let (user, ticket) = (r["user"].as_str().unwrap(), r["ticket"].as_str().unwrap());
        assert!(crate::yandexdisk::is_oauth_user(user));
        assert!(log.lock().unwrap()[0].contains("code=abc123") && log.lock().unwrap()[0].contains("code_verifier="));
        assert!(a.take_ticket(ticket, "oauth-yandex:00000000000000000000000000000000").is_err());
        assert!(a.take_ticket(ticket, user).is_err(), "билет одноразовый: после неудачной попытки он уже сгорел");
    }

    #[test]
    fn ticket_gives_credentials_once() {
        let (a, _) = auth(200, json!({ "access_token": "T0K", "token_type": "Bearer", "expires_in": 3600 }));
        let (h, url) = start(&a);
        let state = state_of(&url.lock().unwrap().clone().unwrap());
        assert!(a.receive(&format!("kabinet://oauth/yandex?state={}&code=c", state)));
        let r = h.join().unwrap().unwrap();
        let creds: Value = serde_json::from_str(&a.take_ticket(r["ticket"].as_str().unwrap(), r["user"].as_str().unwrap()).unwrap()).unwrap();
        assert_eq!((creds["kind"].as_str(), creds["accessToken"].as_str()), (Some("kabinet-yandex-oauth"), Some("T0K")));
        assert!(creds["expiresAt"].as_i64().unwrap() > now_ms());
        assert!(a.take_ticket(r["ticket"].as_str().unwrap(), r["user"].as_str().unwrap()).is_err());
    }

    #[test]
    fn denial_bad_token_and_cancel() {
        let (a, _) = auth(200, json!({}));
        let (h, url) = start(&a);
        let state = state_of(&url.lock().unwrap().clone().unwrap());
        assert!(a.receive(&format!("kabinet://oauth/yandex?state={}&error=access_denied", state)));
        assert_eq!(h.join().unwrap().unwrap_err(), "Доступ не предоставлен.");

        let (h, url) = start(&a);
        let state = state_of(&url.lock().unwrap().clone().unwrap());
        assert!(a.receive(&format!("kabinet://oauth/yandex?state={}&code=c", state)));
        assert_eq!(h.join().unwrap().unwrap_err(), "Некорректные параметры токена.");

        let (b, _) = auth(400, json!({}));
        let (h, url) = start(&b);
        let state = state_of(&url.lock().unwrap().clone().unwrap());
        b.receive(&format!("kabinet://oauth/yandex?state={}&code=c", state));
        assert_eq!(h.join().unwrap().unwrap_err(), "Яндекс не выдал токен. Повторите подключение.");

        let (h, _url) = start(&a);
        a.cancel();
        assert_eq!(h.join().unwrap().unwrap_err(), "Подключение отменено.");
        assert!(!a.receive("kabinet://oauth/yandex?state=x&code=c"));
        // второй вход, пока идёт первый, не начинается
        let (h, _u) = start(&a);
        assert_eq!(a.run(&|_| true).unwrap_err(), "Вход в Яндекс уже выполняется.");
        a.cancel();
        let _ = h.join();
    }
}
