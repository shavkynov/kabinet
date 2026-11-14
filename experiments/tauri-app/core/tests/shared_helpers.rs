use kabinet_core::store;
use serde_json::json;
use std::fs;

#[test]
fn read_image_encodes_with_standard_base64() {
    let dir = std::env::temp_dir().join(format!("kabinet-image-{}-{:016x}", std::process::id(), rand::random::<u64>()));
    store::create_project(&dir, "Картинки", None).unwrap();
    let folder = dir.join("Картинки");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("abcdef.png"), [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]).unwrap();
    assert_eq!(store::read_image(&dir, "abcdef.png").unwrap(), json!("data:image/png;base64,iVBORw0KGgo="));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn project_file_names_are_still_recognised_as_syncable() {
    use kabinet_core::foldersync::is_syncable;
    assert!(is_syncable("project.json") && is_syncable("project-2.json") && is_syncable("stats.json"));
    assert!(!is_syncable("projectx.txt") && !is_syncable("kabinet.lock") && !is_syncable("notes.json"));
    for _ in 0..1000 {
        assert!(is_syncable("Главы/abcdef.md"));
    }
}
