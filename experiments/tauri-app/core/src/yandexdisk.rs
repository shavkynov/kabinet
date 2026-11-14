//! Яндекс Диск через его API (вход через браузер, OAuth). Порт src/yandex-disk.js.
//! Данные входа лежат в «пароле» как JSON { kind: "kabinet-yandex-oauth", accessToken, expiresAt, … }.
use crate::remote::{Folder, Item, Remote};
use crate::store::R;
use crate::http::{Http, Req, Resp};
use serde_json::Value;
use std::collections::HashSet;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const API: &str = "https://cloud-api.yandex.net/v1/disk";
pub const PREFIX: &str = "oauth-yandex:";

pub fn is_oauth_user(s: &str) -> bool {
    s.strip_prefix(PREFIX).map(|h| h.len() == 32 && h.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))).unwrap_or(false)
}

fn now_ms() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0) }

struct YErr { status: u16, msg: String }
impl From<YErr> for String { fn from(e: YErr) -> String { e.msg } }
fn plain(msg: &str) -> YErr { YErr { status: 0, msg: msg.into() } }

fn fail(status: u16) -> YErr {
    let msg = match status {
        401 => "Доступ к Яндекс Диску истёк. Подключите его заново.".to_string(),
        403 => "Яндекс не разрешил доступ к папке.".into(),
        423 => "Яндекс Диск временно занят. Подождите немного и повторите действие.".into(),
        429 => "Яндекс просит подождать. Повторим синхронизацию позже.".into(),
        507 => "На Яндекс Диске закончилось место.".into(),
        n => format!("Яндекс Диск ответил кодом {}.", n),
    };
    YErr { status, msg }
}

struct Sent { status: u16, data: Value }

pub struct YandexDisk<H: Http> {
    http: H,
    token: String,
    expires_at: i64,
    base: Vec<String>,
    known: HashSet<String>,
    pause: Duration,
}

fn parts(s: &str) -> Result<Vec<String>, YErr> {
    let a: Vec<String> = s.split('/').filter(|x| !x.is_empty()).map(String::from).collect();
    if a.iter().any(|p| p == "." || p == ".." || p.contains('\\') || p.contains('\0')) { return Err(plain("Недопустимый путь Диска.")); }
    Ok(a)
}

fn transfer_url(raw: &str) -> Result<String, YErr> {
    let bad = || plain("Яндекс вернул недопустимую ссылку на файл.");
    let u = url::Url::parse(raw).map_err(|_| bad())?;
    let host = u.host_str().unwrap_or("");
    let ok_host = ["yandex.ru", "yandex.net"].iter().any(|h| host == *h || host.ends_with(&format!(".{}", h)));
    if u.scheme() != "https" || !u.username().is_empty() || u.password().is_some() || u.port().map(|p| p != 443).unwrap_or(false) || !ok_host { return Err(bad()); }
    Ok(u.to_string())
}

impl<H: Http> YandexDisk<H> {
    /// `pass` — JSON с данными входа, `root` — папка внутри Диска.
    pub fn new(http: H, pass: &str, root: &str) -> R<Self> {
        let v: Value = serde_json::from_str(pass).map_err(|_| "Подключите Яндекс Диск заново.".to_string())?;
        let token = v["accessToken"].as_str().unwrap_or("");
        let exp = v["expiresAt"].as_f64();
        if v["kind"] != "kabinet-yandex-oauth" || token.is_empty() || exp.is_none() { return Err("Некорректные данные подключения Яндекса.".into()); }
        Ok(YandexDisk { http, token: token.into(), expires_at: exp.unwrap() as i64, base: parts(root)?, known: HashSet::new(), pause: Duration::from_millis(500) })
    }

    #[cfg(test)]
    fn no_pause(mut self) -> Self { self.pause = Duration::ZERO; self }

    fn disk_path(&self, rel: &str) -> Result<String, YErr> {
        let mut all = self.base.clone();
        all.extend(parts(rel)?);
        Ok(format!("disk:/{}", all.join("/")))
    }

