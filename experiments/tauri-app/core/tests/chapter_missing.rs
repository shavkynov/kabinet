use kabinet_core::store;
use std::fs;
use std::path::PathBuf;

struct Project(PathBuf, String);
impl Project {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("kabinet-missing-{}-{:016x}", std::process::id(), rand::random::<u64>()));
        let view = store::create_project(&dir, "Проверка главы", None).unwrap();
        let id = view["chapters"][0]["id"].as_str().unwrap().to_string();
        Self(dir, id)
    }
    fn file(&self) -> PathBuf { self.0.join("Главы").join(format!("{}.md", self.1)) }
}
impl Drop for Project {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}

#[test]
fn existing_empty_chapter_is_still_valid() {
    let p = Project::new();
    assert_eq!(store::read_chapter(&p.0, &p.1).unwrap(), "");
    store::write_chapter(&p.0, &p.1, "Авторский текст").unwrap();
    assert_eq!(store::read_chapter(&p.0, &p.1).unwrap(), "Авторский текст");
}

#[test]
fn missing_chapter_is_an_error_without_recreating_or_changing_project() {
    let p = Project::new();
    let metadata = fs::read(p.0.join("project.json")).unwrap();
    fs::remove_file(p.file()).unwrap();
    let error = store::read_chapter(&p.0, &p.1).unwrap_err();
    assert!(error.contains(&p.1) && error.contains("не найден"));
    assert!(!p.file().exists());
    assert_eq!(fs::read(p.0.join("project.json")).unwrap(), metadata);
}

#[test]
fn invalid_identifiers_and_unreadable_text_do_not_become_empty_chapters() {
    let p = Project::new();
    assert!(store::read_chapter(&p.0, "../outside").is_err());
    fs::write(p.file(), [0xff, 0xfe, 0xff]).unwrap();
    assert!(store::read_chapter(&p.0, &p.1).is_err());
    assert_eq!(fs::read(p.file()).unwrap(), vec![0xff, 0xfe, 0xff]);
}
