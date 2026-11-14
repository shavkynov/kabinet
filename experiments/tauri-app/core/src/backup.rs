//! Резервные копии проекта: обычные папки с копиями файлов. Копия делается, только если что-то изменилось.
//! Порт src/backup.js и detectCloud из src/cloud.js.
use crate::store::R;
use crate::syncguard::stamp_now;
use sha1::{Digest, Sha1};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

pub const BACKUP_DIR: &str = "Резервные копии";
const SKIP: [&str; 3] = [BACKUP_DIR, "Корзина", "kabinet.lock"];

pub fn detect_cloud(dir: &Path) -> Option<&'static str> {
    let p = dir.to_string_lossy().replace('\\', "/").to_lowercase();
    if p.contains("/library/mobile documents/") || p.contains("com~apple~clouddocs") { return Some("iCloud Drive"); }
    if p.contains("/dropbox") { return Some("Dropbox"); }
    if p.contains("googledrive") || p.contains("google drive") { return Some("Google Drive"); }
    if p.contains("onedrive") { return Some("OneDrive"); }
    if (p.contains("yandex") && p.contains("disk")) || p.contains("/яндекс.диск") || p.contains("/yandexdisk") { return Some("Яндекс Диск"); }
    None
}

/// Куда складывать копии: внутрь проекта; для проектов в облачных папках — в данные приложения,
/// чтобы копии не гонялись между устройствами и не пропадали вместе с проектом.
pub fn backup_root(data_dir: &Path, dir: &Path) -> PathBuf {
    if detect_cloud(dir).is_none() { return dir.join(BACKUP_DIR); }
    let mut h = Sha1::new();
    h.update(dir.to_string_lossy().as_bytes());
    let key: String = h.finalize().iter().map(|b| format!("{:02x}", b)).collect::<String>().chars().take(8).collect();
    let name: String = dir.file_name().map(|n| n.to_string_lossy().chars().map(|c| if "\\/:*?\"<>|".contains(c) { '-' } else { c }).collect()).unwrap_or_default();
    data_dir.join("Копии").join(format!("{}-{}", if name.is_empty() { "project" } else { &name }, key))
}

fn list_files(root: &Path, rel: &Path, out: &mut Vec<String>) -> R<()> {
    let rd = fs::read_dir(root.join(rel)).map_err(|e| format!("Не удалось прочитать папку «{}» для копии: {}. Копия не создана.", rel.display(), e))?;
    for e in rd {
        let e = e.map_err(|e| format!("Ошибка обхода папки для копии: {}. Копия не создана.", e))?;
        let name = e.file_name().to_string_lossy().to_string();
        let r = if rel.as_os_str().is_empty() { PathBuf::from(&name) } else { rel.join(&name) };
        if rel.as_os_str().is_empty() && SKIP.contains(&name.as_str()) { continue; }
        if name.ends_with(".tmp") || name == ".DS_Store" || name == ".sig" { continue; }
        let ft = e.file_type().map_err(|e| format!("Не удалось определить тип «{}»: {}. Копия не создана.", r.display(), e))?;
        if ft.is_dir() { list_files(root, &r, out)?; } else if ft.is_file() { out.push(r.to_string_lossy().to_string()); }
    }
    Ok(())
}

fn signature(root: &Path, files: &[String]) -> R<String> {
    let mut h = Sha1::new();
    for f in files {
        let full = root.join(f);
        h.update(f.as_bytes());
        h.update([0u8]);
        // Хеш содержимого, а не размер/mtime: подмена бинарного файла при том же размере и времени
        // не должна оставаться незамеченной. Ошибка чтения останавливает копию, а не даёт «нет изменений».
        let b = fs::read(&full).map_err(|e| format!("Не удалось прочитать «{}» для копии: {}. Копия не создана.", f, e))?;
        h.update(&b);
        h.update([0u8]);
    }
    Ok(h.finalize().iter().map(|b| format!("{:02x}", b)).collect())
}

fn is_backup_name(n: &str) -> bool {
    let b = n.as_bytes();
    b.len() == 19 && b.iter().enumerate().all(|(i, c)| match i { 4 | 7 | 13 | 16 => *c == b'-', 10 => *c == b' ', _ => c.is_ascii_digit() })
}

pub fn list_backups(root: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(root).map(|rd| rd.flatten().filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| is_backup_name(n)).collect()).unwrap_or_default();
    v.sort();
    v
}