    fn send(&self, method: &str, suffix: &str, query: &[(&str, &str)], allow_missing: bool) -> Result<Option<Sent>, YErr> {
        if now_ms() >= self.expires_at { return Err(fail(401)); }
        let mut q = url::form_urlencoded::Serializer::new(String::new());
        for (k, v) in query { q.append_pair(k, v); }
        let res = self.http.request(Req {
            method: method.into(), url: format!("{}{}?{}", API, suffix, q.finish()),
            headers: vec![("Authorization".into(), format!("OAuth {}", self.token))], body: None,
        }).map_err(|_| plain("Нет связи с Яндекс Диском."))?;
        if allow_missing && res.status == 404 { return Ok(None); }
        if !(200..300).contains(&res.status) { return Err(fail(res.status)); }
        let data = if res.body.is_empty() { Value::Null } else { serde_json::from_slice(&res.body).map_err(|_| plain("Некорректный ответ Яндекс Диска."))? };
        Ok(Some(Sent { status: res.status, data }))
    }

    fn transfer(&self, method: &str, href: &str, body: Option<&[u8]>) -> Result<Resp, YErr> {
        let mut url = transfer_url(href)?;
        for _ in 0..6 {
            let res = self.http.request(Req {
                method: method.into(), url: url.clone(),
                headers: if method == "PUT" { vec![("Content-Type".into(), "application/octet-stream".into())] } else { vec![] },
                body: body.map(|b| b.to_vec()),
            }).map_err(|_| plain("Не удалось передать файл Яндекс Диску."))?;
            if [301, 302, 303, 307, 308].contains(&res.status) {
                let Some(loc) = res.location.as_deref().filter(|_| method == "GET") else { return Err(plain("Неожиданный переход при передаче файла.")) };
                let next = url::Url::parse(&url).and_then(|b| b.join(loc)).map_err(|_| plain("Неожиданный переход при передаче файла."))?;
                url = transfer_url(next.as_str())?;
                continue;
            }
            if !(200..300).contains(&res.status) { return Err(fail(res.status)); }
            return Ok(res);
        }
        Err(plain("Слишком много переходов при скачивании файла."))
    }

    fn meta(&self, path: &str, missing: bool) -> Result<Option<Sent>, YErr> {
        self.send("GET", "/resources", &[("path", path), ("fields", "type,size,md5")], missing)
    }

    fn mkdir_path(&mut self, p: &str) -> Result<(), YErr> {
        if self.known.contains(p) { return Ok(()); }
        if let Err(e) = self.send("PUT", "/resources", &[("path", p)], false) {
            let is_dir = e.status == 409 && self.meta(p, false)?.map(|m| m.data["type"] == "dir").unwrap_or(false);
            if !is_dir { return Err(e); }
        }
        self.known.insert(p.to_string());
        Ok(())
    }

    fn ensure(&mut self, rel: &str) -> Result<(), YErr> {
        let mut all = self.base.clone();
        all.extend(parts(rel)?);
        for i in 1..=all.len() { self.mkdir_path(&format!("disk:/{}", all[..i].join("/")))?; }
        Ok(())
    }

    fn do_list(&mut self, rel: &str) -> Result<Vec<Item>, YErr> {
        let path = self.disk_path(rel)?;
        let mut out = vec![];
        let mut offset = 0usize;
        loop {
            let Some(res) = self.send("GET", "/resources", &[("path", &path), ("limit", "1000"), ("offset", &offset.to_string())], true)? else { return Ok(vec![]) };
            let e = &res.data["_embedded"];
            let (Some(items), Some(total)) = (e["items"].as_array(), e["total"].as_u64()) else { return Err(plain("Неполный список файлов Яндекс Диска.")) };
            if total > 1_000_000 { return Err(plain("Неполный список файлов Яндекс Диска.")); }
            if (offset as u64) < total && items.is_empty() { return Err(plain("Яндекс вернул неполный список файлов.")); }
            for it in items {
                let name = it["name"].as_str().unwrap_or("");
                let ty = it["type"].as_str().unwrap_or("");
                // Необычные имена (\\ : * ? и т.п.) здесь не отвергаем: их отсеивает синхронизация (is_syncable), и один странный файл не остановит обмен.
                if name.is_empty() || name.contains('/') || name.contains('\0') || !(ty == "dir" || ty == "file") { return Err(plain("Некорректный элемент папки Яндекса.")); }
                let mtime = it["modified"].as_str().and_then(|m| chrono::DateTime::parse_from_rfc3339(m).ok()).map(|d| d.timestamp_millis()).unwrap_or(0);
                out.push(Item { name: name.into(), dir: ty == "dir", size: it["size"].as_i64().unwrap_or(0), mtime });
            }
            offset += items.len();
            if offset as u64 >= total { return Ok(out); }
        }
    }

