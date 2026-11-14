//! Поддельный Яндекс Диск в памяти для тестов: тот же порядок обращений к API, что у настоящего
//! (список, ссылки на загрузку и скачивание, переадресация скачивания, удаление). Тесты движка идут через настоящий YandexDisk.
use crate::http::{Http, Req, Resp};
use std::collections::BTreeMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct Fs {
    pub files: BTreeMap<String, (Vec<u8>, i64)>,
    pub dirs: std::collections::BTreeSet<String>,
    pub clock: i64,
    pub log: Vec<String>,
    /// Если задано, список файлов скрывается (неполный ответ облака).
    pub hide_all_files: bool,
    /// Ошибка запроса страницы списка (500).
    pub fail_list: bool,
    /// Файлы, которых нет в ответе списка, хотя они есть (проверка неполного списка).
    pub hide: std::collections::BTreeSet<String>,
    pub fail_gets: bool,
    pub fail_deletes: bool,
    /// Максимум записей в одной странице списка (если задан) — проверка пагинации.
    pub page_limit: Option<usize>,
    /// На этом offset сервер отдаёт пустую страницу при непустом total — проверка отказа.
    pub empty_page_at: Option<usize>,
    /// Удаление — асинхронная операция (202 + опрос статуса), как у Яндекса для непустых папок.
    pub async_deletes: bool,
    /// Дублировать последнюю запись страницы (проверка устойчивости к дублям списка).
    pub duplicate: bool,
    /// «Сжимать» total на последующих страницах (нестабильный total у облака).
    pub total_shrink: bool,
    /// Отложенные операции удаления: id операции → путь, который будет удалён при успехе.
    pub pending_ops: BTreeMap<String, String>,
    /// Отказ ЧТЕНИЯ (ссылка на скачивание) для путей с этими префиксами — точечный сбой одной операции.
    pub fail_get_prefixes: std::collections::BTreeSet<String>,
    /// Отказ ЗАГРУЗКИ для путей с этими префиксами — точечный сбой одной операции.
    pub fail_put_prefixes: std::collections::BTreeSet<String>,
    /// Отказ СОЗДАНИЯ ПАПКИ для точных путей — точечный сбой одной операции.
    pub fail_mkdir_paths: std::collections::BTreeSet<String>,
    /// Скрыть из списка файлы с этими префиксами (неполный список проб).
    pub hide_prefixes: std::collections::BTreeSet<String>,
    /// Отказ УДАЛЕНИЯ для путей с этими префиксами — точечный сбой одной операции.
    pub fail_delete_prefixes: std::collections::BTreeSet<String>,
    /// Отказ выдачи upload-ссылки для путей с этими префиксами.
    pub fail_upload_link_prefixes: std::collections::BTreeSet<String>,
    /// Отказ метаданных файла для путей с этими префиксами (проверка сохранения после PUT).
    pub fail_meta_prefixes: std::collections::BTreeSet<String>,
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
    /// Положить файл с заданным временем изменения (без изменения «часов» сервера).
    pub fn put_at(&self, path: &str, data: &[u8], mtime: i64) {
        let mut f = self.0.lock().unwrap();
        let mut p = String::new();
        let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
        for d in &parts[..parts.len() - 1] { p = format!("{}/{}", p, d); f.dirs.insert(p.clone()); }
        f.files.insert(format!("/{}", path.trim_matches('/')), (data.to_vec(), mtime));
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
                    // сбой именно СПИСКА папки (не метаданных файла — иначе сломается подтверждение create)
                    if f.fail_list { return r(500, vec![]); }
                    f.log.push(format!("LIST {}", path));
                    let prefix = format!("{}/", path);
                    let mut items = vec![];
                    for d in &f.dirs { if let Some(n) = d.strip_prefix(&prefix) { if !n.contains('/') { items.push(serde_json::json!({ "name": n, "type": "dir" })); } } }
                    if !f.hide_all_files {
                        for (p, (data, t)) in &f.files { if f.hide.contains(p) || f.hide_prefixes.iter().any(|x| p.starts_with(x)) { continue; } if let Some(n) = p.strip_prefix(&prefix) { if !n.contains('/') {
                            items.push(serde_json::json!({ "name": n, "type": "file", "size": data.len(), "modified": iso(*t) }));
                        } } }
                    }
                    let mut total = items.len();
                    if f.duplicate { if let Some(last) = items.last().cloned() { items.push(last); } }
                    let lim: usize = q.get("limit").and_then(|v| v.parse::<usize>().ok()).unwrap_or(1000).max(1);
                    let off: usize = q.get("offset").and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
                    if f.total_shrink && off > 0 { total = total.saturating_sub(2); }
                    let page_size = f.page_limit.unwrap_or(lim).min(lim);
                    let page: Vec<_> = if f.empty_page_at == Some(off) { vec![] } else { items.into_iter().skip(off).take(page_size).collect() };
                    js(serde_json::json!({ "type": "dir", "_embedded": { "total": total, "items": page } }))
                } else if let Some((d, _)) = f.files.get(&path) {
                    if f.fail_meta_prefixes.iter().any(|x| path.starts_with(x)) { return r(500, vec![]); }
                    js(serde_json::json!({ "type": "file", "size": d.len(), "md5": format!("{:x}", md5::compute(d)) }))
                } else { r(404, vec![]) }
            }
            ("cloud-api.yandex.net", "PUT", "/v1/disk/resources") => {
                f.log.push(format!("MKDIR {}", path));
                if f.fail_mkdir_paths.contains(&path) { return r(500, vec![]); }
                let parent = path.rsplit_once('/').map(|x| x.0.to_string()).unwrap_or_default();
                if !parent.is_empty() && !f.dirs.contains(&parent) { return r(409, vec![]); }
                if f.dirs.insert(path) { r(201, vec![]) } else { r(409, vec![]) }
            }
            ("cloud-api.yandex.net", "GET", "/v1/disk/resources/upload") => {
                let parent = path.rsplit_once('/').map(|x| x.0.to_string()).unwrap_or_default();
                if f.fail_upload_link_prefixes.iter().any(|x| path.starts_with(x)) { return r(500, vec![]); }
                if !parent.is_empty() && !f.dirs.contains(&parent) { return r(409, vec![]); }
                if f.files.contains_key(&path) && q.get("overwrite").map(|v| v == "false").unwrap_or(false) {
                    // подтверждённый конфликт существующего ресурса — структурированный код ошибки API
                    return Ok(Resp { status: 409, body: serde_json::json!({
                        "error": "DiskResourceAlreadyExistsError",
                        "message": "Ресурс уже существует.",
                        "description": "Ресурс уже существует."
                    }).to_string().into_bytes(), location: None });
                }
                js(serde_json::json!({ "href": format!("https://uploader.yandex.net/put?p={}", enc(&path)) }))
            }
            ("uploader.yandex.net", "PUT", _) => {
                f.log.push(format!("PUT {}", path));
                if f.fail_put_prefixes.iter().any(|p| path.starts_with(p)) { return r(500, vec![]); }
                f.clock += 1000;
                let t = f.clock;
                f.files.insert(path, (req.body.unwrap_or_default(), t));
                r(201, vec![])
            }
            ("cloud-api.yandex.net", "GET", "/v1/disk/resources/download") => {
                f.log.push(format!("GETLINK {}", path));
                if f.fail_get_prefixes.iter().any(|p| path.starts_with(p)) { return r(500, vec![]); }
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
                if f.fail_deletes { return r(500, vec![]); }
                if f.fail_delete_prefixes.iter().any(|x| path.starts_with(x)) { return r(500, vec![]); }
                if !f.files.contains_key(&path) && !f.dirs.contains(&path) { return r(404, vec![]); }
                if f.async_deletes {
                    let op = format!("/v1/disk/operations/{}", f.pending_ops.len() + 1);
                    f.pending_ops.insert(op.clone(), path.clone());
                    return Ok(Resp { status: 202, body: serde_json::json!({ "href": format!("https://cloud-api.yandex.net{}", op) }).to_string().into_bytes(), location: None });
                }
                if f.files.remove(&path).is_some() { r(204, vec![]) } else { r(404, vec![]) }
            }
            ("cloud-api.yandex.net", "GET", p) if p.starts_with("/v1/disk/operations/") => {
                if let Some(file) = f.pending_ops.remove(p) { f.files.remove(&file); js(serde_json::json!({ "status": "success" })) } else { r(404, vec![]) }
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

/// Управляемая точка остановки для детерминированных конкурентных тестов.
///
/// Ожидание ограничено ОДНИМ абсолютным deadline: при исчерпании — явный диагностический отказ,
/// а не повторные 5-секундные ожидания. `allow_on_drop` гарантирует освобождение приостановленного
/// участника при ошибке/панике управляющего сценария, чтобы cleanup/join не завис.
#[derive(Clone)]
pub(crate) struct Gate {
    reached: Arc<(Mutex<bool>, Condvar)>,
    released: Arc<(Mutex<bool>, Condvar)>,
    timeout: Duration,
}

impl Gate {
    pub(crate) fn new() -> Self { Self::with_timeout(Duration::from_secs(5)) }
    pub(crate) fn with_timeout(timeout: Duration) -> Self {
        Gate {
            reached: Arc::new((Mutex::new(false), Condvar::new())),
            released: Arc::new((Mutex::new(false), Condvar::new())),
            timeout,
        }
    }

    /// Проверка предиката после каждого пробуждения; по единому deadline — явный отказ.
    fn wait_flag(flag: &(Mutex<bool>, Condvar), timeout: Duration, what: &str) {
        let deadline = Instant::now() + timeout;
        let (m, c) = flag;
        let mut g = m.lock().unwrap_or_else(|e| e.into_inner());
        while !*g {
            let now = Instant::now();
            if now >= deadline {
                panic!("Gate: {} не дождались за {:?} — ожидание ограничено deadline", what, timeout);
            }
            let (next, _) = c.wait_timeout(g, deadline - now).unwrap_or_else(|e| e.into_inner());
            g = next;
        }
    }

    /// Из приостанавливаемой операции: сообщить о достижении точки и ждать разрешения.
    pub(crate) fn hold(&self) {
        let (m, c) = &*self.reached;
        *m.lock().unwrap_or_else(|e| e.into_inner()) = true;
        c.notify_all();
        Self::wait_flag(&self.released, self.timeout, "разрешения продолжить");
    }

    /// Из управляющего потока: дождаться достижения точки остановки.
    pub(crate) fn wait_reached(&self) {
        Self::wait_flag(&self.reached, self.timeout, "точки остановки");
    }

    /// Разрешить приостановленному участнику продолжить (идемпотентно).
    pub(crate) fn allow(&self) {
        let (m, c) = &*self.released;
        *m.lock().unwrap_or_else(|e| e.into_inner()) = true;
        c.notify_all();
    }

    /// Освобождение приостановленного участника при выходе из области — в том числе по панике.
    pub(crate) fn allow_on_drop(&self) -> AllowOnDrop { AllowOnDrop(self.clone()) }
}

pub(crate) struct AllowOnDrop(Gate);
impl Drop for AllowOnDrop {
    fn drop(&mut self) { self.0.allow(); }
}

#[cfg(test)]
mod gate_tests {
    use super::Gate;
    use std::time::{Duration, Instant};

    #[test]
    fn gate_has_a_single_deadline_and_reports_timeout() {
        let gate = Gate::with_timeout(Duration::from_millis(50));
        let g = gate.clone();
        let started = Instant::now();
        let res = std::thread::spawn(move || g.wait_reached()).join();
        assert!(res.is_err(), "исчерпание времени — явный диагностический отказ");
        assert!(started.elapsed() < Duration::from_secs(2), "ожидание ограничено deadline, а не повторяется");
    }

    #[test]
    fn gate_allow_on_drop_releases_paused_participant_when_scenario_panics() {
        let gate = Gate::with_timeout(Duration::from_secs(2));
        let g = gate.clone();
        let paused = std::thread::spawn(move || g.hold());
        gate.wait_reached();
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = gate.allow_on_drop();
            panic!("ошибка управляющего сценария");
        }));
        assert!(res.is_err(), "сценарий действительно упал");
        assert!(paused.join().is_ok(), "приостановленный участник освобождён, а не завис");
    }
}