/// Какие копии оставить: последние `keep` и самая поздняя копия каждого из `keep_days` последних дней, когда копии делались.
pub fn copies_to_keep(all: &[String], keep: usize, keep_days: usize) -> BTreeSet<String> {
    let mut set: BTreeSet<String> = all[all.len().saturating_sub(keep)..].iter().cloned().collect();
    let mut days: BTreeSet<String> = BTreeSet::new();
    for name in all.iter().rev() {
        if keep_days == 0 { break; }
        let day: String = name.chars().take(10).collect();
        if days.contains(&day) { continue; }
        if days.len() >= keep_days { break; }
        days.insert(day);
        set.insert(name.clone());
    }
    set
}

/// Делает копию. Возвращает имя папки копии или None, если менять было нечего.
pub fn make_backup(dir: &Path, root: &Path, name_override: Option<&str>) -> R<Option<String>> {
    let (keep, keep_days) = (60, 30);
    let mut files = Vec::new();
    list_files(dir, Path::new(""), &mut files)?;
    files.sort();
    if files.is_empty() { return Ok(None); }
    let sig = signature(dir, &files)?;
    let existing = list_backups(root);
    if let Some(last) = existing.last() {
        if fs::read_to_string(root.join(last).join(".sig")).map(|s| s.trim() == sig).unwrap_or(false) { return Ok(None); }
    }
    let name = name_override.map(String::from).unwrap_or_else(stamp_now);
    if existing.contains(&name) { return Ok(None); }
    let target = root.join(&name);
    let tmp = root.join(format!("{}.tmp", name));
    let _ = fs::remove_dir_all(&tmp);
    for f in &files {
        let to = tmp.join(f);
        if let Some(p) = to.parent() { fs::create_dir_all(p).map_err(|e| format!("Не удалось сделать копию: {}", e))?; }
        fs::copy(dir.join(f), &to).map_err(|e| format!("Не удалось сделать копию: {}", e))?;
    }
    fs::write(tmp.join(".sig"), &sig).map_err(|e| format!("Не удалось сделать копию: {}", e))?;
    fs::rename(&tmp, &target).map_err(|e| format!("Не удалось сделать копию: {}", e))?;
    let all = list_backups(root);
    let mut keep_set = copies_to_keep(&all, keep, keep_days);
    keep_set.insert(name.clone()); // только что сделанную копию не удаляем никогда
    for old in all { if !keep_set.contains(&old) { let _ = fs::remove_dir_all(root.join(old)); } }
    Ok(Some(name))
}