    fn do_read(&mut self, rel: &str) -> Result<Option<Vec<u8>>, YErr> {
        let Some(res) = self.send("GET", "/resources/download", &[("path", &self.disk_path(rel)?)], true)? else { return Ok(None) };
        let href = res.data["href"].as_str().ok_or_else(|| plain("Яндекс не выдал ссылку на файл."))?;
        Ok(Some(self.transfer("GET", href, None)?.body))
    }

    fn do_write(&mut self, rel: &str, bytes: &[u8]) -> Result<(), YErr> {
        let p = parts(rel)?;
        if p.is_empty() { return Err(plain("Не указан файл.")); }
        self.ensure(&p[..p.len() - 1].join("/"))?;
        let path = self.disk_path(rel)?;
        let res = self.send("GET", "/resources/upload", &[("path", &path), ("overwrite", "true")], false)?.ok_or_else(|| plain("Яндекс не выдал ссылку для загрузки."))?;
        let href = res.data["href"].as_str().ok_or_else(|| plain("Яндекс не выдал ссылку для загрузки."))?.to_string();
        self.transfer("PUT", &href, Some(bytes))?;
        let want = format!("{:x}", md5::compute(bytes));
        for _ in 0..20 {
            if let Some(c) = self.meta(&path, true)? {
                if c.data["type"] == "file" && c.data["md5"] == want.as_str() { return Ok(()); }
            }
            std::thread::sleep(self.pause);
        }
        Err(plain("Яндекс ещё не подтвердил сохранение файла. Синхронизация будет повторена."))
    }

    fn do_remove(&mut self, rel: &str) -> Result<(), YErr> {
        if parts(rel)?.is_empty() { return Err(plain("Удаление корня запрещено.")); }
        let Some(res) = self.send("DELETE", "/resources", &[("path", &self.disk_path(rel)?)], true)? else { return Ok(()) };
        if res.status == 204 { return Ok(()); }
        let bad = || plain("Яндекс не подтвердил удаление.");
        if res.status != 202 { return Err(bad()); }
        let u = url::Url::parse(res.data["href"].as_str().ok_or_else(bad)?).map_err(|_| plain("Некорректный адрес операции Яндекса."))?;
        if u.origin().ascii_serialization() != "https://cloud-api.yandex.net" || !u.path().starts_with("/v1/disk/operations/") || u.query().is_some() || u.fragment().is_some() {
            return Err(plain("Некорректный адрес операции Яндекса."));
        }
        for _ in 0..30 {
            let op = self.send("GET", &u.path()["/v1/disk".len()..], &[], false)?.ok_or_else(bad)?;
            match op.data["status"].as_str() {
                Some("success") => return Ok(()),
                Some("in-progress") => std::thread::sleep(self.pause),
                _ => return Err(plain("Яндекс не смог удалить файл.")),
            }
        }
        Err(plain("Удаление на Яндекс Диске ещё не завершено."))
    }
}

