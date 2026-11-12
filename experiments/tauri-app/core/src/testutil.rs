//! Поддельный WebDAV-сервер в памяти для тестов: PROPFIND/GET/PUT/DELETE/MKCOL.
use crate::webdav::{Http, Req, Resp};
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

fn esc(s: &str) -> String { s.replace('&', "&amp;").replace('<', "&lt;") }

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
        let path = percent_encoding::percent_decode_str(u.path()).decode_utf8_lossy().trim_end_matches('/').to_string();
        f.log.push(format!("{} {}", req.method, path));
        let r = |status: u16, body: Vec<u8>| Ok(Resp { status, body });
        match req.method.as_str() {
            "PROPFIND" => {
                let known = path.is_empty() || f.dirs.contains(&path) || f.files.contains_key(&path);
                if !known { return r(404, vec![]); }
                let depth = req.headers.iter().find(|(k, _)| k == "Depth").map(|x| x.1.clone()).unwrap_or("1".into());
                let mut xml = String::from("<?xml version=\"1.0\"?><d:multistatus xmlns:d=\"DAV:\">");
                let enc = |p: &str| p.split('/').map(|s| percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string()).collect::<Vec<_>>().join("/");
                xml.push_str(&format!("<d:response><d:href>{}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>", esc(&enc(&path))));
                if depth != "0" {
                    let prefix = format!("{}/", path);
                    let mut seen = std::collections::BTreeSet::new();
                    for d in &f.dirs { if d.starts_with(&prefix) && !d[prefix.len()..].contains('/') && seen.insert(d.clone()) {
                        xml.push_str(&format!("<d:response><d:href>{}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>", esc(&enc(d))));
                    } }
                    if !f.hide_all_files {
                        for (p, (data, t)) in &f.files { if p.starts_with(&prefix) && !p[prefix.len()..].contains('/') {
                            let secs = std::time::UNIX_EPOCH + std::time::Duration::from_millis(*t as u64);
                            xml.push_str(&format!("<d:response><d:href>{}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>{}</d:getcontentlength><d:getlastmodified>{}</d:getlastmodified></d:prop></d:propstat></d:response>", esc(&enc(p)), data.len(), httpdate::fmt_http_date(secs)));
                        } }
                    }
                }
                xml.push_str("</d:multistatus>");
                r(207, xml.into_bytes())
            }
            "GET" => {
                if f.fail_gets { return r(500, vec![]); }
                match f.files.get(&path) { Some((d, _)) => r(200, d.clone()), None => r(404, vec![]) }
            }
            "PUT" => {
                let parent = path.rsplit_once('/').map(|x| x.0.to_string()).unwrap_or_default();
                if !parent.is_empty() && !f.dirs.contains(&parent) { return r(409, vec![]); }
                f.clock += 1000;
                let t = f.clock;
                f.files.insert(path, (req.body.unwrap_or_default(), t));
                r(201, vec![])
            }
            "DELETE" => { if f.files.remove(&path).is_some() { r(204, vec![]) } else { r(404, vec![]) } }
            "MKCOL" => { if f.dirs.insert(path) { r(201, vec![]) } else { r(405, vec![]) } }
            _ => r(405, vec![]),
        }
    }
}

/// Адаптер без WebDAV: прямой доступ к FakeServer как к Remote (для тестов движка).
pub fn dav_on(server: &FakeServer, root: &str) -> crate::webdav::WebDav<FakeServer> {
    crate::webdav::WebDav::new(server.clone(), "https://dav.example.com", "u", "p", root).unwrap()
}

/// Пустая временная папка для теста.
pub fn tmpdir(tag: &str) -> std::path::PathBuf {
    let n: u64 = rand::random();
    let p = std::env::temp_dir().join(format!("kabinet-test-{}-{:x}", tag, n));
    std::fs::create_dir_all(&p).unwrap();
    p
}
