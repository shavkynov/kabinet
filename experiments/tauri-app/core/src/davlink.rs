//! Проект на компьютере, связанный с папкой на Яндекс Диске. Порт src/davlink.js.
//! Фоновый поток: полный проход раз в 30 с, выгрузка через 4 с после правки (наблюдение за папкой).
//! Служебного замка в облаке Rust-версия не пишет: `kabinet.lock` — отметка Electron/Android
//! «проект открыт на этом устройстве», она только читается человеком и не блокирует обмен.
//! Проходы одного устройства идут строго по одному.
use crate::foldersync::{is_syncable, FolderSync};
use crate::store::{write_atomic, R};
use crate::remote::Folder;
use crate::http::Http;
use crate::yandexdisk::{self, is_oauth_user, YandexDisk};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const PASS: Duration = Duration::from_secs(30);
const PUSH_DELAY: Duration = Duration::from_secs(4);
/// Граница ожидания потока при остановке: закрытие окна не должно висеть на join без границы.
const STOP_BOUND: Duration = Duration::from_secs(5);

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

type Rm = Box<dyn Folder>;
type HttpFactory = Arc<dyn Fn() -> Box<dyn Http> + Send + Sync>;
/// Событие сессии: `dir` — проект, к которому относится событие. UI сравнивает его с открытым,
/// чтобы запоздавшие события старого проекта не обновляли другой проект.
type OnEvent = Arc<dyn Fn(&Path, Event) + Send + Sync>;

/// Исход прохода: ручной обмен возвращает его в UI, чтобы пропущенный проход не выглядел успехом.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PassOutcome { Done, Skipped, Stopped, Error }

#[derive(Default)]
struct St {
    last_sync: i64,
    last_error: String,
    conflict: bool,
}

struct Shared {
    dir: PathBuf,
    /// Один флаг для фонового и ручного прохода: копия передаётся в FolderSync как cancel.
    stop: Arc<AtomicBool>,
    busy: AtomicBool,
    /// Один признак «проход идёт» на проект: пока слот занят, второй проход того же проекта
    /// откладывается. Слот освобождается при любом выходе из прохода, включая ошибку и отмену.
    pass_slots: PassSlots,
    dirty_at: Mutex<Option<Instant>>,
    quiet_until: Mutex<Instant>,
    st: Mutex<St>,
}

type PassSlots = Arc<Mutex<HashSet<String>>>;

/// Владение слотом прохода: освобождает проект при выходе из `run_pass` (в т.ч. по панике).
struct PassSlot { slots: PassSlots, key: String }
impl Drop for PassSlot { fn drop(&mut self) { self.slots.lock().unwrap().remove(&self.key); } }

/// Занять слот проекта. `None` — проход этого проекта уже идёт (он откладывается).
fn begin_pass(slots: &PassSlots, dir: &Path) -> Option<PassSlot> {
    let key = link_key(dir);
    let mut set = slots.lock().unwrap();
    if !set.insert(key.clone()) { return None; }
    Some(PassSlot { slots: slots.clone(), key })
}

struct Work {
    dir: PathBuf,
    shared: Arc<Shared>,
    sync: Arc<Mutex<FolderSync<Rm>>>,
    thread: Option<JoinHandle<()>>,
    done: Option<std::sync::mpsc::Receiver<()>>,
    _watcher: Option<notify::RecommendedWatcher>,
}

/// Ограниченное ожидание потока: если он не успел за `stop_wait_bound()`, отцепляем его — записи ему уже
/// запрещены (stop-флаг), он доиграет текущий запрос и выйдет сам; закрытие окна не блокируется.
/// Возвращает true, если поток завершился в границе.
fn join_bounded(w: &mut Work) -> bool {
    let finished = w.done.take().map(|rx| rx.recv_timeout(stop_wait_bound()).is_ok()).unwrap_or(true);
    if let Some(t) = w.thread.take() { if finished { let _ = t.join(); } }
    finished
}

/// Граница ожидания остановки: production — `STOP_BOUND`; в тестах можно задать короткую границу
/// (thread-local), чтобы не ждать реальные 5 секунд. Production-значение не меняется.
fn stop_wait_bound() -> Duration {
    #[cfg(test)]
    {
        if let Some(b) = TEST_STOP_BOUND.with(|b| *b.borrow()) { return b; }
    }
    STOP_BOUND
}

