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
    // Проверка до публикации: подпись, пересчитанная по СКОПИРОВАННЫМ файлам, должна совпасть с исходной.
    // Если нет — копия не публикуется (rename не выполняется), проект не изменён.
    let check = signature(&tmp, &files)?;
    if check != sig {
        let _ = fs::remove_dir_all(&tmp);
        return Err("Копия не совпала с исходником при проверке. Копия не опубликована.".into());
    }
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

/// Минимальный приватный шов для детерминированной инъекции ошибок в тестах восстановления.
/// В обычной сборке — no-op; в тестах — замыкание, привязанное к каталогу проекта.
mod restore_test_hook {
    #[derive(Clone, Copy, PartialEq, Eq)]
    pub(crate) enum Phase {
        ReadOriginal,
        ReadSource,
        Write,
        Rollback,
    }

    #[cfg(not(test))]
    pub(crate) fn inject(_dir: &std::path::Path, _rel: &str, _phase: Phase) -> bool {
        false
    }

    #[cfg(test)]
    mod real {
        use super::Phase;
        use std::path::Path;
        use std::sync::Mutex;

        type Hook = Box<dyn FnMut(&Path, &str, Phase) -> bool + Send>;
        static HOOK: Mutex<Option<Hook>> = Mutex::new(None);

        pub(crate) fn set(hook: Option<Hook>) {
            *HOOK.lock().unwrap_or_else(|e| e.into_inner()) = hook;
        }

        pub(crate) fn inject(dir: &Path, rel: &str, phase: Phase) -> bool {
            match HOOK.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
                Some(hook) => hook(dir, rel, phase),
                None => false,
            }
        }
    }

    #[cfg(test)]
    pub(crate) use real::{inject, set};
}

/// Прежнее состояние целевого файла на момент начала восстановления.
/// `Absent` — файла действительно нет; ошибка чтения сюда НЕ превращается (см. `read_original`).
enum Original {
    Absent,
    Data(Vec<u8>),
}

/// Прочитать прежнее состояние целевого файла, отличая отсутствие от ошибки чтения:
/// «нет файла» → `Absent`; любая другая ошибка → `Err`, чтобы её нельзя было принять за отсутствие
/// (иначе откат удалил бы существующий файл).
fn read_original(dir: &Path, rel: &str) -> R<Original> {
    if restore_test_hook::inject(dir, rel, restore_test_hook::Phase::ReadOriginal) {
        return Err(format!("Не удалось прочитать текущее состояние «{}»: искусственная ошибка (тест).", rel));
    }
    match fs::read(dir.join(rel)) {
        Ok(bytes) => Ok(Original::Data(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Original::Absent),
        Err(e) => Err(format!("Не удалось прочитать текущее состояние «{}»: {}. Восстановление остановлено.", rel, e)),
    }
}

fn read_source(backup: &Path, dir: &Path, rel: &str) -> R<Vec<u8>> {
    if restore_test_hook::inject(dir, rel, restore_test_hook::Phase::ReadSource) {
        return Err(format!("Не удалось прочитать «{}» из копии: искусственная ошибка (тест).", rel));
    }
    fs::read(backup.join(rel)).map_err(|e| format!("Не удалось прочитать «{}» из копии: {}.", rel, e))
}

fn write_target(dir: &Path, rel: &str, bytes: &[u8], rollback_pass: bool) -> R<()> {
    let phase = if rollback_pass { restore_test_hook::Phase::Rollback } else { restore_test_hook::Phase::Write };
    if restore_test_hook::inject(dir, rel, phase) {
        return Err(format!("Не удалось записать «{}»: искусственная ошибка (тест).", rel));
    }
    crate::store::write_atomic_bytes(&dir.join(rel), bytes)
}

/// Откатить уже выполненные записи в обратном порядке. Возвращает список того, что вернуть не удалось.
fn rollback(dir: &Path, journal: &[(String, Original)], written: &[String]) -> Vec<String> {
    let mut failed = Vec::new();
    for rel in written.iter().rev() {
        let Some((_, original)) = journal.iter().rev().find(|(r, _)| r == rel) else {
            failed.push(format!("«{}»: нет записи прежнего состояния", rel));
            continue;
        };
        let res = match original {
            Original::Data(bytes) => write_target(dir, rel, bytes, true),
            Original::Absent => match fs::remove_file(dir.join(rel)) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(format!("Не удалось удалить «{}»: {}", rel, e)),
            },
        };
        if let Err(e) = res {
            failed.push(e);
        }
    }
    failed
}

