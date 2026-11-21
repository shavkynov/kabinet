//! Следит за файлами проекта и сообщает, когда что-то изменилось не нашей записью
//! (например, облако принесло правки с другого устройства). Порт src/watcher.js.
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const FOLDERS: [&str; 5] = ["Главы", "Персонажи", "Места", "Предметы", "Заметки"];

fn hash(bytes: &[u8]) -> String { Sha1::digest(bytes).iter().map(|b| format!("{:02x}", b)).collect() }
fn key(p: &Path) -> String { p.to_string_lossy().replace('\\', "/") }

fn wrote() -> &'static Mutex<HashMap<String, String>> {
    static W: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Вызывается при каждой нашей записи, чтобы наблюдатель не принял её за чужую.
pub fn note_written(file: &Path, data: &[u8]) {
    if let Ok(mut m) = wrote().lock() { m.insert(key(file), hash(data)); }
}

/// project.json (и его варианты) или файл глав, карточек, заметок.
pub fn is_relevant(rel: &str) -> bool {
    let parts: Vec<&str> = rel.split(['/', '\\']).filter(|s| !s.is_empty()).collect();
    let Some(name) = parts.last() else { return false };
    if name.ends_with(".tmp") || name.starts_with('.') { return false; }
    match parts.len() {
        1 => name.starts_with("project") && name.ends_with(".json"),
        2 => FOLDERS.contains(&parts[0]),
        _ => false,
    }
}

fn snapshot(dir: &Path) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut add = |rel: String| {
        if let Ok(m) = std::fs::metadata(dir.join(&rel)) {
            let t = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
            out.insert(rel, format!("{}:{}", t, m.len()));
        }
    };
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.filter_map(|e| e.ok()) { let n = e.file_name().to_string_lossy().to_string(); if is_relevant(&n) { add(n); } }
    }
    for f in FOLDERS {
        if let Ok(rd) = std::fs::read_dir(dir.join(f)) {
            for e in rd.filter_map(|e| e.ok()) { let n = format!("{}/{}", f, e.file_name().to_string_lossy()); if is_relevant(&n) { add(n); } }
        }
    }
    out
}

pub struct Watcher {
    stop: Arc<AtomicBool>,
    _notify: Option<notify::RecommendedWatcher>,
}

impl Drop for Watcher { fn drop(&mut self) { self.stop.store(true, Ordering::SeqCst); } }

impl Watcher {
    pub fn start(dir: &Path, on_change: Arc<dyn Fn(Vec<String>) + Send + Sync>, delay: Duration, poll: Duration) -> Watcher {
        let stop = Arc::new(AtomicBool::new(false));
        let pending: Arc<Mutex<(HashSet<String>, Option<Instant>)>> = Arc::new(Mutex::new((HashSet::new(), None)));
        let queue = {
            let p = pending.clone();
            move |rel: String| { let mut g = p.lock().unwrap(); g.0.insert(rel); g.1 = Some(Instant::now()); }
        };
        let notify = {
            use notify::{RecursiveMode, Watcher as _};
            let (root, q) = (dir.to_path_buf(), queue.clone());
            notify::recommended_watcher(move |ev: notify::Result<notify::Event>| {
                let Ok(ev) = ev else { return };
                for p in ev.paths {
                    if let Ok(r) = p.strip_prefix(&root) { let rel = key(r); if is_relevant(&rel) { q(rel); } }
                }
            }).ok().and_then(|mut w| { w.watch(dir, RecursiveMode::Recursive).ok()?; Some(w) })
        };
        let (root, st) = (dir.to_path_buf(), stop.clone());
        std::thread::spawn(move || {
            let mut snap = snapshot(&root);
            let mut last_poll = Instant::now();
            let mut seen: HashMap<String, Option<String>> = HashMap::new();
            while !st.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(50));
                // запасной опрос: события файловой системы бывают неполными (замена файла, сетевые и облачные папки)
                if last_poll.elapsed() >= poll {
                    last_poll = Instant::now();
                    let now = snapshot(&root);
                    for (rel, sig) in &now { if snap.get(rel) != Some(sig) { queue(rel.clone()); } }
                    for rel in snap.keys() { if !now.contains_key(rel) { queue(rel.clone()); } }
                    snap = now;
                }
                let due: Vec<String> = {
                    let mut g = pending.lock().unwrap();
                    match g.1 { Some(t) if t.elapsed() >= delay => { g.1 = None; g.0.drain().collect() } _ => vec![] }
                };
                let mut files = vec![];
                for rel in due {
                    let file = root.join(&rel);
                    let k = key(&file);
                    let h = std::fs::read(&file).ok().map(|b| hash(&b));
                    let mine = wrote().lock().ok().and_then(|m| m.get(&k).cloned());
                    if let Some(h) = &h { if Some(h) == mine.as_ref() || seen.get(&k) == Some(&Some(h.clone())) { continue; } }
                    if h.is_none() && !seen.contains_key(&k) && mine.is_none() { continue; } // чужой временный файл
                    seen.insert(k, h);
                    files.push(rel);
                }
                files.sort();
                if !files.is_empty() { on_change(files); }
            }
        });
        Watcher { stop, _notify: notify }
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::tmpdir;

    #[test]
    fn relevance() {
        assert!(is_relevant("project.json") && is_relevant("Главы/a.md") && is_relevant("Заметки\\x.md"));
        assert!(!is_relevant("Главы/a.md.1.tmp") && !is_relevant(".DS_Store") && !is_relevant("Главы/sub/a.md") && !is_relevant("other.txt"));
    }

    #[test]
    fn reports_foreign_changes_only() {
        let dir = tmpdir("watch");
        std::fs::create_dir_all(dir.join("Главы")).unwrap();
        let got: Arc<Mutex<Vec<Vec<String>>>> = Arc::new(Mutex::new(vec![]));
        let g = got.clone();
        let _w = Watcher::start(&dir, Arc::new(move |f| g.lock().unwrap().push(f)), Duration::from_millis(150), Duration::from_millis(300));
        std::thread::sleep(Duration::from_millis(300));
        let mine = dir.join("Главы/a.md");
        crate::store::write_atomic(&mine, "наша запись").unwrap();
        std::thread::sleep(Duration::from_millis(1200));
        assert!(got.lock().unwrap().is_empty(), "своя запись не считается чужой: {:?}", got.lock().unwrap());
        std::fs::write(&mine, "чужая правка").unwrap();
        for _ in 0..40 { if !got.lock().unwrap().is_empty() { break; } std::thread::sleep(Duration::from_millis(100)); }
        assert_eq!(got.lock().unwrap().concat(), vec!["Главы/a.md".to_string()]);
    }
}