#[cfg(test)]
thread_local! {
    static TEST_STOP_BOUND: std::cell::RefCell<Option<Duration>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn set_test_stop_bound(bound: Option<Duration>) {
    TEST_STOP_BOUND.with(|b| *b.borrow_mut() = bound);
}

pub struct DavLink {
    data_dir: PathBuf,
    secret: Arc<dyn Secret>,
    make_http: HttpFactory,
    on_event: OnEvent,
    cur: Mutex<Option<Work>>,
    /// Признак «проход идёт» по проекту — общий для фонового и ручного прохода.
    pass_slots: PassSlots,
    config: Mutex<()>,
}

fn now_ms() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0) }

fn link_key(dir: &Path) -> String { dir.to_string_lossy().to_string() }

fn dav_of(http: Box<dyn Http>, acc: &Acc, root: Option<&str>) -> R<Rm> {
    let root = root.unwrap_or(&acc.root);
    if !is_oauth_user(&acc.user) { return Err("Вход по паролю больше не поддерживается. Подключите Яндекс Диск заново.".into()); }
    Ok(Box::new(YandexDisk::new(http, &acc.pass, root)?))
}

fn run_pass(shared: &Arc<Shared>, sync: &Mutex<FolderSync<Rm>>, on_event: &OnEvent) -> PassOutcome {
    // Остановка сессии запрещает НОВЫЕ проходы. Уже идущий проход доигрывает текущий запрос,
    // но новых записей не делает (cancel-флаг в FolderSync).
    if shared.stop.load(Ordering::SeqCst) { return PassOutcome::Stopped; }
    if shared.busy.swap(true, Ordering::SeqCst) { return PassOutcome::Skipped; }
    // Один признак «проход идёт» на проект: пока слот занят прежним проходом (в т.ч. отцепленным
    // после stop), второй проход того же проекта откладывается. Слот снимается на любом выходе.
    let Some(_slot) = begin_pass(&shared.pass_slots, &shared.dir) else {
        shared.busy.store(false, Ordering::SeqCst);
        return PassOutcome::Skipped;
    };
    // Облачного замка нет: свежая отметка `kabinet.lock` от Electron/Android не блокирует проход
    // и не перезаписывается. Чужие правки защищает write_checked (перечитывание перед записью).
    let result = match sync.lock() {
        Ok(mut s) => s.sync(),
        Err(_) => Err("Внутренний замок синхронизации недоступен.".to_string()),
    };
    *shared.quiet_until.lock().unwrap() = Instant::now() + Duration::from_secs(3);
    shared.busy.store(false, Ordering::SeqCst);
    // Уже отправленный запрос не отзываем задним числом: результат пришёл в контексте ИСХОДНОЙ сессии.
    // После остановки он не считается успехом и не обновляет интерфейс другого проекта.
    if shared.stop.load(Ordering::SeqCst) { return PassOutcome::Stopped; }
    match result {
        Ok(res) => {
            {
                let mut st = shared.st.lock().unwrap();
                st.last_sync = now_ms();
                st.last_error.clear();
                if !res.conflicts.is_empty() { st.conflict = true; }
            }
            if !res.conflicts.is_empty() { on_event(&shared.dir, Event::Conflict); }
            let mut touched: Vec<String> = res.pulled.clone();
            for c in &res.conflicts { if !touched.contains(c) { touched.push(c.clone()); } }
            if !touched.is_empty() { on_event(&shared.dir, Event::Changed(touched)); }
            PassOutcome::Done
        }
        Err(e) => {
            if shared.stop.load(Ordering::SeqCst) { return PassOutcome::Stopped; }
            shared.st.lock().unwrap().last_error = e.clone();
            on_event(&shared.dir, Event::Error(e));
            PassOutcome::Error
        }
    }
}

impl DavLink {
    /// `device` сохранён в сигнатуре для совместимости: Rust не пишет отметку `kabinet.lock`
    /// (это делает Electron/Android), поэтому имя устройства пока не хранится.
    pub fn new(data_dir: &Path, secret: Arc<dyn Secret>, _device: &str, make_http: HttpFactory, on_event: OnEvent) -> Self {
        DavLink { data_dir: data_dir.to_path_buf(), secret, make_http, on_event, cur: Mutex::new(None), pass_slots: Arc::new(Mutex::new(HashSet::new())), config: Mutex::new(()) }
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
        FolderSync::new(dir, dav_of((self.make_http)(), acc, None)?, Some(self.state_file(dir, acc)))
    }

