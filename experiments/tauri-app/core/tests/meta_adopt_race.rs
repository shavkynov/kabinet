//! Первый проход двух независимых проектов (adopt_remote_structure): локальная мета читается в начале,
//! затем идут сетевые вызовы (копия в «Конфликты»), и только потом результат пишется поверх project.json.
//! Сохранение, случившееся между чтением и записью, не должно теряться молча.
//! Без потоков, пауз и тестовых точек в рабочем коде: сохранение запускается из Remote::write.
use kabinet_core::foldersync::FolderSync;
use kabinet_core::remote::{Item, Remote};
use kabinet_core::store::{self, R};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

const L2_TITLE: &str = "title saved during the first sync";
const TYPED: &str = "text typed into the empty chapter during the first sync";

struct TempProject(PathBuf);
impl TempProject {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("kabinet-meta-adopt-race-{}-{:016x}", std::process::id(), rand::random::<u64>()));
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}
impl Drop for TempProject {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}

#[derive(Default)]
struct MemoryRemote {
    files: BTreeMap<String, Vec<u8>>,
    /// Что сделать при первой записи копии в «Конфликты»: сохранение метки и/или текста главы.
    on_first_conflict_copy: Option<(PathBuf, bool, bool)>,
    hook_ran: bool,
}

impl Remote for MemoryRemote {
    fn list(&mut self, rel: &str) -> R<Vec<Item>> {
        let prefix = if rel.is_empty() { String::new() } else { format!("{rel}/") };
        let mut entries = BTreeMap::new();
        for (path, bytes) in &self.files {
            let Some(tail) = path.strip_prefix(&prefix) else { continue };
            if tail.is_empty() { continue; }
            let (name, dir) = match tail.split_once('/') { Some((n, _)) => (n, true), None => (tail, false) };
            entries.entry(name.to_string()).or_insert_with(|| Item { name: name.to_string(), dir, size: if dir { -1 } else { bytes.len() as i64 }, mtime: 0 });
        }
        Ok(entries.into_values().collect())
    }
    fn read(&mut self, rel: &str) -> R<Option<Vec<u8>>> { Ok(self.files.get(rel).cloned()) }
    fn write(&mut self, rel: &str, bytes: &[u8]) -> R<()> {
        if rel.starts_with("Конфликты/") {
            if let Some((dir, rename, type_text)) = self.on_first_conflict_copy.take() {
                if rename { store::rename_chapter(&dir, "aaaaaa", L2_TITLE).unwrap(); }
                if type_text { store::write_chapter(&dir, "cccccc", TYPED).unwrap(); }
                self.hook_ran = true;
            }
        }
        self.files.insert(rel.to_string(), bytes.to_vec());
        Ok(())
    }
    fn remove(&mut self, rel: &str) -> R<()> { self.files.remove(rel); Ok(()) }
    fn mkdir(&mut self, _rel: &str) -> R<()> { Ok(()) }
}

/// Облако: проект с одной главой. У нас: тот же проект + глава с текстом (чтобы было что сохранять)
/// + пустая глава, которой в облаке нет. Состояния синхронизации нет: это первый проход.
fn fixture() -> (TempProject, FolderSync<MemoryRemote>) {
    let project = TempProject::new();
    let mut remote = MemoryRemote::default();
    remote.files.insert("project.json".into(), serde_json::to_vec(&json!({"name": "Роман", "chapters": [{"id": "aaaaaa", "title": "Первая"}]})).unwrap());
    remote.files.insert("Главы/aaaaaa.md".into(), "облачный текст".as_bytes().to_vec());
    let dir = &project.0;
    fs::create_dir_all(dir.join("Главы")).unwrap();
    fs::write(dir.join("project.json"), serde_json::to_vec_pretty(&json!({
        "name": "Роман",
        "chapters": [{"id": "aaaaaa", "title": "Первая"}, {"id": "bbbbbb", "title": "Своя"}, {"id": "cccccc", "title": "Пустая"}]
    })).unwrap()).unwrap();
    fs::write(dir.join("Главы/aaaaaa.md"), "наш текст").unwrap();
    fs::write(dir.join("Главы/bbbbbb.md"), "своя глава, которой нет в облаке").unwrap();
    fs::write(dir.join("Главы/cccccc.md"), "").unwrap();
    let sync = FolderSync::new(dir, remote, None).unwrap();
    (project, sync)
}

fn conflict_texts(dir: &PathBuf) -> Vec<String> {
    match fs::read_dir(dir.join("Конфликты")) {
        Ok(e) => e.filter_map(Result::ok).filter_map(|e| fs::read_to_string(e.path()).ok()).collect(),
        Err(_) => vec![],
    }
}

fn live_meta(dir: &PathBuf) -> Value { serde_json::from_slice(&fs::read(dir.join("project.json")).unwrap()).unwrap() }

#[test]
fn control_first_sync_adopts_remote_and_keeps_local_meta_copy() {
    let (p, mut sync) = fixture();
    sync.sync().unwrap();
    let meta = live_meta(&p.0);
    let ids: Vec<&str> = meta["chapters"].as_array().unwrap().iter().filter_map(|c| c["id"].as_str()).collect();
    assert!(ids.contains(&"aaaaaa") && ids.contains(&"bbbbbb"), "adopt must keep our non-empty chapter: {ids:?}");
    assert!(conflict_texts(&p.0).iter().any(|t| t.contains("Своя")), "our meta from before adopt must stay in «Конфликты»");
}

#[test]
fn meta_saved_during_first_sync_is_not_lost() {
    let (p, mut sync) = fixture();
    sync.remote.on_first_conflict_copy = Some((p.0.clone(), true, false));
    sync.sync().unwrap();
    assert!(sync.remote.hook_ran, "the save must happen inside the sync pass");
    let live = serde_json::to_string(&live_meta(&p.0)).unwrap();
    assert!(
        live.contains(L2_TITLE) || conflict_texts(&p.0).iter().any(|t| t.contains(L2_TITLE)),
        "first sync silently overwrote project.json saved during the pass"
    );
}

#[test]
fn text_typed_into_empty_chapter_during_first_sync_is_not_lost() {
    let (p, mut sync) = fixture();
    sync.remote.on_first_conflict_copy = Some((p.0.clone(), false, true));
    sync.sync().unwrap();
    assert!(sync.remote.hook_ran, "the save must happen inside the sync pass");
    let on_disk = fs::read_to_string(p.0.join("Главы/cccccc.md")).ok();
    assert!(
        on_disk.as_deref() == Some(TYPED) || conflict_texts(&p.0).iter().any(|t| t == TYPED),
        "first sync removed the chapter file that received text during the pass"
    );
}
