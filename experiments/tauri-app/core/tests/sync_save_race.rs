//! Deterministic snapshot -> local save -> remote apply regressions.
//! No network, threads, sleeps, or production-code hooks.
use kabinet_core::foldersync::FolderSync;
use kabinet_core::remote::{Item, Remote};
use kabinet_core::store::{self, R};
use serde_json::json;
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

const FIRST: &str = "Главы/aaaaaa.md";
const SECOND: &str = "Главы/bbbbbb.md";
const BASE: &str = "base second chapter";
const LOCAL: &str = "local edit saved after the snapshot";
const CLOUD: &str = "new cloud version";

struct TempProject(PathBuf);

impl TempProject {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "kabinet-sync-save-race-{}-{:016x}",
            std::process::id(), rand::random::<u64>()
        ));
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}

impl Drop for TempProject {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[derive(Default)]
struct MemoryRemote {
    files: BTreeMap<String, Vec<u8>>,
    save_during_first_upload: Option<PathBuf>,
    hook_ran: bool,
}

impl Remote for MemoryRemote {
    fn list(&mut self, rel: &str) -> R<Vec<Item>> {
        let prefix = if rel.is_empty() { String::new() } else { format!("{rel}/") };
        let mut entries = BTreeMap::new();
        for (path, bytes) in &self.files {
            let Some(tail) = path.strip_prefix(&prefix) else { continue };
            if tail.is_empty() { continue; }
            let (name, dir) = match tail.split_once('/') {
                Some((name, _)) => (name, true),
                None => (tail, false),
            };
            entries.entry(name.to_string()).or_insert_with(|| Item {
                name: name.to_string(),
                dir,
                size: if dir { -1 } else { bytes.len() as i64 },
                mtime: 0,
            });
        }
        Ok(entries.into_values().collect())
    }

    fn read(&mut self, rel: &str) -> R<Option<Vec<u8>>> {
        Ok(self.files.get(rel).cloned())
    }

    fn write(&mut self, rel: &str, bytes: &[u8]) -> R<()> {
        if rel == FIRST {
            if let Some(dir) = self.save_during_first_upload.take() {
                let result = store::write_chapter(&dir, "bbbbbb", LOCAL)?;
                assert!(result["conflict"].is_null());
                assert_eq!(fs::read(dir.join(SECOND)).unwrap(), LOCAL.as_bytes());
                self.hook_ran = true;
            }
        }
        self.files.insert(rel.to_string(), bytes.to_vec());
        Ok(())
    }

    fn remove(&mut self, rel: &str) -> R<()> {
        self.files.remove(rel);
        Ok(())
    }

    fn mkdir(&mut self, _rel: &str) -> R<()> {
        Ok(())
    }
}

fn fixture() -> (TempProject, FolderSync<MemoryRemote>) {
    let project = TempProject::new();
    let mut remote = MemoryRemote::default();
    let meta = json!({
        "name": "Race regression",
        "chapters": [
            {"id": "aaaaaa", "title": "First"},
            {"id": "bbbbbb", "title": "Second"}
        ]
    });
    remote.files.insert("project.json".into(), serde_json::to_vec(&meta).unwrap());
    remote.files.insert(FIRST.into(), b"base first chapter".to_vec());
    remote.files.insert(SECOND.into(), BASE.as_bytes().to_vec());
    let mut sync = FolderSync::new(&project.0, remote, None);
    sync.import_all().unwrap();
    assert_eq!(store::read_chapter(&project.0, "bbbbbb").unwrap(), BASE);
    (project, sync)
}

fn local_has(sync: &FolderSync<MemoryRemote>, text: &str) -> bool {
    if fs::read(sync.dir.join(SECOND)).ok().as_deref() == Some(text.as_bytes()) {
        return true;
    }
    let Ok(entries) = fs::read_dir(sync.dir.join("Конфликты")) else { return false };
    entries.filter_map(Result::ok).any(|e| {
        fs::read(e.path()).ok().as_deref() == Some(text.as_bytes())
    })
}

#[test]
fn local_save_after_snapshot_survives_cloud_update() {
    let (project, mut sync) = fixture();
    store::write_chapter(&project.0, "aaaaaa", "local first chapter edit").unwrap();
    sync.remote.files.insert(SECOND.into(), CLOUD.as_bytes().to_vec());
    sync.remote.save_during_first_upload = Some(project.0.clone());

    sync.sync().unwrap();

    assert!(sync.remote.hook_ran, "the local save must occur during this sync pass");
    assert!(local_has(&sync, LOCAL), "sync lost the successfully saved local edit");
    assert!(
        local_has(&sync, CLOUD)
            || sync.remote.files.values().any(|b| b.as_slice() == CLOUD.as_bytes()),
        "the cloud version must also remain available"
    );
}

#[test]
fn local_save_after_snapshot_survives_cloud_delete() {
    let (project, mut sync) = fixture();
    store::write_chapter(&project.0, "aaaaaa", "local first chapter edit").unwrap();
    sync.remote.files.remove(SECOND);
    sync.remote.save_during_first_upload = Some(project.0.clone());

    sync.sync().unwrap();

    assert!(sync.remote.hook_ran, "the local save must occur during this sync pass");
    assert!(local_has(&sync, LOCAL), "cloud deletion lost the successfully saved local edit");
}

#[test]
fn cloud_update_without_concurrent_save_still_applies() {
    let (_project, mut sync) = fixture();
    sync.remote.files.insert(SECOND.into(), CLOUD.as_bytes().to_vec());

    let result = sync.sync().unwrap();

    assert!(!sync.remote.hook_ran);
    assert_eq!(fs::read(sync.dir.join(SECOND)).unwrap(), CLOUD.as_bytes());
    assert!(result.pulled.iter().any(|p| p == SECOND));
    assert!(result.conflicts.is_empty());
}
