//! Доступ к сетевой папке по WebDAV (Яндекс Диск, Nextcloud, Mail.ru Облако, NAS).
//! Порт src/webdav.js. HTTP вынесен в трейт `Http`, чтобы тесты шли на поддельном сервере.
use crate::remote::{Item, Remote};
use crate::store::R;
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use regex::Regex;
use std::collections::HashSet;
use std::time::Duration;

pub struct Req {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

pub struct Resp {
    pub status: u16,
    pub body: Vec<u8>,
    /// Заголовок Location у ответов-переадресаций (сами переходы клиент не выполняет).
    pub location: Option<String>,
}

pub trait Http: Send {
    fn request(&self, req: Req) -> Result<Resp, String>;
}

impl Http for Box<dyn Http> {
    fn request(&self, req: Req) -> Result<Resp, String> { (**self).request(req) }
}

/// Настоящие запросы через ureq. Коды 4xx/5xx возвращаются как обычный ответ.
pub struct UreqHttp {
    agent: ureq::Agent,
}

impl UreqHttp {
    pub fn new() -> Self { Self::with_timeout(120) }

    pub fn with_timeout(secs: u64) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(15))
            .timeout(Duration::from_secs(secs))
            .redirects(0)
            .build();
        UreqHttp { agent }
    }
}

const MAX_BODY: u64 = 256 * 1024 * 1024;

/// Читает ответ целиком, но не обрезает молча: слишком большой ответ - это ошибка, а не «файл поменьше».
pub fn read_capped(reader: impl std::io::Read, limit: u64) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut body = Vec::new();
    reader.take(limit + 1).read_to_end(&mut body).map_err(|e| e.to_string())?;
    if body.len() as u64 > limit {
        return Err(format!("ответ сервера больше {} МБ, файл не прочитан целиком", limit / (1024 * 1024)));
    }
    Ok(body)
}

impl Default for UreqHttp {
    fn default() -> Self { Self::new() }
}

impl Http for UreqHttp {
    fn request(&self, req: Req) -> Result<Resp, String> {
        let mut r = self.agent.request(&req.method, &req.url);
        for (k, v) in &req.headers { r = r.set(k, v); }
        let res = match &req.body {
            Some(b) => r.send_bytes(b),
            None => r.call(),
        };
        let resp = match res {
            Ok(x) => x,
            Err(ureq::Error::Status(_, x)) => x,
            Err(e) => return Err(e.to_string()),
        };
        let status = resp.status();
        let location = resp.header("location").map(String::from);
        let body = read_capped(resp.into_reader(), MAX_BODY)?;
        Ok(Resp { status, body, location })
    }
}

/// Повтор при обрыве связи и при ответах «подождите»/«сервер занят». Порт src/net-retry.js (упрощённо).
pub struct Retrying<H: Http> {
    pub inner: H,
    pub tries: u32,
    pub pause_ms: u64,
}

impl<H: Http> Retrying<H> {
    pub fn new(inner: H) -> Self { Retrying { inner, tries: 3, pause_ms: 700 } }
}

impl<H: Http> Http for Retrying<H> {
    fn request(&self, req: Req) -> Result<Resp, String> {
        let mut last: Result<Resp, String> = Err("нет ответа".into());
        for attempt in 0..self.tries.max(1) {
            if attempt > 0 && self.pause_ms > 0 {
                std::thread::sleep(Duration::from_millis(self.pause_ms * u64::from(attempt)));
            }
            let copy = Req { method: req.method.clone(), url: req.url.clone(), headers: req.headers.clone(), body: req.body.clone() };
            match self.inner.request(copy) {
                Ok(r) if matches!(r.status, 429 | 502 | 503 | 504) => last = Ok(r),
                Ok(r) => return Ok(r),
                Err(e) => last = Err(e),
            }
        }
        last
    }
}

// ---------- адрес ----------

