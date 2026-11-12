//! Проект на компьютере, связанный с сетевой папкой (WebDAV). Порт src/davlink.js.
//! Фоновый поток: полный проход раз в 30 с, выгрузка через 4 с после правки (наблюдение за папкой),
//! замок «kabinet.lock» раз в минуту. Проходы идут строго по одному.
use crate::foldersync::{is_syncable, FolderSync, SyncResult};
use crate::store::{write_atomic, R};
use crate::webdav::{self, Http, WebDav};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const LOCK_FILE: &str = "kabinet.lock";
const PASS: Duration = Duration::from_secs(30);
const PUSH_DELAY: Duration = Duration::from_secs(4);
const LOCK_EVERY: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
pub struct Acc {
    pub url: String,
    pub user: String,
    pub pass: String,
    #[serde(default)]
    pub root: String,
    #[serde(default)]
    pub label: String,
}

/// Хранилище пароля. В приложении — связка ключей системы; в тестах — без защиты.
pub trait Secret: Send + Sync {
    fn seal(&self, key: &str, pass: &str) -> R<String>;
    fn open(&self, key: &str, sealed: &str) -> R<String>;
    fn forget(&self, _key: &str) {}
}

pub struct PlainSecret;
impl Secret for PlainSecret {
    fn seal(&self, _k: &str, pass: &str) -> R<String> { Ok(pass.to_string()) }
    fn open(&self, _k: &str, sealed: &str) -> R<String> { Ok(sealed.to_string()) }
}

#[derive(Clone, Debug)]
pub enum Event {
    Conflict,
    Error(String),
    Changed(Vec<String>),
}

type Rm = WebDav<Box<dyn Http>>;
type HttpFactory = Arc<dyn Fn() -> Box<dyn Http> + Send + Sync>;
type OnEvent = Arc<dyn Fn(Event) + Send + Sync>;

#[derive(Default)]
struct St {
    last_sync: i64,
    last_error: String,
    conflict: bool,
}

struct Shared {
    stop: AtomicBool,
    busy: AtomicBool,
    dirty_at: Mutex<Option<Instant>>,
    quiet_until: Mutex<Instant>,
    st: Mutex<St>,
}

struct Work {
    dir: PathBuf,
    shared: Arc<Shared>,
    sync: Arc<Mutex<FolderSync<Rm>>>,
    thread: Option<JoinHandle<()>>,
    _watcher: Option<notify::RecommendedWatcher>,
}

pub struct DavLink {
    data_dir: PathBuf,
    secret: Arc<dyn Secret>,
    device: String,
    make_http: HttpFactory,
    on_event: OnEvent,
    cur: Mutex<Option<Work>>,
    config: Mutex<()>,
}

fn now_ms() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0) }

fn link_key(dir: &Path) -> String { dir.to_string_lossy().to_string() }

fn dav_of(http: Box<dyn Http>, acc: &Acc, root: Option<&str>) -> R<Rm> {
    WebDav::new(http, &acc.url, &acc.user, &acc.pass, root.unwrap_or(&acc.root))
}

fn run_pass(shared: &Shared, sync: &Mutex<FolderSync<Rm>>, on_event: &OnEvent) -> Option<SyncResult> {
    if shared.busy.swap(true, Ordering::SeqCst) { return None; }
    let result = {
        let mut s = sync.lock().unwrap();
        s.sync()
    };
    let out = match result {
        Ok(res) => {
            {
                let mut st = shared.st.lock().unwrap();
                st.last_sync = now_ms();
                st.last_error.clear();
                if !res.conflicts.is_empty() { st.conflict = true; }
            }
            if !res.conflicts.is_empty() { on_event(Event::Conflict); }
            let mut touched: Vec<String> = res.pulled.clone();
            for c in &res.conflicts { if !touched.contains(c) { touched.push(c.clone()); } }
            if !touched.is_empty() { on_event(Event::Changed(touched)); }
            Some(res)
        }
        Err(e) => {
            shared.st.lock().unwrap().last_error = e.clone();
            on_event(Event::Error(e));
            None
        }
    };
    *shared.quiet_until.lock().unwrap() = Instant::now() + Duration::from_secs(3);
    shared.busy.store(false, Ordering::SeqCst);
    out
}

