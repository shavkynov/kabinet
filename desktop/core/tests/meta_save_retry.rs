//! Повтор save_meta после отказа создания конфликтной копии.
//! Проверяется API load_meta/save_meta с тем же объектом, без нового load_meta.
//! Это не утверждение о воспроизведении через Tauri IPC: штатная команда при новом вызове может перечитать мету.
use kabinet_core::store;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::PathBuf;

struct Project(PathBuf);
impl Project {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "kabinet-meta-save-retry-{}-{:016x}", std::process::id(), rand::random::<u64>()
        ));
        let project = Self(dir);
        store::create_project(&project.0, "Retry", None).unwrap();
        project
    }
    fn meta(&self) -> PathBuf { self.0.join("project.json") }
    fn conflicts(&self) -> PathBuf { self.0.join("Конфликты") }
    fn read(&self) -> Value { serde_json::from_slice(&fs::read(self.meta()).unwrap()).unwrap() }
    fn has_copy(&self, bytes: &[u8]) -> bool {
        match fs::read_dir(self.conflicts()) {
            Ok(entries) => entries.map(Result::unwrap).any(|e| fs::read(e.path()).unwrap().as_slice() == bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => panic!("cannot inspect conflict copies: {}", e),
        }
    }
}
impl Drop for Project {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}

fn failed_archive() -> (Project, Map<String, Value>, Vec<u8>) {
    let p = Project::new();
    let mut pending = store::load_meta(&p.0).unwrap();
    pending.insert("name".into(), json!("local rename"));
    let mut foreign = p.read();
    foreign["remoteOnly"] = json!("foreign metadata must remain available");
    let bytes = serde_json::to_vec_pretty(&foreign).unwrap();
    fs::write(p.meta(), &bytes).unwrap();

    // Детерминированный отказ на всех платформах: вместо каталога копий лежит файл.
    fs::write(p.conflicts(), b"block conflict directory").unwrap();
    assert!(store::save_meta(&p.0, &pending).is_err());
    assert_eq!(fs::read(p.meta()).unwrap(), bytes);
    assert!(p.conflicts().is_file());
    fs::remove_file(p.conflicts()).unwrap();
    (p, pending, bytes)
}

#[test]
fn retry_same_meta_after_archive_failure_keeps_foreign_copy() {
    let (p, pending, foreign) = failed_archive();
    // Принципиально без load_meta: повторяется тот же запрос с тем же объектом.
    store::save_meta(&p.0, &pending).unwrap();
    assert_eq!(p.read()["name"], json!("local rename"));
    assert!(p.has_copy(&foreign), "retry silently overwrote the foreign metadata without a conflict copy");
}

#[test]
fn control_fresh_read_after_failure_keeps_foreign_fields_live() {
    let (p, _pending, foreign) = failed_archive();
    let mut fresh = store::load_meta(&p.0).unwrap();
    fresh.insert("name".into(), json!("local rename"));
    store::save_meta(&p.0, &fresh).unwrap();
    let live = p.read();
    assert_eq!(live["name"], json!("local rename"));
    assert_eq!(live["remoteOnly"], json!("foreign metadata must remain available"));
    assert!(!p.has_copy(&foreign), "a fresh sequential edit should not need a foreign conflict copy");
}