/// Адрес сервера в каноническом виде: https://host/путь без «/» в конце.
pub fn normalize_url(raw: &str) -> R<String> {
    let mut s = raw.trim().to_string();
    if s.is_empty() { return Err("Введите адрес сервера.".into()); }
    let has_scheme = { static C: std::sync::OnceLock<Regex> = std::sync::OnceLock::new(); C.get_or_init(|| Regex::new(r"^(?i)[a-z][a-z0-9+.-]*://").unwrap()) }.is_match(&s);
    if !has_scheme { s = format!("https://{}", s); }
    let u = url::Url::parse(&s).map_err(|_| "Адрес сервера записан неверно.".to_string())?;
    if u.scheme() != "https" && u.scheme() != "http" { return Err("Адрес должен начинаться с https://".into()); }
    let host = u.host_str().ok_or("Адрес сервера записан неверно.")?;
    let host = if host.contains(':') { format!("[{}]", host) } else { host.to_string() };
    let hostport = match u.port() { Some(p) => format!("{}:{}", host, p), None => host };
    let p = u.path().trim_end_matches('/');
    Ok(format!("{}://{}{}", u.scheme(), hostport, p))
}

/// http:// допустим только в домашней сети: пароль идёт открытым текстом.
pub fn is_home_host(hostname: &str) -> bool {
    let h = hostname.to_lowercase();
    let h = h.trim_start_matches('[').trim_end_matches(']');
    if h == "localhost" || h == "::1" || h.ends_with(".local") || (!h.contains('.') && !h.contains(':')) { return true; }
    let parts: Vec<&str> = h.split('.').collect();
    if parts.len() == 4 && parts.iter().all(|x| !x.is_empty() && x.chars().all(|c| c.is_ascii_digit())) {
        let a: u32 = parts[0].parse().unwrap_or(999);
        let b: u32 = parts[1].parse().unwrap_or(999);
        return a == 10 || a == 127 || (a == 172 && (16..=31).contains(&b)) || (a == 192 && b == 168) || (a == 169 && b == 254);
    }
    let lower = h.to_string();
    let bytes = lower.as_bytes();
    let hex = |c: u8| c.is_ascii_hexdigit();
    (bytes.len() >= 5 && (bytes[0] == b'f') && (bytes[1] == b'c' || bytes[1] == b'd') && hex(bytes[2]) && hex(bytes[3]) && bytes[4] == b':') || lower.starts_with("fe80:")
}

fn assert_safe_transport(base: &str) -> R<()> {
    let u = url::Url::parse(base).map_err(|_| "Адрес сервера записан неверно.".to_string())?;
    if u.scheme() == "http" && !is_home_host(u.host_str().unwrap_or("")) {
        return Err("Логин и пароль нельзя отправлять по http:// через интернет. Укажите адрес с https://.".into());
    }
    Ok(())
}

pub fn to_base64(data: &[u8]) -> String {
    use ::base64::Engine as _;
    ::base64::engine::general_purpose::STANDARD.encode(data)
}

fn segs(p: &str) -> Vec<String> { p.split('/').filter(|x| !x.is_empty()).map(|x| x.to_string()).collect() }

// Как encodeURIComponent: не кодируются буквы, цифры и - _ . ! ~ * ' ( )
const COMPONENT: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'!').remove(b'~').remove(b'*').remove(b'\'').remove(b'(').remove(b')');

fn encode_path(parts: &[String]) -> String {
    parts.iter().map(|x| utf8_percent_encode(x, COMPONENT).to_string()).collect::<Vec<_>>().join("/")
}

fn unxml(s: &str) -> String {
    let mut out = s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'");
    let dec = { static C: std::sync::OnceLock<Regex> = std::sync::OnceLock::new(); C.get_or_init(|| Regex::new(r"&#(\d+);").unwrap()) };
    out = dec.replace_all(&out, |c: &regex::Captures| c[1].parse::<u32>().ok().and_then(char::from_u32).map(|x| x.to_string()).unwrap_or_default()).into_owned();
    let hex = { static C: std::sync::OnceLock<Regex> = std::sync::OnceLock::new(); C.get_or_init(|| Regex::new(r"(?i)&#x([0-9a-f]+);").unwrap()) };
    out = hex.replace_all(&out, |c: &regex::Captures| u32::from_str_radix(&c[1], 16).ok().and_then(char::from_u32).map(|x| x.to_string()).unwrap_or_default()).into_owned();
    out.replace("&amp;", "&")
}