fn write_lock(sync: &Mutex<FolderSync<Rm>>, device: &str) {
    use crate::remote::Remote;
    let body = json!({ "device": device, "time": now_ms() }).to_string();
    if let Ok(mut s) = sync.lock() { let _ = s.remote.write(LOCK_FILE, body.as_bytes()); }
}

fn release_lock(sync: &Mutex<FolderSync<Rm>>, device: &str) {
    use crate::remote::Remote;
    let Ok(mut s) = sync.lock() else { return };
    let Ok(Some(bytes)) = s.remote.read(LOCK_FILE) else { return };
    if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
        if v.get("device").and_then(|x| x.as_str()) == Some(device) { let _ = s.remote.remove(LOCK_FILE); }
    }
}

impl DavLink {
    pub fn new(data_dir: &Path, secret: Arc<dyn Secret>, device: &str, make_http: HttpFactory, on_event: OnEvent) -> Self {
        DavLink { data_dir: data_dir.to_path_buf(), secret, device: device.to_string(), make_http, on_event, cur: Mutex::new(None), config: Mutex::new(()) }
    }

    fn links_file(&self) -> PathBuf { self.data_dir.join("dav-links.json") }

    fn load_links(&self) -> BTreeMap<String, Value> {
        std::fs::read_to_string(self.links_file()).ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v.as_object().map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect()))
            .unwrap_or_default()
    }

    fn save_links(&self, map: &BTreeMap<String, Value>) -> R<()> {
        let _ = std::fs::create_dir_all(&self.data_dir);
        let obj: serde_json::Map<String, Value> = map.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        write_atomic(&self.links_file(), &serde_json::to_string_pretty(&Value::Object(obj)).unwrap())
    }

    fn state_file(&self, dir: &Path, acc: &Acc) -> PathBuf {
        let mut h = Sha1::new();
        h.update(format!("{}|{}|{}|{}", link_key(dir), acc.url, acc.user, acc.root).as_bytes());
        let hex: String = h.finalize().iter().map(|b| format!("{:02x}", b)).collect();
        self.data_dir.join(format!("folder-state-{}.json", &hex[..12]))
    }

    /// Связь проекта с открытым паролем или None.
    pub fn link_of(&self, dir: &Path) -> Option<Acc> {
        let map = self.load_links();
        let raw = map.get(&link_key(dir))?;
        let sealed = raw.get("pass").and_then(|x| x.as_str()).unwrap_or("");
        let pass = self.secret.open(&link_key(dir), sealed).ok()?;
        let s = |k: &str| raw.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
        Some(Acc { url: s("url"), user: s("user"), pass, root: s("root"), label: s("label") })
    }

    fn set_link(&self, dir: &Path, acc: Option<&Acc>) -> R<()> {
        let mut map = self.load_links();
        match acc {
            Some(a) => {
                let sealed = self.secret.seal(&link_key(dir), &a.pass)?;
                map.insert(link_key(dir), json!({ "url": a.url, "user": a.user, "pass": sealed, "root": a.root, "label": a.label }));
            }
            None => { map.remove(&link_key(dir)); self.secret.forget(&link_key(dir)); }
        }
        self.save_links(&map)
    }

    fn folder_sync(&self, dir: &Path, acc: &Acc) -> R<FolderSync<Rm>> {
        Ok(FolderSync::new(dir, dav_of((self.make_http)(), acc, None)?, Some(self.state_file(dir, acc))))
    }

    // ---------- работа открытого проекта ----------

    fn stop_work(&self) {
        let work = self.cur.lock().unwrap().take();
        if let Some(mut w) = work {
            w.shared.stop.store(true, Ordering::SeqCst);
            if let Some(t) = w.thread.take() { let _ = t.join(); }
        }
    }

    pub fn start(&self, dir: &Path) -> bool {
        self.stop_work();
        let Some(acc) = self.link_of(dir) else { return false };
        let Ok(fs_) = self.folder_sync(dir, &acc) else { return false };
        let sync = Arc::new(Mutex::new(fs_));
        let shared = Arc::new(Shared {
            stop: AtomicBool::new(false), busy: AtomicBool::new(false),
            dirty_at: Mutex::new(None), quiet_until: Mutex::new(Instant::now()), st: Mutex::new(St::default()),
        });
        let watcher = {
            use notify::{RecursiveMode, Watcher};
            let sh = shared.clone();
            let root = dir.to_path_buf();
            let w = notify::recommended_watcher(move |ev: notify::Result<notify::Event>| {
                let Ok(ev) = ev else { return };
                if sh.busy.load(Ordering::SeqCst) || Instant::now() < *sh.quiet_until.lock().unwrap() { return; }
                let relevant = ev.paths.iter().any(|p| {
                    p.strip_prefix(&root).ok().map(|r| is_syncable(&r.to_string_lossy().replace('\\', "/"))).unwrap_or(false)
                });
                if relevant { *sh.dirty_at.lock().unwrap() = Some(Instant::now()); }
            });
            match w {
                Ok(mut w) => { let _ = w.watch(dir, RecursiveMode::Recursive); Some(w) }
                Err(_) => None, // без наблюдения остаётся таймер
            }
        };
        let thread = {
            let (sh, sy, ev, device) = (shared.clone(), sync.clone(), self.on_event.clone(), self.device.clone());
            std::thread::spawn(move || {
                write_lock(&sy, &device);
                let mut last_pass = Instant::now().checked_sub(PASS - Duration::from_millis(1500)).unwrap_or_else(Instant::now);
                let mut last_lock = Instant::now();
                while !sh.stop.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(250));
                    if sh.stop.load(Ordering::SeqCst) { break; }
                    let dirty = sh.dirty_at.lock().unwrap().map(|t| t.elapsed() >= PUSH_DELAY).unwrap_or(false);
                    if dirty || last_pass.elapsed() >= PASS {
                        *sh.dirty_at.lock().unwrap() = None;
                        run_pass(&sh, &sy, &ev);
                        last_pass = Instant::now();
                    }
                    if last_lock.elapsed() >= LOCK_EVERY { write_lock(&sy, &device); last_lock = Instant::now(); }
                }
            })
        };
        *self.cur.lock().unwrap() = Some(Work { dir: dir.to_path_buf(), shared, sync, thread: Some(thread), _watcher: watcher });
        true
    }

    /// Дописать всё в сетевую папку и снять замок (закрытие проекта, выход).
    pub fn stop(&self) {
        let work = self.cur.lock().unwrap().take();
        let Some(mut w) = work else { return };
        w.shared.stop.store(true, Ordering::SeqCst);
        if let Some(t) = w.thread.take() { let _ = t.join(); }
        run_pass(&w.shared, &w.sync, &self.on_event);
        release_lock(&w.sync, &self.device);
    }

    pub fn status(&self, dir: Option<&Path>) -> Value {
        let Some(dir) = dir else { return json!({ "linked": false }) };
        let Some(acc) = self.link_of(dir) else { return json!({ "linked": false }) };
        let cur = self.cur.lock().unwrap();
        let w = cur.as_ref().filter(|w| w.dir == dir);
        let (last, busy, err, conflict) = match w {
            Some(w) => { let st = w.shared.st.lock().unwrap(); (st.last_sync, w.shared.busy.load(Ordering::SeqCst), st.last_error.clone(), st.conflict) }
            None => (0, false, String::new(), false),
        };
        json!({ "linked": true, "label": if acc.label.is_empty() { acc.url.clone() } else { acc.label.clone() }, "root": acc.root,
                "lastSync": last, "busy": busy, "error": err, "conflict": conflict })
    }

    pub fn sync_now(&self) -> R<Value> {
        if self.config.try_lock().is_err() { return Err("Идёт обмен…".into()); }
        let (dir, shared, sync) = {
            let cur = self.cur.lock().unwrap();
            let w = cur.as_ref().ok_or("Проект не связан с сетевой папкой.")?;
            (w.dir.clone(), w.shared.clone(), w.sync.clone())
        };
        shared.st.lock().unwrap().conflict = false;
        // если фоновый проход уже идёт, подождать его конца и запустить свой
        for _ in 0..600 { if !shared.busy.load(Ordering::SeqCst) { break; } std::thread::sleep(Duration::from_millis(100)); }
        run_pass(&shared, &sync, &self.on_event);
        Ok(self.status(Some(&dir)))
    }

    // ---------- подключение ----------

    /// Вход на сервер: проверка логина и пароля.
    pub fn login(&self, url: &str, user: &str, pass: &str) -> R<Acc> {
        let acc = Acc { url: webdav::normalize_url(url)?, user: user.to_string(), pass: pass.to_string(), root: String::new(), label: String::new() };
        dav_of((self.make_http)(), &acc, Some(""))?.check()?;
        Ok(acc)
    }

    pub fn browse(&self, acc: &Acc, at: &str) -> R<Vec<Value>> {
        let v = webdav::browse_folders((self.make_http)(), &acc.url, &acc.user, &acc.pass, at)?;
        Ok(v.into_iter().map(|(name, path)| json!({ "name": name, "path": path })).collect())
    }

    pub fn make_folder(&self, acc: &Acc, at: &str, name: &str) -> R<String> {
        let _g = self.config.lock().unwrap();
        let clean = name.trim();
        if clean.is_empty() || clean.chars().any(|c| "\\/:*?\"<>|".contains(c)) {
            return Err("Название не должно содержать символы \\ / : * ? \" < > |".into());
        }
        let root = format!("{}/{}", at.trim_end_matches('/'), clean);
        dav_of((self.make_http)(), acc, Some(&root))?.ensure_root()?;
        Ok(root)
    }

    /// Связать проект с папкой. mode: "ask" — если в папке уже есть проект, вернуть { exists: true } и ничего не менять;
    /// "merge" — соединить; "replace" — выгрузить этот проект, чужое уйдёт в «Конфликты».
    pub fn attach(&self, dir: &Path, acc: &Acc, mode: &str) -> R<Value> {
        let _g = self.config.lock().unwrap();
        let previous = self.cur.lock().unwrap().as_ref().map(|w| w.dir.clone());
        if previous.is_some() { self.stop(); }
        let result = (|| -> R<Value> {
            dav_of((self.make_http)(), acc, None)?.ensure_root()?;
            let mut probe = self.folder_sync(dir, acc)?;
            let exists = probe.has_project()?;
            if exists && mode == "ask" { return Ok(json!({ "exists": true })); }
            if exists && mode == "replace" { probe.replace_all()?; }
            else if exists { probe.sync()?; }
            else { probe.export_all()?; }
            self.set_link(dir, Some(acc))?;
            self.start(dir);
            Ok(json!({ "exists": exists, "status": self.status(Some(dir)) }))
        })();
        match &result {
            Ok(v) if v.get("exists") == Some(&json!(true)) && v.get("status").is_none() => { if let Some(p) = previous { self.start(&p); } }
            Err(_) => { if let Some(p) = previous { self.start(&p); } }
            _ => {}
        }
        result
    }

    /// Копирует проект из сетевой папки в новый локальный каталог и связывает его.
    pub fn open_remote(&self, acc: &Acc, target: &Path) -> R<bool> {
        let _g = self.config.lock().unwrap();
        let mut probe = self.folder_sync(target, acc)?;
        if !probe.has_project()? { return Err("В выбранной папке нет проекта Кабинета.".into()); }
        probe.import_all()?;
        self.set_link(target, Some(acc))?;
        Ok(true)
    }

    pub fn detach(&self, dir: &Path) -> R<bool> {
        let _g = self.config.lock().unwrap();
        let is_cur = self.cur.lock().unwrap().as_ref().map(|w| w.dir == dir).unwrap_or(false);
        if is_cur { self.stop(); }
        self.set_link(dir, None)?;
        Ok(true)
    }

    /// Входы, которые уже сохранены (повторное использование без ввода пароля).
    pub fn logins(&self) -> Vec<Value> {
        let mut seen = std::collections::BTreeSet::new();
        let mut out = vec![];
        for key in self.load_links().keys() {
            let Some(acc) = self.link_of(Path::new(key)) else { continue };
            if !seen.insert(format!("{}|{}", acc.url, acc.user)) { continue; }
            out.push(json!({ "url": acc.url, "user": acc.user, "pass": acc.pass, "label": if acc.label.is_empty() { acc.url.clone() } else { acc.label.clone() } }));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::*;

    fn link(data: &Path, s: &FakeServer, events: Arc<Mutex<Vec<String>>>) -> DavLink {
        let s = s.clone();
        DavLink::new(data, Arc::new(PlainSecret), "Тест", Arc::new(move || Box::new(s.clone()) as Box<dyn Http>),
            Arc::new(move |e| events.lock().unwrap().push(format!("{:?}", e))))
    }
    fn acc() -> Acc { Acc { url: "https://dav.example.com".into(), user: "u".into(), pass: "p".into(), root: "/Кабинет/Роман".into(), label: "Облако".into() } }
    fn project(dir: &Path) {
        std::fs::create_dir_all(dir.join("Главы")).unwrap();
        std::fs::write(dir.join("project.json"), r#"{"name":"Роман","chapters":[{"id":"aaaaaa","title":"1"}]}"#).unwrap();
        std::fs::write(dir.join("Главы/aaaaaa.md"), "текст").unwrap();
    }

    #[test]
    fn attach_asks_before_touching_existing_cloud_project() {
        let s = FakeServer::new();
        s.put("Кабинет/Роман/project.json", r#"{"name":"чужой","chapters":[]}"#.as_bytes());
        let data = tmpdir("data");
        let d = link(&data, &s, Default::default());
        let dir = tmpdir("proj");
        project(&dir);
        let v = d.attach(&dir, &acc(), "ask").unwrap();
        assert_eq!(v["exists"], json!(true));
        assert!(d.link_of(&dir).is_none());
        assert!(s.get("Кабинет/Роман/Главы/aaaaaa.md").is_none());
    }

    #[test]
    fn attach_uploads_to_empty_folder_and_remembers_link() {
        let s = FakeServer::new();
        let data = tmpdir("data");
        let d = link(&data, &s, Default::default());
        let dir = tmpdir("proj");
        project(&dir);
        let v = d.attach(&dir, &acc(), "ask").unwrap();
        assert_eq!(v["exists"], json!(false));
        assert_eq!(s.get("Кабинет/Роман/Главы/aaaaaa.md").unwrap(), "текст".as_bytes());
        assert_eq!(d.link_of(&dir).unwrap().user, "u");
        assert_eq!(d.status(Some(&dir))["linked"], json!(true));
        assert_eq!(d.logins().len(), 1);
        d.stop();
        // замок снят
        assert!(s.get("Кабинет/Роман/kabinet.lock").is_none());
        d.detach(&dir).unwrap();
        assert_eq!(d.status(Some(&dir))["linked"], json!(false));
    }

    #[test]
    fn sync_now_pulls_other_device_changes_and_reports() {
        let s = FakeServer::new();
        let data = tmpdir("data");
        let events: Arc<Mutex<Vec<String>>> = Default::default();
        let d = link(&data, &s, events.clone());
        let dir = tmpdir("proj");
        project(&dir);
        d.attach(&dir, &acc(), "ask").unwrap();
        s.put("Кабинет/Роман/Главы/aaaaaa.md", "правка с телефона".as_bytes());
        let st = d.sync_now().unwrap();
        assert_eq!(st["error"], json!(""));
        assert_eq!(std::fs::read_to_string(dir.join("Главы/aaaaaa.md")).unwrap(), "правка с телефона");
        assert!(events.lock().unwrap().iter().any(|e| e.contains("Changed")));
        d.stop();
    }

    #[test]
    fn open_remote_copies_project() {
        let s = FakeServer::new();
        let data = tmpdir("data");
        let d = link(&data, &s, Default::default());
        let src = tmpdir("src");
        project(&src);
        d.attach(&src, &acc(), "ask").unwrap();
        d.stop();
        let target = tmpdir("target").join("Роман");
        assert!(d.open_remote(&acc(), &target).unwrap());
        assert_eq!(std::fs::read_to_string(target.join("Главы/aaaaaa.md")).unwrap(), "текст");
        assert!(d.link_of(&target).is_some());
    }

    #[test]
    fn bad_password_is_reported_without_linking() {
        struct Deny;
        impl Http for Deny { fn request(&self, _: crate::webdav::Req) -> Result<crate::webdav::Resp, String> { Ok(crate::webdav::Resp { status: 401, body: vec![] }) } }
        let data = tmpdir("data");
        let d = DavLink::new(&data, Arc::new(PlainSecret), "Т", Arc::new(|| Box::new(Deny) as Box<dyn Http>), Arc::new(|_| {}));
        assert!(d.login("https://x.ru", "u", "bad").unwrap_err().contains("логин"));
        let dir = tmpdir("proj");
        project(&dir);
        assert!(d.attach(&dir, &acc(), "ask").is_err());
        assert!(d.link_of(&dir).is_none());
    }

    #[test]
    fn folder_name_validation() {
        let s = FakeServer::new();
        let d = link(&tmpdir("data"), &s, Default::default());
        assert!(d.make_folder(&acc(), "", "a/b").is_err());
        assert_eq!(d.make_folder(&acc(), "/Книги", "Новая").unwrap(), "/Книги/Новая");
    }
}