    // ---------- работа открытого проекта ----------

    /// Остановить работника открытого проекта. Возвращает true, если поток завершился в границе.
    /// Если нет — поток доиграет текущий запрос и выйдет сам: записи ему запрещены stop-флагом,
    /// а слот прохода освободится по завершении.
    fn stop_work(&self) -> bool {
        let work = self.cur.lock().unwrap().take();
        let Some(mut w) = work else { return true };
        w.shared.stop.store(true, Ordering::SeqCst);
        join_bounded(&mut w)
    }

    pub fn start(&self, dir: &Path) -> bool {
        // Старый работник мог не завершиться: новый проход того же проекта будет отложен (skipped),
        // пока реальный проход прежней сессии не закончится. Вызывающий не блокируется — локальное
        // письмо и главный поток UI не ждут сеть.
        let _old_finished = self.stop_work();
        let Some(acc) = self.link_of(dir) else { return false };
        let Ok(mut fs_) = self.folder_sync(dir, &acc) else { return false };
        let shared = Arc::new(Shared {
            dir: dir.to_path_buf(),
            stop: Arc::new(AtomicBool::new(false)), busy: AtomicBool::new(false),
            pass_slots: self.pass_slots.clone(),
            dirty_at: Mutex::new(None), quiet_until: Mutex::new(Instant::now()), st: Mutex::new(St::default()),
        });
        // Один флаг для фонового и ручного прохода: после stop проход не делает новых записей.
        fs_.set_cancel(Some(shared.stop.clone()));
        let sync = Arc::new(Mutex::new(fs_));
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
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let thread = {
            let (sh, sy, ev) = (shared.clone(), sync.clone(), self.on_event.clone());
            std::thread::spawn(move || {
                let mut last_pass = Instant::now().checked_sub(PASS - Duration::from_millis(1500)).unwrap_or_else(Instant::now);
                while !sh.stop.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(250));
                    if sh.stop.load(Ordering::SeqCst) { break; }
                    let dirty = sh.dirty_at.lock().unwrap().map(|t| t.elapsed() >= PUSH_DELAY).unwrap_or(false);
                    if dirty || last_pass.elapsed() >= PASS {
                        *sh.dirty_at.lock().unwrap() = None;
                        run_pass(&sh, &sy, &ev);
                        last_pass = Instant::now();
                    }
                }
                let _ = done_tx.send(());
            })
        };
        *self.cur.lock().unwrap() = Some(Work { dir: dir.to_path_buf(), shared, sync, thread: Some(thread), done: Some(done_rx), _watcher: watcher });
        true
    }

    /// Остановить обмен и снять замок (закрытие проекта, выход). Обязательный сетевой проход
    /// на выходе не делаем: незавершённое сохранено локально и уйдёт при следующем запуске,
    /// а блокирующий проход мешает закрытию окна при медленной/недоступной сети.
    /// Возвращает true, если фоновый поток завершился в границе ожидания.
    pub fn stop(&self) -> bool { self.stop_work() }

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
        let _config_guard = self.config.try_lock().map_err(|_| "Идёт обмен…".to_string())?;
        let (dir, shared, sync) = {
            let cur = self.cur.lock().unwrap();
            let w = cur.as_ref().ok_or("Проект не связан с сетевой папкой.")?;
            (w.dir.clone(), w.shared.clone(), w.sync.clone())
        };
        // Сессия остановлена: ручной обмен не запускает проход старого проекта.
        if shared.stop.load(Ordering::SeqCst) {
            let mut v = self.status(Some(&dir));
            v["status"] = json!("stopped");
            return Ok(v);
        }
        shared.st.lock().unwrap().conflict = false;
        // если фоновый проход уже идёт, подождать его конца и запустить свой
        for _ in 0..600 { if !shared.busy.load(Ordering::SeqCst) { break; } std::thread::sleep(Duration::from_millis(100)); }
        let outcome = run_pass(&shared, &sync, &self.on_event);
        let mut v = self.status(Some(&dir));
        // Фактический исход, а не «успешное» состояние: пропуск/остановка видны в UI.
        v["status"] = json!(match outcome {
            PassOutcome::Done => "done",
            PassOutcome::Skipped => "skipped",
            PassOutcome::Stopped => "stopped",
            PassOutcome::Error => "error",
        });
        Ok(v)
    }

    // ---------- подключение ----------

    /// Вход на сервер: проверка логина и пароля.
    pub fn login(&self, url: &str, user: &str, pass: &str) -> R<Acc> {
        let acc = Acc { url: url.to_string(), user: user.to_string(), pass: pass.to_string(), root: String::new(), label: String::new() };
        dav_of((self.make_http)(), &acc, Some(""))?.check()?;
        Ok(acc)
    }

    pub fn browse(&self, acc: &Acc, at: &str) -> R<Vec<Value>> {
        if !is_oauth_user(&acc.user) { return Err("Вход по паролю больше не поддерживается. Подключите Яндекс Диск заново.".into()); }
        let v = yandexdisk::browse_folders((self.make_http)(), &acc.pass, at)?;
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
            Arc::new(move |_dir, e| events.lock().unwrap().push(format!("{:?}", e))))
    }
    fn acc() -> Acc { Acc { url: "https://webdav.yandex.ru".into(), user: OAUTH_USER.into(), pass: oauth_pass(), root: "/Кабинет/Роман".into(), label: "Облако".into() } }
    fn project(dir: &Path) {
        std::fs::create_dir_all(dir.join("Главы")).unwrap();
        std::fs::write(dir.join("project.json"), r#"{"name":"Роман","chapters":[{"id":"aaaaaa","title":"1"}]}"#).unwrap();
        std::fs::write(dir.join("Главы/aaaaaa.md"), "текст").unwrap();
    }

    // ==== S1: диагностика остановки работников (характеризация, НЕ доказательство безопасности) ====
    //
    // Порядок событий задаётся управляемой паузой внутри РЕАЛЬНОГО HTTP-запроса прохода; ожидания
    // ограничены deadline. Тесты проходят, воспроизводя известное небезопасное поведение.

    /// HTTP-обёртка: приостанавливает первый GET реального прохода (до ответа сервера).
    struct SlowHttp { inner: FakeServer, gate: Gate, armed: Arc<AtomicBool> }
    impl Http for SlowHttp {
        fn request(&self, req: crate::http::Req) -> Result<crate::http::Resp, String> {
            // Сначала метод, потом снятие флага: иначе armed «сгорает» на первом PUT.
            if req.method == "GET" && self.armed.swap(false, Ordering::SeqCst) { self.gate.hold(); }
            self.inner.request(req)
        }
    }

    /// Подготовить проект и облако без `attach` (он запускает свой работник и мешает порядку).
    /// `export_all` создаёт state «как после прошлой синхронизации»; затем в облако кладётся чужая правка.
    fn seed(d: &DavLink, s: &FakeServer, dir: &Path) {
        project(dir);
        d.folder_sync(dir, &acc()).unwrap().export_all().unwrap();
        s.put("Кабинет/Роман/Главы/aaaaaa.md", "правка с телефона".as_bytes());
        d.set_link(dir, Some(&acc())).unwrap();
    }

    fn slow_link(data: &Path, s: &FakeServer, events: Arc<Mutex<Vec<String>>>, gate: &Gate, armed: &Arc<AtomicBool>) -> DavLink {
        let (s2, g2, a2) = (s.clone(), gate.clone(), armed.clone());
        DavLink::new(data, Arc::new(PlainSecret), "Тест",
            Arc::new(move || Box::new(SlowHttp { inner: s2.clone(), gate: g2.clone(), armed: a2.clone() }) as Box<dyn Http>),
            Arc::new(move |_dir, e| events.lock().unwrap().push(format!("{:?}", e))))
    }

    fn wait_until(limit: Duration, mut done: impl FnMut() -> bool) -> bool {
        let end = Instant::now() + limit;
        while Instant::now() < end { if done() { return true; } std::thread::sleep(Duration::from_millis(20)); }
        done()
    }

    fn pulled(dir: &Path) -> bool {
        std::fs::read_to_string(dir.join("Главы/aaaaaa.md")).map(|t| t == "правка с телефона").unwrap_or(false)
    }

    /// S1.1 ИНВАРИАНТ: stop() отцепляет поток по границе, но отцепленный проход НЕ делает локальных
    /// записей и не эмитит события после возврата stop (cancel-флаг проверяется перед каждой записью).
    #[test]
    fn s1_1_stopped_pass_makes_no_writes_after_stop() {
        let s = FakeServer::new();
        let data = tmpdir("data");
        let events: Arc<Mutex<Vec<String>>> = Default::default();
        let gate = Gate::with_timeout(Duration::from_secs(3));
        let _release = gate.allow_on_drop(); // cleanup: при панике сценария проход будет освобождён
        let armed = Arc::new(AtomicBool::new(false));
        let d = slow_link(&data, &s, events.clone(), &gate, &armed);
        let dir = tmpdir("proj");
        seed(&d, &s, &dir);
        armed.store(true, Ordering::SeqCst);
        assert!(d.start(&dir));
        gate.wait_reached(); // проход остановлен внутри реальной HTTP-операции
        set_test_stop_bound(Some(Duration::from_millis(100)));
        let finished = d.stop(); // возвращается, не дождавшись прохода
        set_test_stop_bound(None);
        assert!(!finished, "ответ на запрос ещё не получен — граница ожидания истекла");
        assert!(!pulled(&dir), "до освобождения проход ещё не завершён");
        gate.allow();
        // Отцепленный проход доигрывает запрос, но новых записей и событий от него быть не должно.
        let ended = wait_until(Duration::from_secs(5), || d.pass_slots.lock().unwrap().is_empty());
        assert!(ended, "отцепленный проход завершился");
        assert!(!pulled(&dir), "остановленный проход не делает локальных записей");
        assert!(events.lock().unwrap().is_empty(), "остановленный проход не эмитит события: {:?}", events.lock().unwrap());
    }

    /// S1.2 ИНВАРИАНТ: start после незавершённого stop не запускает параллельный проход поверх старого;
    /// старый проход не пишет, а новый работник после границы штатно завершает проход.
    #[test]
    fn s1_2_restart_after_unfinished_stop_waits_for_boundary_and_works() {
        let s = FakeServer::new();
        let data = tmpdir("data");
        let events: Arc<Mutex<Vec<String>>> = Default::default();
        let gate = Gate::with_timeout(Duration::from_secs(3));
        let _release = gate.allow_on_drop();
        let armed = Arc::new(AtomicBool::new(false));
        let d = slow_link(&data, &s, events.clone(), &gate, &armed);
        let dir = tmpdir("proj");
        seed(&d, &s, &dir);
        armed.store(true, Ordering::SeqCst);
        assert!(d.start(&dir));
        gate.wait_reached(); // проход #1 приостановлен в сети
        set_test_stop_bound(Some(Duration::from_millis(100)));
        assert!(!d.stop(), "старый проход ещё в сети, граница истекла");
        set_test_stop_bound(None);
        assert!(d.start(&dir), "новый работник того же проекта запущен");
        // Прежний проход этой сессии ещё выполняется — новый проход того же проекта откладывается
        // слотом прохода и не пересекается с ним.
        assert_eq!(d.sync_now().unwrap()["status"], json!("skipped"), "второй проход отложен до завершения старого");
        assert!(!pulled(&dir), "пересечения записей нет");
        gate.allow();
        let freed = wait_until(Duration::from_secs(10), || d.pass_slots.lock().unwrap().is_empty());
        assert!(freed, "отцепленный проход #1 завершился");
        // Отменённый старый проход не сделал записей и не эмитил событий (писать ему запрещено).
        assert!(events.lock().unwrap().is_empty(), "старый отменённый проход не эмитит события: {:?}", events.lock().unwrap());
        assert!(d.sync_now().unwrap()["status"] == json!("done"), "новый работник завершил проход после границы");
        assert!(pulled(&dir), "новый работник докачал правку");
        assert!(events.lock().unwrap().iter().any(|e| e.contains("Changed")), "событие относится к текущему проекту");
    }

    /// S1.3 ИНВАРИАНТ: ручной sync_now, уже отправивший запрос, после stop не делает записей
    /// и возвращает фактический исход «stopped» (пропуск не выдаётся за успех).
    #[test]
    fn s1_3_manual_sync_now_after_stop_reports_stopped_without_writes() {
        let s = FakeServer::new();
        let data = tmpdir("data");
        let events: Arc<Mutex<Vec<String>>> = Default::default();
        let gate = Gate::with_timeout(Duration::from_secs(3));
        let _release = gate.allow_on_drop();
        let armed = Arc::new(AtomicBool::new(false));
        let d = Arc::new(slow_link(&data, &s, events.clone(), &gate, &armed));
        let dir = tmpdir("proj");
        seed(&d, &s, &dir);
        armed.store(true, Ordering::SeqCst);
        assert!(d.start(&dir));
        let d2 = Arc::clone(&d);
        let manual = std::thread::spawn(move || d2.sync_now());
        gate.wait_reached(); // проход остановлен внутри HTTP
        set_test_stop_bound(Some(Duration::from_millis(100)));
        d.stop(); // возвращается; Work снят
        set_test_stop_bound(None);
        gate.allow();
        let res = manual.join().unwrap().unwrap();
        assert_eq!(res["status"], json!("stopped"), "ручной обмен вернул фактический исход: {res}");
        assert!(!pulled(&dir), "остановленный ручной проход не делает записей");
        assert!(events.lock().unwrap().is_empty(), "нет событий остановленной сессии: {:?}", events.lock().unwrap());
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
        assert_eq!(d.link_of(&dir).unwrap().user, OAUTH_USER);
        assert_eq!(d.status(Some(&dir))["linked"], json!(true));
        assert_eq!(d.logins().len(), 1);
        d.stop();
        // служебного замка в облаке нет: Rust его не пишет и не трогает
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
    fn stop_does_not_force_network_pass_and_keeps_change_for_resume() {
        let s = FakeServer::new();
        let data = tmpdir("data");
        let d = link(&data, &s, Default::default());
        let dir = tmpdir("proj");
        project(&dir);
        d.attach(&dir, &acc(), "ask").unwrap();
        // правка сразу после подключения, до фонового прохода
        std::fs::write(dir.join("Главы/aaaaaa.md"), "новая правка").unwrap();
        d.stop();
        // stop не делает обязательного сетевого прохода: в облаке ещё старый текст, правка не потеряна
        assert_eq!(s.get("Кабинет/Роман/Главы/aaaaaa.md").unwrap(), "текст".as_bytes(), "stop сам не выгружает правку");
        assert_eq!(std::fs::read_to_string(dir.join("Главы/aaaaaa.md")).unwrap(), "новая правка");
        // повторный запуск догоняет
        assert!(d.start(&dir));
        d.sync_now().unwrap();
        assert_eq!(s.get("Кабинет/Роман/Главы/aaaaaa.md").unwrap(), "новая правка".as_bytes());
        d.stop();
    }

    #[test]
    fn phone_lock_does_not_block_pass_and_is_not_touched() {
        let s = FakeServer::new();
        let d = link(&tmpdir("data"), &s, Default::default());
        let dir = tmpdir("proj");
        project(&dir);
        d.attach(&dir, &acc(), "ask").unwrap();
        d.stop();
        // Свежая отметка «проект открыт на телефоне» в формате Electron/Android:
        // это не замок прохода, а информационная отметка, и Rust не должен её блокироваться/затирать.
        let stamp = format!("{{\"device\":\"Телефон\",\"time\":{}}}", now_ms());
        s.put("Кабинет/Роман/kabinet.lock", stamp.as_bytes());
        std::fs::write(dir.join("Главы/aaaaaa.md"), "наша правка").unwrap();
        assert!(d.start(&dir));
        let st = d.sync_now().unwrap();
        assert_eq!(st["error"], json!(""));
        assert_eq!(s.get("Кабинет/Роман/Главы/aaaaaa.md").unwrap(), "наша правка".as_bytes(), "чужая отметка телефона не блокирует обмен");
        assert_eq!(s.get("Кабинет/Роман/kabinet.lock").unwrap(), stamp.as_bytes(), "Rust не перезаписывает отметку телефона");
        d.stop();
    }

    #[test]
    fn stop_gives_up_on_a_stuck_thread_within_bound() {
        let s = FakeServer::new();
        let d = link(&tmpdir("data-stop"), &s, Default::default());
        let dir = tmpdir("proj");
        let sync = d.folder_sync(&dir, &acc()).unwrap();
        let (_tx, rx) = std::sync::mpsc::channel::<()>(); // сигнала не будет: поток «завис»
        let handle = std::thread::spawn(|| std::thread::sleep(Duration::from_secs(12)));
        *d.cur.lock().unwrap() = Some(Work {
            dir: dir.clone(),
            shared: Arc::new(Shared {
                dir: dir.clone(),
                stop: Arc::new(AtomicBool::new(false)), busy: AtomicBool::new(false),
                pass_slots: d.pass_slots.clone(),
                dirty_at: Mutex::new(None), quiet_until: Mutex::new(Instant::now()), st: Mutex::new(St::default()),
            }),
            sync: Arc::new(Mutex::new(sync)),
            thread: Some(handle),
            done: Some(rx),
            _watcher: None,
        });
        let t = Instant::now();
        d.stop();
        assert!(t.elapsed() < Duration::from_secs(8), "stop не должен ждать зависший поток без границы: {:?}", t.elapsed());
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
    fn rejected_login_is_reported_without_linking() {
        struct Deny;
        impl Http for Deny { fn request(&self, _: crate::http::Req) -> Result<crate::http::Resp, String> { Ok(crate::http::Resp { status: 401, body: vec![], location: None }) } }
        let data = tmpdir("data");
        let d = DavLink::new(&data, Arc::new(PlainSecret), "Т", Arc::new(|| Box::new(Deny) as Box<dyn Http>), Arc::new(|_, _| {}));
        assert!(d.login("https://webdav.yandex.ru", OAUTH_USER, &oauth_pass()).unwrap_err().contains("Подключите"));
        let old = Acc { user: "me@yandex.ru".into(), pass: "пароль".into(), ..acc() };
        assert!(d.attach(&tmpdir("old"), &old, "ask").unwrap_err().contains("больше не поддерживается"));
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

    #[test]
    fn sync_now_rejects_busy_config_and_releases_on_early_return() {
        let s = FakeServer::new();
        let d = link(&tmpdir("sync-config"), &s, Default::default());
        let guard = d.config.lock().unwrap();
        assert_eq!(d.sync_now().unwrap_err(), "Идёт обмен…");
        drop(guard);
        assert_eq!(d.sync_now().unwrap_err(), "Проект не связан с сетевой папкой.");
        assert!(d.config.try_lock().is_ok());
    }

    #[test]
    fn sync_now_holds_config_during_error_callback() {
        struct Offline;
        impl Http for Offline {
            fn request(&self, _: crate::http::Req) -> Result<crate::http::Resp, String> {
                Err("Сеть недоступна (тест)".into())
            }
        }
        let data = tmpdir("sync-config-data");
        let dir = tmpdir("sync-config-project");
        let observed = Arc::new(AtomicBool::new(false));
        let d: Arc<DavLink> = Arc::new_cyclic(|weak: &std::sync::Weak<DavLink>| {
            let weak = weak.clone();
            let observed = observed.clone();
            DavLink::new(&data, Arc::new(PlainSecret), "Тест",
                Arc::new(|| Box::new(Offline) as Box<dyn Http>),
                Arc::new(move |_dir, event| {
                    assert!(matches!(event, Event::Error(_)));
                    let d = weak.upgrade().unwrap();
                    assert!(d.config.try_lock().is_err(), "блокировка должна удерживаться до завершения sync_now");
                    observed.store(true, Ordering::SeqCst);
                }))
        });
        let sync = d.folder_sync(&dir, &acc()).unwrap();
        *d.cur.lock().unwrap() = Some(Work {
            dir: dir.clone(),
            shared: Arc::new(Shared {
                dir: dir.clone(),
                stop: Arc::new(AtomicBool::new(false)),
                busy: AtomicBool::new(false),
                pass_slots: d.pass_slots.clone(),
                dirty_at: Mutex::new(None),
                quiet_until: Mutex::new(Instant::now()),
                st: Mutex::new(St::default()),
            }),
            sync: Arc::new(Mutex::new(sync)),
            thread: None,
            done: None,
            _watcher: None,
        });
        d.sync_now().unwrap();
        assert!(observed.load(Ordering::SeqCst));
        assert!(d.config.try_lock().is_ok(), "после sync_now блокировка должна освобождаться");
    }
}