#[derive(Clone, Debug, PartialEq)]
pub struct DavEntry {
    pub href: String,
    pub dir: bool,
    pub size: i64,
    pub mtime: i64,
}

/// Разбор ответа PROPFIND. Префиксы пространств имён любые.
pub fn parse_multistatus(xml: &str) -> Vec<DavEntry> {
    let block_re = { static C: std::sync::OnceLock<Regex> = std::sync::OnceLock::new(); C.get_or_init(|| Regex::new(r"(?is)<(?:[\w.-]+:)?response[\s>].*?</(?:[\w.-]+:)?response>").unwrap()) };
    let href_re = { static C: std::sync::OnceLock<Regex> = std::sync::OnceLock::new(); C.get_or_init(|| Regex::new(r"(?is)<(?:[\w.-]+:)?href[^>]*>(.*?)</(?:[\w.-]+:)?href>").unwrap()) };
    let coll_re = { static C: std::sync::OnceLock<Regex> = std::sync::OnceLock::new(); C.get_or_init(|| Regex::new(r"(?i)<(?:[\w.-]+:)?collection\s*/?>").unwrap()) };
    let size_re = { static C: std::sync::OnceLock<Regex> = std::sync::OnceLock::new(); C.get_or_init(|| Regex::new(r"(?i)<(?:[\w.-]+:)?getcontentlength[^>]*>(\d+)<").unwrap()) };
    let mod_re = { static C: std::sync::OnceLock<Regex> = std::sync::OnceLock::new(); C.get_or_init(|| Regex::new(r"(?i)<(?:[\w.-]+:)?getlastmodified[^>]*>([^<]*)<").unwrap()) };
    let abs_re = { static C: std::sync::OnceLock<Regex> = std::sync::OnceLock::new(); C.get_or_init(|| Regex::new(r"^(?i)[a-z][a-z0-9+.-]*://").unwrap()) };
    let mut out = Vec::new();
    for m in block_re.find_iter(xml) {
        let block = m.as_str();
        let Some(hm) = href_re.captures(block) else { continue };
        let mut href = unxml(&hm[1]).trim().to_string();
        if abs_re.is_match(&href) {
            if let Ok(u) = url::Url::parse(&href) { href = u.path().to_string(); }
        }
        // Декодируем по частям пути: %2F внутри имени не должен превращаться в разделитель и подменять файл.
        let mut decoded = Vec::new();
        let mut bad = false;
        for part in href.split('/') {
            match percent_decode_str(part).decode_utf8() {
                Ok(d) if d.contains('/') || d.contains('\0') => { bad = true; break; }
                Ok(d) => decoded.push(d.into_owned()),
                Err(_) => decoded.push(part.to_string()),
            }
        }
        if bad { continue; }
        href = decoded.join("/");
        let dir = coll_re.is_match(block);
        let size = size_re.captures(block).and_then(|c| c[1].parse().ok()).unwrap_or(0);
        let mtime = mod_re.captures(block).and_then(|c| httpdate::parse_http_date(unxml(&c[1]).trim()).ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0);
        out.push(DavEntry { href, dir, size, mtime });
    }
    out
}

const PROPFIND_BODY: &str = "<?xml version=\"1.0\" encoding=\"utf-8\"?><propfind xmlns=\"DAV:\"><prop><resourcetype/><getcontentlength/><getlastmodified/></prop></propfind>";

pub struct WebDav<H: Http> {
    http: H,
    base: String,
    origin: String,
    base_path: Vec<String>,
    root_parts: Vec<String>,
    auth: String,
    known: HashSet<String>,
}