/// Единый путь ошибки ПОСЛЕ начала изменения проекта: откат уже записанного и честное сообщение.
/// Если писать было нечего — проект не изменён. Если откат не подтверждён — так и говорится.
fn fail_after_change(dir: &Path, journal: &[(String, Original)], written: &[String], cause: String) -> R<Vec<String>> {
    if written.is_empty() {
        return Err(format!("{}. Изменения не начаты — проект не изменён.", cause));
    }
    let failed = rollback(dir, journal, written);
    if failed.is_empty() {
        Err(format!("{}. Ранее записанные файлы возвращены к прежнему состоянию.", cause))
    } else {
        Err(format!(
            "{}. Откат НЕ ПОДТВЕРЖДЁН — возможен частичный результат. Исходная и страховочная копии не удалялись. Не удалось вернуть: {}.",
            cause,
            failed.join("; ")
        ))
    }
}

/// Восстановить файлы из проверенной копии в проект. Копия сначала проверяется, текущее состояние
/// сохраняется страховочной копией, файлы, которых в копии нет, не удаляются (новая работа не теряется).
/// Возвращает список восстановленных путей. MVP: без атомарного переключения и координации с синхронизацией.
///
/// Откат выполняется только для ОБРАБОТАННОЙ ошибки этого процесса (ошибка чтения/записи после начала
/// изменений). Если процесс убит между записями, автоматического отката нет: прежнее состояние сохранено
/// страховочной копией (сделана выше), а исходная копия не удаляется — восстановление после падения
/// процесса в этой реализации не выполняется.
pub fn restore_backup(dir: &Path, root: &Path, name: &str) -> R<Vec<String>> {
    if !verify_backup(root, name)? {
        return Err(format!("Копия «{}» повреждена. Восстановление остановлено, ничего не изменено.", name));
    }
    let backup = root.join(name);
    let mut files = Vec::new();
    list_files(&backup, Path::new(""), &mut files)?;
    files.sort();
    // Страховка: текущее состояние должно быть сохранено до изменений. Если make_backup вернул None
    // (совпадает с последней копией), убеждаемся, что последняя копия соответствует текущему
    // состоянию — иначе (имя копии совпало) восстановление не начинаем.
    if make_backup(dir, root, None)?.is_none() {
        let mut cur = Vec::new();
        list_files(dir, Path::new(""), &mut cur)?;
        cur.sort();
        let sig = signature(dir, &cur)?;
        let covered = list_backups(root).last()
            .and_then(|last| fs::read_to_string(root.join(last).join(".sig")).ok())
            .map(|s| s.trim() == sig).unwrap_or(false);
        if !covered {
            return Err("Не удалось сохранить текущее состояние перед восстановлением. Восстановление остановлено, ничего не изменено.".into());
        }
    }
    // Журнал отката: прежнее состояние каждого файла перед изменением. Живёт только в памяти —
    // после падения процесса его нет (см. doc `restore_backup`).
    let mut journal: Vec<(String, Original)> = Vec::new();
    let mut written: Vec<String> = Vec::new();
    let mut restored = Vec::new();
    for rel in &files {
        let original = match read_original(dir, rel) {
            Ok(o) => o,
            Err(cause) => return fail_after_change(dir, &journal, &written, cause),
        };
        journal.push((rel.clone(), original));
        let bytes = match read_source(&backup, dir, rel) {
            Ok(b) => b,
            Err(cause) => return fail_after_change(dir, &journal, &written, cause),
        };
        if let Err(cause) = write_target(dir, rel, &bytes, false) {
            return fail_after_change(dir, &journal, &written, cause);
        }
        written.push(rel.clone());
        restored.push(rel.replace('\\', "/"));
    }
    Ok(restored)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::restore_test_hook::{set, Phase};
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

    #[test]
    fn restore_verified_backup_keeps_newer_files() {
        let dir = tmpdir("restore").join("p");
        fs::create_dir_all(dir.join("Главы")).unwrap();
        fs::write(dir.join("project.json"), "{}").unwrap();
        fs::write(dir.join("Главы/a.md"), "исходный").unwrap();
        let root = dir.join(BACKUP_DIR);
        let name = make_backup(&dir, &root, Some("2026-01-01 10-00-00")).unwrap().unwrap();
        // автор испортил главу и добавил новую
        fs::write(dir.join("Главы/a.md"), "испорчено").unwrap();
        fs::write(dir.join("Главы/b.md"), "новая").unwrap();
        let restored = restore_backup(&dir, &root, &name).unwrap();
        assert!(restored.contains(&"Главы/a.md".to_string()));
        assert_eq!(fs::read_to_string(dir.join("Главы/a.md")).unwrap(), "исходный");
        assert_eq!(fs::read_to_string(dir.join("Главы/b.md")).unwrap(), "новая", "новая работа не потеряна");
        // повреждённая копия не восстанавливается
        fs::write(root.join(&name).join("Главы/a.md"), "порча").unwrap();
        assert!(restore_backup(&dir, &root, &name).is_err(), "повреждённая копия не должна восстанавливаться");
    }

    #[test]
    fn restore_of_missing_backup_is_rejected_without_changes() {
        let dir = tmpdir("restore-missing").join("p");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("project.json"), "{}").unwrap();
        let root = dir.join(BACKUP_DIR);
        assert!(restore_backup(&dir, &root, "2026-01-01 10-00-00").is_err(), "несуществующая копия не восстанавливается");
        assert_eq!(fs::read_to_string(dir.join("project.json")).unwrap(), "{}", "проект не изменён");
    }

    #[test]
    fn backup_skips_own_dir_trash_and_lock() {
        let dir = tmpdir("skip").join("p");
        fs::create_dir_all(dir.join(BACKUP_DIR)).unwrap();
        fs::write(dir.join(BACKUP_DIR).join("old.txt"), "x").unwrap();
        fs::create_dir_all(dir.join("Корзина")).unwrap();
        fs::write(dir.join("Корзина").join("t.txt"), "x").unwrap();
        fs::write(dir.join("kabinet.lock"), "x").unwrap();
        fs::write(dir.join("project.json"), "{}").unwrap();
        fs::create_dir_all(dir.join("Главы")).unwrap();
        fs::write(dir.join("Главы/a.md"), "текст").unwrap();
        let root = dir.join(BACKUP_DIR);
        let name = make_backup(&dir, &root, Some("2026-01-01 10-00-00")).unwrap().unwrap();
        let b = root.join(&name);
        assert!(!b.join(BACKUP_DIR).exists(), "копии не вкладываются друг в друга");
        assert!(!b.join("Корзина").exists(), "Корзина не копируется");
        assert!(!b.join("kabinet.lock").exists(), "замок не копируется");
        assert!(b.join("Главы/a.md").exists(), "главы копируются");
    }

    /// Шов `restore_test_hook` глобальный — тесты, которые им пользуются, сериализуются.
    static HOOK_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// R1.1: ошибка чтения СУЩЕСТВУЮЩЕГО целевого файла — не отсутствие; файл не перезаписывается и не удаляется.
    #[test]
    fn unreadable_existing_target_is_not_treated_as_absent() {
        let _guard = HOOK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tmpdir("r1-1").join("p");
        fs::create_dir_all(dir.join("Главы")).unwrap();
        fs::write(dir.join("Главы/a.md"), "в копии").unwrap();
        let root = dir.join(BACKUP_DIR);
        let name = make_backup(&dir, &root, Some("2026-01-01 10-00-00")).unwrap().unwrap();
        fs::write(dir.join("Главы/a.md"), "текущий текст").unwrap();

        let d = dir.clone();
        set(Some(Box::new(move |hook_dir: &Path, rel: &str, phase: Phase| {
            hook_dir == d.as_path() && rel.replace('\\', "/") == "Главы/a.md" && phase == Phase::ReadOriginal
        })));
        let res = restore_backup(&dir, &root, &name);
        set(None);

        let msg = res.expect_err("ошибка чтения существующего файла должна останавливать восстановление");
        assert!(msg.contains("не изменён") || msg.contains("возвращены"), "проект не должен остаться в частичном виде: {}", msg);
        assert_eq!(fs::read_to_string(dir.join("Главы/a.md")).unwrap(), "текущий текст", "файл не принят за отсутствующий и не перезаписан/не удалён");
    }

    /// R1.2: сбой чтения источника ПОСЛЕ успешной записи предыдущего файла — сделанное откатывается.
    #[test]
    fn source_read_error_after_first_write_rolls_back() {
        let _guard = HOOK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tmpdir("r1-2").join("p");
        fs::create_dir_all(dir.join("Главы")).unwrap();
        fs::write(dir.join("project.json"), "{\"v\":1}").unwrap();
        fs::write(dir.join("Главы/a.md"), "старый-a").unwrap();
        fs::write(dir.join("Главы/b.md"), "старый-b").unwrap();
        let root = dir.join(BACKUP_DIR);
        let name = make_backup(&dir, &root, Some("2026-01-01 10-00-00")).unwrap().unwrap();
        fs::write(dir.join("project.json"), "{\"v\":2}").unwrap();
        fs::write(dir.join("Главы/a.md"), "новый-a").unwrap();
        fs::write(dir.join("Главы/b.md"), "новый-b").unwrap();

        // порядок обхода: project.json → Главы/a.md → Главы/b.md; сбой на последнем — после двух записей
        let d = dir.clone();
        set(Some(Box::new(move |hook_dir: &Path, rel: &str, phase: Phase| {
            hook_dir == d.as_path() && rel.replace('\\', "/") == "Главы/b.md" && phase == Phase::ReadSource
        })));
        let res = restore_backup(&dir, &root, &name);
        set(None);

        let msg = res.expect_err("ошибка чтения источника после начала изменений");
        assert!(msg.contains("возвращены"), "ожидался подтверждённый откат, получено: {}", msg);
        assert_eq!(fs::read_to_string(dir.join("project.json")).unwrap(), "{\"v\":2}", "первый записанный файл откачен");
        assert_eq!(fs::read_to_string(dir.join("Главы/a.md")).unwrap(), "новый-a", "второй записанный файл откачен");
        assert_eq!(fs::read_to_string(dir.join("Главы/b.md")).unwrap(), "новый-b", "незаписанный файл не тронут");
    }

    /// R1.3: сбой основной записи и сбой обратной записи — сообщается НЕПОДТВЕРЖДЁННЫЙ откат, копии сохранены.
    #[test]
    fn write_and_rollback_errors_report_unconfirmed_rollback() {
        let _guard = HOOK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tmpdir("r1-3").join("p");
        fs::create_dir_all(dir.join("Главы")).unwrap();
        fs::write(dir.join("project.json"), "{\"v\":1}").unwrap();
        fs::write(dir.join("Главы/a.md"), "старый-a").unwrap();
        let root = dir.join(BACKUP_DIR);
        let name = make_backup(&dir, &root, Some("2026-01-01 10-00-00")).unwrap().unwrap();
        fs::write(dir.join("project.json"), "{\"v\":2}").unwrap();
        fs::write(dir.join("Главы/a.md"), "новый-a").unwrap();

        let d = dir.clone();
        set(Some(Box::new(move |hook_dir: &Path, rel: &str, phase: Phase| {
            if hook_dir != d.as_path() { return false; }
            let rel = rel.replace('\\', "/");
            (phase == Phase::Write && rel == "Главы/a.md") || (phase == Phase::Rollback && rel == "project.json")
        })));
        let res = restore_backup(&dir, &root, &name);
        set(None);

        let msg = res.expect_err("сбой записи и сбой отката");
        assert!(!msg.contains("файлы прежние"), "нет ложного подтверждения: {}", msg);
        assert!(!msg.contains("возвращены к прежнему"), "нет ложного подтверждения: {}", msg);
        assert!(msg.contains("НЕ ПОДТВЕРЖДЁН"), "явно сказано о возможном частичном состоянии: {}", msg);
        assert!(msg.contains("не удалялись"), "сказано, что копии сохранены: {}", msg);
        assert!(root.join(&name).join("project.json").exists(), "исходная копия не удалена");
        assert!(root.join(&name).join("Главы/a.md").exists());
    }

    #[test]
    fn restore_rolls_back_when_a_write_fails() {
        let dir = tmpdir("restore-rollback").join("p");
        fs::create_dir_all(dir.join("Главы")).unwrap();
        fs::write(dir.join("project.json"), "{}").unwrap();
        fs::write(dir.join("Главы/a.md"), "исходный").unwrap();
        let root = dir.join(BACKUP_DIR);
        let name = make_backup(&dir, &root, Some("2026-01-01 10-00-00")).unwrap().unwrap();
        // автор изменил метаданные, а главу заменил папкой (запись в неё не удастся)
        fs::write(dir.join("project.json"), "{\"changed\":true}").unwrap();
        fs::remove_file(dir.join("Главы/a.md")).unwrap();
        fs::create_dir_all(dir.join("Главы/a.md")).unwrap();
        let res = restore_backup(&dir, &root, &name);
        assert!(res.is_err(), "сбой записи должен возвращать ошибку");
        assert_eq!(fs::read_to_string(dir.join("project.json")).unwrap(), "{\"changed\":true}", "записанный файл откачен к прежнему");
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