/// Проверить целостность ранее сделанной копии: пересчитать подпись по содержимому и сравнить с `.sig`.
/// Отсутствие/ошибка чтения подписи или файлов — `Err`, чтобы это не приняли за «целую» копию.
pub fn verify_backup(root: &Path, name: &str) -> R<bool> {
    let dir = root.join(name);
    let stored = fs::read_to_string(dir.join(".sig"))
        .map_err(|e| format!("Не удалось прочитать подпись копии «{}»: {}. Проверить целостность нельзя.", name, e))?;
    let mut files = Vec::new();
    list_files(&dir, Path::new(""), &mut files)?;
    files.sort();
    let computed = signature(&dir, &files)?;
    Ok(computed == stored.trim())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::tmpdir;

    #[test]
    fn makes_copy_only_when_changed() {
        let dir = tmpdir("b").join("p");
        fs::create_dir_all(dir.join("Главы")).unwrap();
        fs::write(dir.join("project.json"), "{}").unwrap();
        fs::write(dir.join("Главы/a.md"), "один").unwrap();
        fs::write(dir.join("kabinet.lock"), "x").unwrap();
        let root = dir.join(BACKUP_DIR);
        assert_eq!(make_backup(&dir, &root, Some("2026-01-01 10-00-00")).unwrap().as_deref(), Some("2026-01-01 10-00-00"));
        assert!(root.join("2026-01-01 10-00-00/Главы/a.md").exists());
        assert!(!root.join("2026-01-01 10-00-00/kabinet.lock").exists());
        assert_eq!(make_backup(&dir, &root, Some("2026-01-01 10-00-05")).unwrap(), None);
        fs::write(dir.join("Главы/a.md"), "два").unwrap();
        assert!(make_backup(&dir, &root, Some("2026-01-01 10-00-10")).unwrap().is_some());
        assert_eq!(list_backups(&root).len(), 2);
        // сами копии в копию не попадают
        assert!(!root.join("2026-01-01 10-00-10").join(BACKUP_DIR).exists());
    }

    #[test]
    fn retention_keeps_recent_and_one_per_day() {
        let all: Vec<String> = (0..5).flat_map(|d| (0..4).map(move |h| format!("2026-01-0{} 1{}-00-00", d + 1, h))).collect();
        let keep = copies_to_keep(&all, 3, 2);
        assert!(keep.contains("2026-01-05 13-00-00") && keep.contains("2026-01-05 12-00-00") && keep.contains("2026-01-05 11-00-00"));
        assert!(keep.contains("2026-01-04 13-00-00")); // последняя копия предыдущего дня
        assert!(!keep.contains("2026-01-03 13-00-00"));
        assert!(is_backup_name("2026-01-01 10-00-00") && !is_backup_name("x"));
    }

    #[test]
    fn cloud_projects_keep_copies_elsewhere() {
        let data = Path::new("/data");
        assert_eq!(backup_root(data, Path::new("/home/a/Roman")), Path::new("/home/a/Roman").join(BACKUP_DIR));
        let r = backup_root(data, Path::new("/home/a/Dropbox/Roman"));
        assert!(r.starts_with("/data/Копии") && r.to_string_lossy().contains("Roman-"));
        assert_eq!(detect_cloud(Path::new("C:\\Users\\me\\OneDrive\\x")), Some("OneDrive"));
    }

    #[test]
    fn backup_detects_binary_change_with_same_size_and_mtime() {
        let dir = tmpdir("backup-bin").join("p");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("project.json"), "{}").unwrap();
        fs::write(dir.join("data.bin"), b"AAAA").unwrap();
        let root = dir.join(BACKUP_DIR);
        assert!(make_backup(&dir, &root, Some("2026-01-01 10-00-00")).unwrap().is_some());
        let mtime = fs::metadata(dir.join("data.bin")).unwrap().modified().unwrap();
        // содержимое меняется, а размер и время изменения сохраняются
        fs::write(dir.join("data.bin"), b"BBBB").unwrap();
        fs::File::options().write(true).open(dir.join("data.bin")).unwrap()
            .set_times(fs::FileTimes::new().set_modified(mtime)).unwrap();
        assert_eq!(fs::metadata(dir.join("data.bin")).unwrap().modified().unwrap(), mtime);
        let second = make_backup(&dir, &root, Some("2026-01-01 10-00-01")).unwrap();
        assert!(second.is_some(), "изменение бинарного файла при том же размере и времени не должно пропускаться");
        assert_eq!(fs::read(root.join(second.unwrap()).join("data.bin")).unwrap(), b"BBBB");
    }

    #[test]
    fn backup_verification_detects_corruption_and_missing_signature() {
        let dir = tmpdir("verify").join("p");
        fs::create_dir_all(dir.join("Главы")).unwrap();
        fs::write(dir.join("project.json"), "{}").unwrap();
        fs::write(dir.join("Главы/a.md"), "один").unwrap();
        let root = dir.join(BACKUP_DIR);
        let name = make_backup(&dir, &root, Some("2026-01-01 10-00-00")).unwrap().unwrap();
        assert!(verify_backup(&root, &name).unwrap(), "целая копия должна подтверждаться");
        // порча файла в копии обнаруживается
        fs::write(root.join(&name).join("Главы/a.md"), "два").unwrap();
        assert!(!verify_backup(&root, &name).unwrap(), "порча копии должна обнаруживаться");
        // вторая копия после изменения проекта, затем лишаем её подписи
        fs::write(dir.join("Главы/b.md"), "три").unwrap();
        let name2 = make_backup(&dir, &root, Some("2026-01-01 10-00-01")).unwrap().unwrap();
        fs::remove_file(root.join(&name2).join(".sig")).unwrap();
        assert!(verify_backup(&root, &name2).is_err(), "без .sig целостность нельзя подтвердить");
    }

    #[cfg(windows)]
    #[test]
    fn backup_does_not_follow_directory_junctions() {
        use std::process::Command;
        let base = tmpdir("backup-link");
        let dir = base.join("p");
        fs::create_dir_all(dir.join("Главы")).unwrap();
        fs::write(dir.join("project.json"), "{}").unwrap();
        fs::write(dir.join("Главы/a.md"), "текст").unwrap();
        let outside = base.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.md"), "внешний файл").unwrap();
        let link = dir.join("Главы").join("link");
        let st = Command::new("cmd").args(["/c", "mklink", "/J"]).arg(&link).arg(&outside).status().unwrap();
        assert!(st.success(), "не удалось создать junction");
        let root = dir.join(BACKUP_DIR);
        let name = make_backup(&dir, &root, Some("2026-01-01 10-00-00")).unwrap().unwrap();
        assert!(!root.join(&name).join("Главы").join("link").exists(), "копия не должна заходить в junction");
    }
}