fn ok(s: u16) -> bool { (200..300).contains(&s) }

impl<H: Http> WebDav<H> {
    pub fn new(http: H, url: &str, user: &str, pass: &str, root: &str) -> R<Self> {
        let base = normalize_url(url)?;
        assert_safe_transport(&base)?;
        let u = url::Url::parse(&base).map_err(|_| "Адрес сервера записан неверно.".to_string())?;
        let origin = u.origin().ascii_serialization();
        let base_path = segs(u.path());
        let auth = format!("Basic {}", to_base64(format!("{}:{}", user, pass).as_bytes()));
        Ok(WebDav { http, base, origin, base_path, root_parts: segs(root), auth, known: HashSet::new() })
    }

    pub fn base(&self) -> &str { &self.base }

    fn full_url(&self, parts: &[String], dir: bool) -> String {
        let mut all = self.base_path.clone();
        all.extend(self.root_parts.iter().cloned());
        all.extend(parts.iter().cloned());
        let mut u = format!("{}/{}", self.origin, encode_path(&all));
        if dir && !u.ends_with('/') { u.push('/'); }
        u
    }

    fn raw(&self, method: &str, url: String, headers: Vec<(String, String)>, body: Option<Vec<u8>>) -> R<Resp> {
        let mut h = vec![("Authorization".to_string(), self.auth.clone())];
        h.extend(headers);
        let res = self.http.request(Req { method: method.into(), url, headers: h, body })
            .map_err(|e| format!("Нет связи с сервером: {}", e))?;
        match res.status {
            401 => Err("Сервер не принял логин или пароль.".into()),
            403 => Err("Нет прав на эту папку.".into()),
            507 => Err("На сервере закончилось место.".into()),
            429 => Err("Сервер просит подождать: слишком много запросов.".into()),
            _ => Ok(res),
        }
    }

    fn send(&self, method: &str, parts: &[String], dir: bool, headers: Vec<(String, String)>, body: Option<Vec<u8>>) -> R<Resp> {
        self.raw(method, self.full_url(parts, dir), headers, body)
    }

    fn mkdir_parts(&mut self, parts: &[String]) -> R<()> {
        for i in 1..=parts.len() {
            let sub = &parts[..i];
            let key = sub.join("/");
            if self.known.contains(&key) { continue; }
            let res = self.send("MKCOL", sub, true, vec![], None)?;
            if ok(res.status) || matches!(res.status, 405 | 301 | 302) { self.known.insert(key); }
            else { return Err(format!("Не удалось создать папку «{}» (код {}).", sub[sub.len() - 1], res.status)); }
        }
        Ok(())
    }

    fn mkdir_root(&mut self) -> R<()> {
        for i in 1..=self.root_parts.len() {
            let sub: Vec<String> = self.root_parts[..i].to_vec();
            let key = format!("#r/{}", sub.join("/"));
            if self.known.contains(&key) { continue; }
            let mut all = self.base_path.clone();
            all.extend(sub.iter().cloned());
            let url = format!("{}/{}/", self.origin, encode_path(&all));
            let res = self.raw("MKCOL", url, vec![], None)?;
            if !(ok(res.status) || matches!(res.status, 405 | 301 | 302)) {
                return Err(format!("Не удалось создать папку «{}» (код {}).", sub[sub.len() - 1], res.status));
            }
            self.known.insert(key);
        }
        Ok(())
    }

    fn propfind(&self, parts: &[String], depth: u8) -> R<Option<Vec<DavEntry>>> {
        let res = self.send("PROPFIND", parts, true,
            vec![("Depth".into(), depth.to_string()), ("Content-Type".into(), "application/xml; charset=utf-8".into())],
            Some(PROPFIND_BODY.as_bytes().to_vec()))?;
        if res.status == 404 { return Ok(None); }
        if res.status != 207 && !ok(res.status) { return Err(format!("Сервер ответил кодом {}.", res.status)); }
        Ok(Some(parse_multistatus(&String::from_utf8_lossy(&res.body))))
    }