impl<H: Http> Remote for YandexDisk<H> {
    fn list(&mut self, rel: &str) -> R<Vec<Item>> { Ok(self.do_list(rel)?) }
    fn read(&mut self, rel: &str) -> R<Option<Vec<u8>>> { Ok(self.do_read(rel)?) }
    fn write(&mut self, rel: &str, bytes: &[u8]) -> R<()> { Ok(self.do_write(rel, bytes)?) }
    fn remove(&mut self, rel: &str) -> R<()> { Ok(self.do_remove(rel)?) }
    fn mkdir(&mut self, rel: &str) -> R<()> { Ok(self.ensure(rel)?) }
}

impl<H: Http> Folder for YandexDisk<H> {
    fn check(&mut self) -> R<bool> {
        let r = self.meta(&self.disk_path("")?, false)?;
        Ok(r.map(|m| m.data["type"] == "dir").unwrap_or(false))
    }
    fn ensure_root(&mut self) -> R<()> { Ok(self.ensure("")?) }
}

/// Папки Диска для выбора: (имя, путь от корня Диска) внутри `at`.
pub fn browse_folders<H: Http>(http: H, pass: &str, at: &str) -> R<Vec<(String, String)>> {
    let mut disk = YandexDisk::new(http, pass, at)?;
    let base: Vec<String> = at.split('/').filter(|x| !x.is_empty()).map(String::from).collect();
    let mut out: Vec<(String, String)> = disk.list("")?.into_iter().filter(|x| x.dir && !x.name.starts_with('.'))
        .map(|x| { let mut p = base.clone(); p.push(x.name.clone()); (x.name, format!("/{}", p.join("/"))) }).collect();
    out.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};

    /// Мини-Диск в памяти: тот же порядок обращений, что у настоящего API (ссылки на загрузку и скачивание, переадресация).
    #[derive(Clone, Default)]
    struct Fake { files: Arc<Mutex<BTreeMap<String, Vec<u8>>>>, dirs: Arc<Mutex<Vec<String>>>, log: Arc<Mutex<Vec<String>>> }

    fn json(v: serde_json::Value) -> Result<Resp, String> { Ok(Resp { status: 200, body: v.to_string().into_bytes(), location: None }) }
    fn code(status: u16) -> Result<Resp, String> { Ok(Resp { status, body: vec![], location: None }) }

    impl Http for Fake {
        fn request(&self, r: Req) -> Result<Resp, String> {
            let u = url::Url::parse(&r.url).unwrap();
            self.log.lock().unwrap().push(format!("{} {}{}", r.method, u.host_str().unwrap(), u.path()));
            let q: BTreeMap<String, String> = u.query_pairs().map(|(k, v)| (k.to_string(), v.to_string())).collect();
            let path = q.get("path").cloned().unwrap_or_default();
            let (mut files, mut dirs) = (self.files.lock().unwrap(), self.dirs.lock().unwrap());
            match (u.host_str().unwrap(), r.method.as_str(), u.path()) {
                ("cloud-api.yandex.net", "PUT", "/v1/disk/resources") => { if dirs.contains(&path) { return code(409); } dirs.push(path); code(201) }
                ("cloud-api.yandex.net", "GET", "/v1/disk/resources") => {
                    if dirs.contains(&path) || path == "disk:/" {
                        let prefix = format!("{}/", path.trim_end_matches('/'));
                        let mut items = vec![];
                        for (f, b) in files.iter() { if let Some(n) = f.strip_prefix(&prefix) { if !n.contains('/') { items.push(serde_json::json!({ "name": n, "type": "file", "size": b.len(), "modified": "2024-01-02T03:04:05+00:00" })); } } }
                        for d in dirs.iter() { if let Some(n) = d.strip_prefix(&prefix) { if !n.contains('/') { items.push(serde_json::json!({ "name": n, "type": "dir" })); } } }
                        json(serde_json::json!({ "type": "dir", "_embedded": { "total": items.len(), "items": items } }))
                    } else if let Some(b) = files.get(&path) {
                        json(serde_json::json!({ "type": "file", "size": b.len(), "md5": format!("{:x}", md5::compute(b)) }))
                    } else { code(404) }
                }
                ("cloud-api.yandex.net", "GET", "/v1/disk/resources/upload") => json(serde_json::json!({ "href": format!("https://uploader.yandex.net/put?p={}", url::form_urlencoded::byte_serialize(path.as_bytes()).collect::<String>()) })),
                ("uploader.yandex.net", "PUT", _) => { files.insert(q["p"].clone(), r.body.unwrap()); code(201) }
                ("cloud-api.yandex.net", "GET", "/v1/disk/resources/download") => {
                    if files.contains_key(&path) { json(serde_json::json!({ "href": format!("https://downloader.yandex.net/a?p={}", url::form_urlencoded::byte_serialize(path.as_bytes()).collect::<String>()) })) } else { code(404) }
                }
                ("downloader.yandex.net", "GET", _) => Ok(Resp { status: 302, body: vec![], location: Some(format!("https://cdn.yandex.net/b?p={}", url::form_urlencoded::byte_serialize(q["p"].as_bytes()).collect::<String>())) }),
                ("cdn.yandex.net", "GET", _) => Ok(Resp { status: 200, body: files[&q["p"]].clone(), location: None }),
                ("cloud-api.yandex.net", "DELETE", "/v1/disk/resources") => { if files.remove(&path).is_some() { code(204) } else { code(404) } }
                other => panic!("неожиданный запрос {:?}", other),
            }
        }
    }

    fn creds(expires: i64) -> String { serde_json::json!({ "kind": "kabinet-yandex-oauth", "accessToken": "tok", "expiresAt": expires }).to_string() }

    #[test]
    fn full_cycle() {
        let fake = Fake::default();
        let mut d = YandexDisk::new(fake.clone(), &creds(now_ms() + 100_000), "/Кабинет/Роман").unwrap().no_pause();
        d.ensure_root().unwrap();
        d.write("Главы/a.md", "Привет".as_bytes()).unwrap();
        assert_eq!(d.read("Главы/a.md").unwrap().unwrap(), "Привет".as_bytes());
        assert!(d.read("нет.md").unwrap().is_none());
        let l = d.list("Главы").unwrap();
        assert_eq!((l[0].name.as_str(), l[0].dir, l[0].size > 0, l[0].mtime > 0), ("a.md", false, true, true));
        let top: Vec<String> = d.list("").unwrap().into_iter().map(|x| x.name).collect();
        assert_eq!(top, vec!["Главы"]);
        assert!(d.check().unwrap());
        d.remove("Главы/a.md").unwrap();
        d.remove("Главы/a.md").unwrap(); // уже нет: не ошибка
        assert!(d.remove("").is_err());
        // скачивание шло по переадресации на другой адрес Яндекса, без заголовка входа
        assert!(fake.log.lock().unwrap().iter().any(|l| l == "GET cdn.yandex.net/b"));
        let b = browse_folders(fake.clone(), &creds(now_ms() + 100_000), "/Кабинет").unwrap();
        assert_eq!(b, vec![("Роман".to_string(), "/Кабинет/Роман".to_string())]);
    }

    #[test]
    fn guards() {
        assert!(is_oauth_user("oauth-yandex:0123456789abcdef0123456789abcdef") && !is_oauth_user("oauth-yandex:xyz") && !is_oauth_user("me@yandex.ru"));
        assert!(YandexDisk::new(Fake::default(), "не json", "").is_err());
        let mut old = YandexDisk::new(Fake::default(), &creds(1), "").unwrap();
        assert_eq!(old.check().unwrap_err(), "Доступ к Яндекс Диску истёк. Подключите его заново.");
        assert!(YandexDisk::new(Fake::default(), &creds(now_ms() + 1000), "/a/../b").is_err());
        assert!(transfer_url("http://uploader.yandex.net/x").is_err());
        assert!(transfer_url("https://evil.example.com/x").is_err());
        assert!(transfer_url("https://user@uploader.yandex.net/x").is_err());
        assert!(transfer_url("https://uploader.yandex.net:8443/x").is_err());
        assert!(transfer_url("https://notyandex.net/x").is_err());
        assert!(transfer_url("https://up.yandex.net/x").is_ok());
    }
}
