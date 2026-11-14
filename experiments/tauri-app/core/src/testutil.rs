//! Поддельный Яндекс Диск в памяти для тестов: тот же порядок обращений к API, что у настоящего
//! (список, ссылки на загрузку и скачивание, переадресация скачивания, удаление). Тесты движка идут через настоящий YandexDisk.
use crate::http::{Http, Req, Resp};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct Fs {
    pub files: BTreeMap<String, (Vec<u8>, i64)>,
    pub dirs: std::collections::BTreeSet<String>,
    pub clock: i64,
    pub log: Vec<String>,
    /// Если задано, список файлов скрывается (неполный ответ облака).
    pub hide_all_files: bool,
    pub fail_gets: bool,
}

#[derive(Clone, Default)]
pub struct FakeServer(pub Arc<Mutex<Fs>>);

impl FakeServer {
    pub fn new() -> Self {
        let s = FakeServer::default();
        s.0.lock().unwrap().clock = 1_700_000_000_000;
        s
    }
    pub fn put(&self, path: &str, data: &[u8]) {
        let mut f = self.0.lock().unwrap();
        f.clock += 1000;
        let t = f.clock;
        let mut p = String::new();
        let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
        for d in &parts[..parts.len() - 1] { p = format!("{}/{}", p, d); f.dirs.insert(p.clone()); }
        f.files.insert(format!("/{}", path.trim_matches('/')), (data.to_vec(), t));
    }
    pub fn get(&self, path: &str) -> Option<Vec<u8>> {
        self.0.lock().unwrap().files.get(&format!("/{}", path.trim_matches('/'))).map(|x| x.0.clone())
    }
    pub fn names(&self) -> Vec<String> { self.0.lock().unwrap().files.keys().cloned().collect() }
}

impl Http for FakeServer {
    fn request(&self, req: Req) -> Result<Resp, String> {
        let mut f = self.0.lock().unwrap();
        let u = url::Url::parse(&req.url).map_err(|e| e.to_string())?;
        let q: BTreeMap<String, String> = u.query_pairs().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        // «disk:/Кабинет/Роман/a.md» → «/Кабинет/Роман/a.md»
        let path = q.get("path").or_else(|| q.get("p")).map(|p| p.strip_prefix("disk:").unwrap_or(p).trim_end_matches('/').to_string()).unwrap_or_default();
        let r = |status: u16, body: Vec<u8>| Ok(Resp { status, body, location: None });
        let js = |v: serde_json::Value| Ok(Resp { status: 200, body: v.to_string().into_bytes(), location: None });
        let enc = |p: &str| url::form_urlencoded::byte_serialize(p.as_bytes()).collect::<String>();
        let iso = |ms: i64| chrono::DateTime::from_timestamp_millis(ms).map(|d| d.to_rfc3339()).unwrap_or_default();
        match (u.host_str().unwrap_or(""), req.method.as_str(), u.path()) {
            ("cloud-api.yandex.net", "GET", "/v1/disk/resources") => {
                if path.is_empty() || f.dirs.contains(&path) {
                    f.log.push(format!("LIST {}", path));
                    let prefix = format!("{}/", path);
                    let mut items = vec![];
                    for d in &f.dirs { if let Some(n) = d.strip_prefix(&prefix) { if !n.contains('/') { items.push(serde_json::json!({ "name": n, "type": "dir" })); } } }
                    if !f.hide_all_files {
                        for (p, (data, t)) in &f.files { if let Some(n) = p.strip_prefix(&prefix) { if !n.contains('/') {
                            items.push(serde_json::json!({ "name": n, "type": "file", "size": data.len(), "modified": iso(*t) }));
                        } } }
                    }
                    js(serde_json::json!({ "type": "dir", "_embedded": { "total": items.len(), "items": items } }))
                } else if let Some((d, _)) = f.files.get(&path) {
                    js(serde_json::json!({ "type": "file", "size": d.len(), "md5": format!("{:x}", md5::compute(d)) }))
                } else { r(404, vec![]) }
            }
            ("cloud-api.yandex.net", "PUT", "/v1/disk/resources") => {
                f.log.push(format!("MKDIR {}", path));
                let parent = path.rsplit_once('/').map(|x| x.0.to_string()).unwrap_or_default();
                if !parent.is_empty() && !f.dirs.contains(&parent) { return r(409, vec![]); }
                if f.dirs.insert(path) { r(201, vec![]) } else { r(409, vec![]) }
            }
            ("cloud-api.yandex.net", "GET", "/v1/disk/resources/upload") => {
                let parent = path.rsplit_once('/').map(|x| x.0.to_string()).unwrap_or_default();
                if !parent.is_empty() && !f.dirs.contains(&parent) { return r(409, vec![]); }
                js(serde_json::json!({ "href": format!("https://uploader.yandex.net/put?p={}", enc(&path)) }))
            }
            ("uploader.yandex.net", "PUT", _) => {
                f.log.push(format!("PUT {}", path));
                f.clock += 1000;
                let t = f.clock;
                f.files.insert(path, (req.body.unwrap_or_default(), t));
                r(201, vec![])
            }
            ("cloud-api.yandex.net", "GET", "/v1/disk/resources/download") => {
                if f.files.contains_key(&path) { js(serde_json::json!({ "href": format!("https://downloader.yandex.net/a?p={}", enc(&path)) })) } else { r(404, vec![]) }
            }
            ("downloader.yandex.net", "GET", _) => Ok(Resp { status: 302, body: vec![], location: Some(format!("https://cdn.yandex.net/b?p={}", enc(&path))) }),
            ("cdn.yandex.net", "GET", _) => {
                f.log.push(format!("GET {}", path));
                if f.fail_gets { return r(500, vec![]); }
                match f.files.get(&path) { Some((d, _)) => r(200, d.clone()), None => r(404, vec![]) }
            }
            ("cloud-api.yandex.net", "DELETE", "/v1/disk/resources") => {
                f.log.push(format!("DELETE {}", path));
                if f.files.remove(&path).is_some() { r(204, vec![]) } else { r(404, vec![]) }
            }
            other => panic!("неожиданный запрос поддельному Диску: {:?}", other),
        }
    }
}

/// Данные входа Яндекса для тестов: логин с признаком OAuth и «пароль» — JSON с токеном, который не истекает.
pub const OAUTH_USER: &str = "oauth-yandex:0123456789abcdef0123456789abcdef";
pub fn oauth_pass() -> String { serde_json::json!({ "kind": "kabinet-yandex-oauth", "accessToken": "тест", "expiresAt": 4_102_444_800_000_i64 }).to_string() }

/// Движок синхронизации поверх поддельного Диска.
pub fn dav_on(server: &FakeServer, root: &str) -> crate::yandexdisk::YandexDisk<FakeServer> {
    crate::yandexdisk::YandexDisk::new(server.clone(), &oauth_pass(), root).unwrap()
}

/// Пустая временная папка для теста.
pub fn tmpdir(tag: &str) -> std::path::PathBuf {
    let n: u64 = rand::random();
    let p = std::env::temp_dir().join(format!("kabinet-test-{}-{:x}", tag, n));
    std::fs::create_dir_all(&p).unwrap();
    p
}