    /// Проверка доступа: ошибка с понятным текстом, если сервер не принял вход.
    pub fn check(&mut self) -> R<bool> { Ok(self.propfind(&[], 0)?.is_some()) }

    pub fn ensure_root(&mut self) -> R<()> { self.mkdir_root() }
}

impl<H: Http> crate::remote::Folder for WebDav<H> {
    fn check(&mut self) -> R<bool> { WebDav::check(self) }
    fn ensure_root(&mut self) -> R<()> { WebDav::ensure_root(self) }
}

impl<H: Http> Remote for WebDav<H> {
    fn list(&mut self, rel: &str) -> R<Vec<Item>> {
        let parts = segs(rel);
        let Some(items) = self.propfind(&parts, 1)? else { return Ok(vec![]) };
        let mut self_path = self.base_path.clone();
        self_path.extend(self.root_parts.iter().cloned());
        self_path.extend(parts.iter().cloned());
        let mut out = Vec::new();
        for it in items {
            let hp = segs(&it.href);
            if hp == self_path { continue; }
            let Some(name) = hp.last() else { continue };
            out.push(Item { name: name.clone(), dir: it.dir, size: it.size, mtime: it.mtime });
        }
        Ok(out)
    }

    fn read(&mut self, rel: &str) -> R<Option<Vec<u8>>> {
        let res = self.send("GET", &segs(rel), false, vec![], None)?;
        if res.status == 404 { return Ok(None); }
        if !ok(res.status) { return Err(format!("Не удалось прочитать файл (код {}).", res.status)); }
        Ok(Some(res.body))
    }

    fn write(&mut self, rel: &str, bytes: &[u8]) -> R<()> {
        let parts = segs(rel);
        if !self.root_parts.is_empty() { self.mkdir_root()?; }
        let put = |s: &Self| s.send("PUT", &parts, false, vec![("Content-Type".into(), "application/octet-stream".into())], Some(bytes.to_vec()));
        let mut res = put(self)?;
        if res.status == 409 || res.status == 404 {
            let parent = parts[..parts.len().saturating_sub(1)].to_vec();
            self.known.clear();
            if !self.root_parts.is_empty() { self.mkdir_root()?; }
            self.mkdir_parts(&parent)?;
            res = put(self)?;
        }
        if !ok(res.status) { return Err(format!("Не удалось записать файл (код {}).", res.status)); }
        for i in 1..parts.len() { self.known.insert(parts[..i].join("/")); }
        Ok(())
    }

    fn remove(&mut self, rel: &str) -> R<()> {
        let res = self.send("DELETE", &segs(rel), false, vec![], None)?;
        if res.status == 404 { return Ok(()); }
        if !ok(res.status) { return Err(format!("Не удалось удалить (код {}).", res.status)); }
        Ok(())
    }

    fn mkdir(&mut self, rel: &str) -> R<()> {
        let parts = segs(rel);
        if parts.is_empty() { return Ok(()); }
        if !self.root_parts.is_empty() { self.mkdir_root()?; }
        self.mkdir_parts(&parts)
    }
}

/// Папки сервера для выбора: (имя, путь от адреса сервера) внутри `at`.
pub fn browse_folders<H: Http>(http: H, url: &str, user: &str, pass: &str, at: &str) -> R<Vec<(String, String)>> {
    let mut dav = WebDav::new(http, url, user, pass, at)?;
    let items = dav.list("")?;
    let base = segs(at);
    let mut out: Vec<(String, String)> = items.into_iter()
        .filter(|x| x.dir && !x.name.starts_with('.'))
        .map(|x| { let mut p = base.clone(); p.push(x.name.clone()); (x.name, format!("/{}", p.join("/"))) })
        .collect();
    out.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
    Ok(out)
}

pub struct Preset { pub id: &'static str, pub name: &'static str, pub url: &'static str, pub hint: &'static str }

