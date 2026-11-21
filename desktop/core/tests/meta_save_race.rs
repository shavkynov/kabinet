//! Регрессия сохранности project.json (интеграционный тест).
//! «Локальная команда» читает мету до того, как проход синхронизации скачал облачную версию,
//! и сохраняет свою устаревшую копию уже после этого. Устаревшее сохранение не должно терять
//! скачанную облачную версию: она сохраняется в «Конфликты», своя правка остаётся в живой мете.
//! Рядом — контрольный сценарий без устаревшего сохранения: облачная версия должна скачаться.
use kabinet_core::foldersync::FolderSync;
use kabinet_core::remote::{Item, Remote};
use kabinet_core::store::{self, R};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const LOCAL_TITLE: &str = "Локальное переименование во время синхронизации";
const CLOUD_TITLE: &str = "Переименование с другого устройства";

struct TempProject(PathBuf);

impl TempProject {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "kabinet-meta-save-race-{}-{:016x}",
            std::process::id(),
            rand::random::<u64>()
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

/// Подставная папка с двумя точками вмешательства «локальной команды»:
/// точка 1 — `read("project.json")` (команда читает мету в память);
/// точка 2 — первая запись главы (команда сохраняет устаревшую мету).
/// `loaded`/`saved` — явные признаки фактического срабатывания точек.
#[derive(Default)]
struct MemoryRemote {
    files: BTreeMap<String, Vec<u8>>,
    dir: PathBuf,
    stale_meta: Option<Map<String, Value>>,
    arm_save: bool,
    loaded: bool,
    saved: bool,
}

impl Remote for MemoryRemote {
    fn list(&mut self, rel: &str) -> R<Vec<Item>> {
        let prefix = if rel.is_empty() { String::new() } else { format!("{rel}/") };
        let mut entries = BTreeMap::new();
        for (path, bytes) in &self.files {
            let Some(tail) = path.strip_prefix(&prefix) else { continue };
            if tail.is_empty() {
                continue;
            }
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
        if rel == "project.json" && !self.loaded {
            self.loaded = true;
            let mut meta = store::load_meta(&self.dir)?;
            meta["chapters"][0]["title"] = json!(LOCAL_TITLE);
            self.stale_meta = Some(meta);
        }
        Ok(self.files.get(rel).cloned())
    }

    fn write(&mut self, rel: &str, bytes: &[u8]) -> R<()> {
        if rel.starts_with("Главы/") {
            if let Some(meta) = self.stale_meta.take() {
                if self.arm_save {
                    store::save_meta(&self.dir, &meta)?;
                    self.saved = true;
                }
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

fn remote_meta(remote: &MemoryRemote) -> Value {
    serde_json::from_slice(remote.files.get("project.json").unwrap()).unwrap()
}

fn conflicts_contain(dir: &Path, needle: &str) -> bool {
    match fs::read_dir(dir.join("Конфликты")) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .any(|e| fs::read_to_string(e.path()).map(|t| t.contains(needle)).unwrap_or(false)),
        Err(_) => false,
    }
}

/// Проект с одной главой + подставная папка, куда он выгружен; облако переименовало главу.
fn setup(arm_save: bool) -> (TempProject, String, FolderSync<MemoryRemote>) {
    let project = TempProject::new();
    let view = store::create_project(&project.0, "Meta race", None).unwrap();
    let first = view["chapters"][0]["id"].as_str().unwrap().to_string();
    store::write_chapter(&project.0, &first, "base first chapter").unwrap();

    let mut remote = MemoryRemote::default();
    remote.dir = project.0.clone();
    remote.arm_save = arm_save;
    let mut sync = FolderSync::new(&project.0, remote, None).unwrap();
    sync.export_all().unwrap();

    // Облако переименовало первую главу.
    let mut cloud = remote_meta(&sync.remote);
    cloud["chapters"][0]["title"] = json!(CLOUD_TITLE);
    sync.remote
        .files
        .insert("project.json".into(), serde_json::to_vec_pretty(&cloud).unwrap());

    // Локально правим главу, чтобы проход выгрузил её ПОСЛЕ project.json.
    store::write_chapter(&project.0, &first, "local chapter edit").unwrap();
    (project, first, sync)
}

/// Устаревшее сохранение меты не затирает скачанный облачный project.json:
/// своя правка остаётся в живой мете, облачная версия — в «Конфликты».
#[test]
fn stale_local_meta_save_keeps_pulled_project_json() {
    let (project, _first, mut sync) = setup(true);

    // 1-й проход: pull облачного project.json, затем сохранение устаревшей меты.
    sync.sync().unwrap();
    assert!(sync.remote.loaded, "точка 1 (чтение меты) не сработала");
    assert!(sync.remote.saved, "точка 2 (устаревшее сохранение) не сработала");
    assert_eq!(remote_meta(&sync.remote)["chapters"][0]["title"], CLOUD_TITLE,
        "после 1-го прохода облако ещё хранит свою версию");
    let local = store::load_meta(&project.0).unwrap();
    assert_eq!(local["chapters"][0]["title"], LOCAL_TITLE,
        "своя правка должна остаться в живой мете");
    assert!(conflicts_contain(&project.0, CLOUD_TITLE),
        "облачная версия должна быть сохранена в «Конфликты», а не потеряна молча");

    // 2-й проход: локальная мета уходит в облако, конфликт остаётся доступным.
    sync.sync().unwrap();
    assert_eq!(remote_meta(&sync.remote)["chapters"][0]["title"], LOCAL_TITLE,
        "устаревшая мета не должна терять локальную правку");
    assert!(conflicts_contain(&project.0, CLOUD_TITLE),
        "копия облачной версии не должна исчезать после второго прохода");
}

/// Контроль: без устаревшего сохранения облачный project.json скачивается и остаётся.
#[test]
fn control_without_stale_save_keeps_pulled_project_json() {
    let (project, _first, mut sync) = setup(false);

    sync.sync().unwrap();
    assert!(sync.remote.loaded, "точка 1 (чтение меты) не сработала");
    assert!(!sync.remote.saved, "точка 2 не должна была сработать в контроле");
    let local = store::load_meta(&project.0).unwrap();
    assert_eq!(local["chapters"][0]["title"], CLOUD_TITLE,
        "контроль: облачная версия должна быть скачана");
    assert_eq!(remote_meta(&sync.remote)["chapters"][0]["title"], CLOUD_TITLE);
    assert!(!conflicts_contain(&project.0, CLOUD_TITLE));

    // 2-й проход ничего не меняет: локально и в облаке облачная версия.
    sync.sync().unwrap();
    assert_eq!(store::load_meta(&project.0).unwrap()["chapters"][0]["title"], CLOUD_TITLE);
    assert_eq!(remote_meta(&sync.remote)["chapters"][0]["title"], CLOUD_TITLE);
    assert!(!conflicts_contain(&project.0, CLOUD_TITLE));
}