pub const PRESETS: &[Preset] = &[
    Preset { id: "yandex", name: "Яндекс Диск", url: "https://webdav.yandex.ru", hint: "Логин — ваша почта на Яндексе. Пароль — не от почты, а пароль приложения: id.yandex.ru → Безопасность → Пароли приложений → «Файлы WebDAV»." },
    Preset { id: "mailru", name: "Облако Mail.ru", url: "https://webdav.cloud.mail.ru", hint: "Логин — ваша почта. Пароль — пароль для внешнего приложения: Настройки аккаунта → Безопасность → Пароли для внешних приложений." },
    Preset { id: "nextcloud", name: "Nextcloud / ownCloud", url: "", hint: "Адрес — из Настройки → WebDAV в самом Nextcloud, он вида https://сервер/remote.php/dav/files/ИМЯ. Пароль лучше создать отдельный: Настройки → Безопасность → «Создать пароль приложения»." },
    Preset { id: "other", name: "Другой сервер WebDAV", url: "", hint: "Адрес, логин и пароль вам даёт сервис или администратор сервера." },
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::*;

    #[test]
    fn urls() {
        assert_eq!(normalize_url("webdav.yandex.ru/").unwrap(), "https://webdav.yandex.ru");
        assert_eq!(normalize_url("https://x.ru/remote.php/dav/files/me//").unwrap(), "https://x.ru/remote.php/dav/files/me");
        assert!(normalize_url("  ").is_err());
        assert!(normalize_url("ftp://x.ru").is_err());
        assert!(is_home_host("192.168.1.5") && is_home_host("nas") && is_home_host("localhost") && is_home_host("fd12::1"));
        assert!(!is_home_host("example.com") && !is_home_host("8.8.8.8") && !is_home_host("172.32.0.1"));
        let e = WebDav::new(FakeServer::new(), "http://example.com", "u", "p", "").err().unwrap();
        assert!(e.contains("https://"));
        assert!(WebDav::new(FakeServer::new(), "http://192.168.0.2", "u", "p", "").is_ok());
        assert_eq!(to_base64(b"u:p"), "dTpw");
        assert_eq!(to_base64(b"ab"), "YWI=");
    }

    #[test]
    fn multistatus_any_prefix() {
        let xml = r#"<D:multistatus xmlns:D="DAV:"><D:response><D:href>https://h/dav/%D0%93%D0%BB%D0%B0%D0%B2%D1%8B/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
        <D:response><D:href>/dav/a&amp;b.md</D:href><D:propstat><D:prop><D:getcontentlength>12</D:getcontentlength><D:getlastmodified>Tue, 14 Nov 2023 22:13:20 GMT</D:getlastmodified></D:prop></D:propstat></D:response></D:multistatus>"#;
        let v = parse_multistatus(xml);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].href, "/dav/Главы/");
        assert!(v[0].dir);
        assert_eq!(v[1].href, "/dav/a&b.md");
        assert_eq!((v[1].size, v[1].mtime), (12, 1_700_000_000_000));
    }

    #[test]
    fn multistatus_drops_names_with_encoded_slash() {
        // %2F внутри имени: после общего декодирования стало бы вложенным путём «a/b.md» и подменило бы файл.
        let xml = r#"<D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/a%2Fb.md</D:href></D:response><D:response><D:href>/dav/ok.md</D:href></D:response></D:multistatus>"#;
        let v = parse_multistatus(xml);
        assert_eq!(v.len(), 1, "{:?}", v);
        assert_eq!(v[0].href, "/dav/ok.md");
    }

    #[test]
    fn write_read_list_remove() {
        let s = FakeServer::new();
        let mut d = dav_on(&s, "/Кабинет/Роман");
        d.write("Главы/a.md", "привет".as_bytes()).unwrap();
        assert_eq!(s.get("/Кабинет/Роман/Главы/a.md").unwrap(), "привет".as_bytes());
        assert_eq!(d.read("Главы/a.md").unwrap().unwrap(), "привет".as_bytes());
        assert!(d.read("нет.md").unwrap().is_none());
        let l = d.list("Главы").unwrap();
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].name, "a.md");
        assert!(l[0].size > 0 && l[0].mtime > 0);
        let top = d.list("").unwrap();
        assert!(top.iter().any(|x| x.dir && x.name == "Главы"));
        d.remove("Главы/a.md").unwrap();
        d.remove("Главы/a.md").unwrap();
        assert!(d.read("Главы/a.md").unwrap().is_none());
    }

    #[test]
    fn auth_errors_are_readable() {
        struct Deny(u16);
        impl Http for Deny { fn request(&self, _: Req) -> Result<Resp, String> { Ok(Resp { status: self.0, body: vec![], location: None }) } }
        let mut d = WebDav::new(Deny(401), "https://x.ru", "u", "p", "").unwrap();
        assert!(d.check().unwrap_err().contains("логин"));
        let mut d = WebDav::new(Deny(507), "https://x.ru", "u", "p", "").unwrap();
        assert!(d.read("a").unwrap_err().contains("место"));
    }

    #[test]
    fn browse() {
        let s = FakeServer::new();
        s.put("Книги/Роман/project.json", b"{}");
        s.put("Архив/x.txt", b"1");
        let v = browse_folders(s.clone(), "https://dav.example.com", "u", "p", "").unwrap();
        assert_eq!(v.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), vec!["Архив", "Книги"]);
        assert_eq!(v[1].1, "/Книги");
    }

    #[test]
    fn retrying_repeats_busy_server() {
        use std::sync::atomic::{AtomicU32, Ordering};
        struct Flaky(AtomicU32);
        impl Http for Flaky { fn request(&self, _: Req) -> Result<Resp, String> {
            if self.0.fetch_add(1, Ordering::SeqCst) < 2 { Ok(Resp { status: 503, body: vec![], location: None }) } else { Ok(Resp { status: 200, body: b"ok".to_vec(), location: None }) }
        } }
        let mut r = Retrying::new(Flaky(AtomicU32::new(0)));
        r.pause_ms = 0;
        let res = r.request(Req { method: "GET".into(), url: "https://x".into(), headers: vec![], body: None }).unwrap();
        assert_eq!(res.status, 200);
    }
}

#[cfg(test)]
mod folder_recovery_tests {
    use super::*;
    use crate::testutil::*;

    #[test]
    fn write_recovers_after_a_folder_was_deleted_on_the_server() {
        let s = FakeServer::new();
        let mut d = dav_on(&s, "/Кабинет/Роман");
        d.write("Главы/a.md", "один".as_bytes()).unwrap();
        {
            let mut state = s.0.lock().unwrap();
            state.dirs.remove("/Кабинет/Роман/Главы");
            state.files.remove("/Кабинет/Роман/Главы/a.md");
        }
        d.write("Главы/b.md", "два".as_bytes()).unwrap();
        assert_eq!(s.get("Кабинет/Роман/Главы/b.md").unwrap(), "два".as_bytes());
    }

    #[test]
    fn write_recovers_after_the_whole_root_was_deleted_on_the_server() {
        let s = FakeServer::new();
        let mut d = dav_on(&s, "/Кабинет/Роман");
        d.write("Главы/a.md", "один".as_bytes()).unwrap();
        {
            let mut state = s.0.lock().unwrap();
            state.dirs.clear();
            state.files.clear();
        }
        d.write("Главы/b.md", "два".as_bytes()).unwrap();
        assert_eq!(s.get("Кабинет/Роман/Главы/b.md").unwrap(), "два".as_bytes());
    }

    #[test]
    fn read_capped_reports_oversized_bodies_instead_of_truncating() {
        assert_eq!(read_capped(&b"abcd"[..], 4).unwrap(), b"abcd".to_vec());
        assert!(read_capped(&b"abcde"[..], 4).unwrap_err().contains("больше"));
        assert!(read_capped(&b""[..], 4).unwrap().is_empty());
    }
}
