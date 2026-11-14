//! Двусторонняя синхронизация проекта с внешней папкой. Порт src/folder.js.
//! Правило: ничего не затираем молча. Для каждого файла хранится хэш последней согласованной
//! версии; при правках с обеих сторон чужая версия уходит в «Конфликты».
use crate::remote::Remote;
use crate::store::{write_atomic_bytes, R};
use crate::syncguard::{conflict_names, extname, now_local, save_conflict_copy, stem, CONFLICT_DIR};
use regex::Regex;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

pub const FOLDERS: [&str; 9] = ["Главы", "Персонажи", "Места", "Предметы", "Заметки", "Изображения", "Картинки", "Корзина", CONFLICT_DIR];
const MASS_DELETE_MIN: usize = 5;

fn root_re() -> &'static Regex {
    static RE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| Regex::new(r"^project.*\.json$|^stats\.json$").unwrap());
    &RE
}

/// Имя файла, безопасное на всех платформах. Облако (или чужая папка) может прислать имя с обратным слешем,
/// двоеточием, именем устройства Windows и т. п.: на Windows такое имя выходит за папку проекта или пишет в
/// поток/устройство. Такие файлы не синхронизируем.
pub fn is_safe_file_name(name: &str) -> bool {
    if name.is_empty() || name.ends_with('.') || name.ends_with(' ') { return false; }
    if name.chars().any(|c| c.is_control() || "\\/:*?\"<>|".contains(c)) { return false; }
    let stem = name.split('.').next().unwrap_or("").trim_end().to_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit() && stem.as_bytes()[3] != b'0');
    !reserved
}

pub fn is_syncable(rel: &str) -> bool {
    let parts: Vec<&str> = rel.split('/').filter(|x| !x.is_empty()).collect();
    let Some(name) = parts.last() else { return false };
    if name.starts_with('.') || name.ends_with(".tmp") || !is_safe_file_name(name) { return false; }
    if parts.len() == 1 { return root_re().is_match(name); }
    parts.len() == 2 && FOLDERS.contains(&parts[0])
}

pub fn hash_bytes(b: &[u8]) -> String {
    let mut h = Sha1::new();
    h.update(b);
    h.finalize().iter().map(|x| format!("{:02x}", x)).collect()
}

/// Снимок локального проекта: относительный путь → хэш.
/// Снимок локальной папки: путь → хеш. Ошибку чтения НЕ принимаем за «файла нет»: иначе нечитаемый файл
/// (нет прав, блокировка, ещё не скачан из iCloud) выглядел бы удалённым, и удаление ушло бы в облако.
/// Не ошибка: папки нет совсем (NotFound) или файл исчез между чтением каталога и файла.
pub fn walk_local(dir: &Path) -> R<BTreeMap<String, String>> {
    fn io_err(what: &str, e: &std::io::Error) -> String {
        format!("Не удалось прочитать «{}»: {}. Синхронизация остановлена, чтобы не принять файл за удалённый.", what, e)
    }
    // Некоторые записи каталога можно пропустить, только если они действительно пропали.
    fn list(path: &Path, what: &str, must_exist: bool) -> R<Vec<(String, bool)>> {
        let rd = match fs::read_dir(path) {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && !must_exist => return Ok(Vec::new()),
            Err(e) => return Err(io_err(what, &e)),
        };
        let mut out = Vec::new();
        for entry in rd {
            let entry = entry.map_err(|e| io_err(what, &e))?;
            let name = entry.file_name().to_string_lossy().to_string();
            match fs::symlink_metadata(entry.path()) {
                Ok(m) if m.file_type().is_symlink() => {} // не следуем по ссылке (symlink/junction)
                Ok(m) => out.push((name, m.is_file())),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {} // исчез по дороге
                Err(e) => return Err(io_err(&format!("{}/{}", what, name), &e)),
            }
        }
        Ok(out)
    }
    let mut out = BTreeMap::new();
    let mut add = |rel: String| -> R<()> {
        match fs::read(dir.join(&rel)) {
            Ok(b) => { out.insert(rel, hash_bytes(&b)); Ok(()) }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io_err(&rel, &e)),
        }
    };
    for (name, is_file) in list(dir, "папку проекта", true)? {
        if is_file && is_syncable(&name) { add(name)?; }
    }
    for folder in FOLDERS {
        // Папку-ссылку (symlink/junction) не обходим: иначе прочитаем файлы вне корня проекта.
        if let Ok(m) = fs::symlink_metadata(dir.join(folder)) { if m.file_type().is_symlink() { continue; } }
        for (name, is_file) in list(&dir.join(folder), folder, false)? {
            let rel = format!("{}/{}", folder, name);
            if is_file && is_syncable(&rel) { add(rel)?; }
        }
    }
    Ok(out)
}

pub struct RemoteEntry {
    pub hash: String,
    pub bytes: Option<Vec<u8>>,
    pub sig: Option<String>,
}

type Cache = HashMap<String, (String, String)>; // rel → (sig, hash)

fn walk_remote(remote: &mut dyn Remote, cache: Option<&Cache>) -> R<BTreeMap<String, RemoteEntry>> {
    let mut files: Vec<(String, Option<String>)> = Vec::new();
    let mut stack = vec![String::new()];
    // Сначала списки целиком: ошибка списка не запускает чтение неполного снимка.
    while let Some(rel) = stack.pop() {
        for it in remote.list(&rel)? {
            let r = if rel.is_empty() { it.name.clone() } else { format!("{}/{}", rel, it.name) };
            if it.dir { stack.push(r); continue; }
            if !is_syncable(&r) { continue; }
            let sig = if it.mtime > 0 && it.size >= 0 { Some(format!("{}:{}", it.size, it.mtime)) } else { None };
            files.push((r, sig));
        }
    }
    let mut out = BTreeMap::new();
    for (rel, sig) in files {
        let hit = match (&sig, cache) { (Some(s), Some(c)) => c.get(&rel).filter(|x| &x.0 == s), _ => None };
        if let Some(h) = hit {
            out.insert(rel, RemoteEntry { hash: h.1.clone(), bytes: None, sig });
        } else if let Some(bytes) = remote.read(&rel)? {
            out.insert(rel, RemoteEntry { hash: hash_bytes(&bytes), bytes: Some(bytes), sig });
        }
    }
    Ok(out)
}

#[derive(Default, Debug, Clone)]
pub struct SyncResult {
    pub pulled: Vec<String>,
    pub pushed: Vec<String>,
    pub removed: Vec<String>,
    pub conflicts: Vec<String>,
}

// ---------- слова словаря (src/dict.js) ----------

use crate::dict::clean_words;

/// Слова, добавленные на другом устройстве, не теряем. Новый текст нашего project.json или None.
pub fn merge_meta_words(local: &[u8], remote: &[u8]) -> Option<Vec<u8>> {
    let l: Value = serde_json::from_slice(local).ok()?;
    let r: Value = serde_json::from_slice(remote).ok()?;
    let lw = l.get("words")?.as_array()?;
    let rw = r.get("words")?.as_array()?;
    let mut all = lw.clone();
    all.extend(rw.iter().cloned());
    let words = clean_words(&all);
    let local_clean = clean_words(lw);
    let local_strs: Vec<&str> = lw.iter().filter_map(|x| x.as_str()).collect();
    if words.len() == local_clean.len() && words.iter().all(|w| local_strs.contains(&w.as_str())) { return None; }
    let mut obj = l.as_object()?.clone();
    obj.insert("words".into(), json!(words));
    Some(serde_json::to_string_pretty(&Value::Object(obj)).ok()?.into_bytes())
}

// ---------- движок ----------

/// Тестовая точка конфликтной ветки sync: после чтения локального project.json, до записи результата слияния.
/// Живёт только в unit-тестах (`cfg(test)`): в обычной сборке и в интеграционных тестах её нет.
#[cfg(test)]
pub(crate) mod sync_hook {
    use std::cell::RefCell;
    type Hook = Box<dyn FnOnce()>;
    thread_local! {
        static HOOK: RefCell<Option<Hook>> = RefCell::new(None);
        static REMOTE_HOOK: RefCell<Option<Hook>> = RefCell::new(None);
        static REMOTE_AFTER_HOOK: RefCell<Option<Hook>> = RefCell::new(None);
    }
    /// Вторая точка: в write_checked перед проверкой версии в облаке (имитирует запись с другого устройства).
    pub fn set_remote<F: FnOnce() + 'static>(f: F) { REMOTE_HOOK.with(|h| *h.borrow_mut() = Some(Box::new(f))); }
    pub fn fire_remote() {
        let hook = REMOTE_HOOK.with(|h| h.borrow_mut().take());
        if let Some(hook) = hook { hook(); }
    }
    /// Третья точка: в write_checked после проверки версии, перед самой записью (гонка создания).
    pub fn set_remote_after<F: FnOnce() + 'static>(f: F) { REMOTE_AFTER_HOOK.with(|h| *h.borrow_mut() = Some(Box::new(f))); }
    pub fn fire_remote_after() {
        let hook = REMOTE_AFTER_HOOK.with(|h| h.borrow_mut().take());
        if let Some(hook) = hook { hook(); }
    }
    pub fn set<F: FnOnce() + 'static>(f: F) { HOOK.with(|h| *h.borrow_mut() = Some(Box::new(f))); }
    pub fn fire() {
        let hook = HOOK.with(|h| h.borrow_mut().take());
        if let Some(hook) = hook { hook(); }
    }
}

pub struct FolderSync<T: Remote> {
    pub dir: PathBuf,
    pub remote: T,
    state_file: Option<PathBuf>,
    state: BTreeMap<String, String>,
    cache: Cache,
}

fn text(b: &[u8]) -> String { String::from_utf8_lossy(b).to_string() }
fn is_meta(v: &Value) -> bool { v.as_object().map(|o| o.get("chapters").map(|c| c.is_array()).unwrap_or(false)).unwrap_or(false) }
fn arr<'a>(v: &'a Value, k: &str) -> &'a [Value] { v.get(k).and_then(|x| x.as_array()).map(|x| x.as_slice()).unwrap_or(&[]) }
fn label_of(rel: &str) -> String { if rel.contains('/') { stem(rel) } else { rel.to_string() } }

impl<T: Remote> FolderSync<T> {
    pub fn new(dir: &Path, remote: T, state_file: Option<PathBuf>) -> R<Self> {
        let mut s = FolderSync { dir: dir.to_path_buf(), remote, state_file, state: BTreeMap::new(), cache: HashMap::new() };
        s.load()?;
        Ok(s)
    }

    fn cache_file(&self) -> Option<PathBuf> { self.state_file.as_ref().map(|p| PathBuf::from(format!("{}.cache", p.display()))) }

    /// Загрузка состояния: отсутствие файла — это первая синхронизация (безопасно); порча или ошибка
    /// чтения — Err, чтобы не принять повреждённое состояние за «первый запуск» и не затереть данные.
    fn load(&mut self) -> R<()> {
        if let Some(f) = &self.state_file {
            match fs::read_to_string(f) {
                Ok(raw) => {
                    let v: Value = serde_json::from_str(&raw).map_err(|e| format!(
                        "Файл состояния синхронизации повреждён: {}. Синхронизация остановлена, чтобы не затереть данные; проверьте папку проекта.", e))?;
                    if let Value::Object(o) = v {
                        for (k, v) in o { if let Some(s) = v.as_str() { self.state.insert(k, s.to_string()); } }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {} // состояния ещё нет: первая синхронизация
                Err(e) => return Err(format!("Не удалось прочитать состояние синхронизации: {}. Синхронизация остановлена, чтобы не затереть данные.", e)),
            }
        }
        // Кэш — производная величина: порча или ошибка чтения не опасны, просто перечитаем файлы.
        let Some(cf) = self.cache_file() else { return Ok(()) };
        let Ok(raw) = fs::read_to_string(cf) else { return Ok(()) };
        let Ok(v) = serde_json::from_str::<Value>(&raw) else { return Ok(()) };
        if v.get("version").and_then(|x| x.as_i64()) != Some(1) { return Ok(()) }
        let Some(files) = v.get("files").and_then(|x| x.as_object()) else { return Ok(()) };
        let sig_re = Regex::new(r"^\d+:\d+$").unwrap();
        let hash_re = Regex::new(r"^[a-f0-9]{40}$").unwrap();
        for (rel, e) in files {
            let (Some(sig), Some(hash)) = (e.get("sig").and_then(|x| x.as_str()), e.get("hash").and_then(|x| x.as_str())) else { continue };
            if !is_syncable(rel) || !sig_re.is_match(sig) || !hash_re.is_match(hash) || self.state.get(rel).map(|s| s.as_str()) != Some(hash) { continue; }
            self.cache.insert(rel.clone(), (sig.to_string(), hash.to_string()));
        }
        Ok(())
    }

    /// Сохранение состояния: ошибка записи возвращается. Кэш — производная величина, его ошибка
    /// не отменяет уже выполненную синхронизацию.
    fn save(&self) -> R<()> {
        let Some(f) = &self.state_file else { return Ok(()) };
        if let Some(p) = f.parent() { fs::create_dir_all(p).map_err(|e| format!("Не удалось создать папку состояния синхронизации: {}.", e))?; }
        let st: serde_json::Map<String, Value> = self.state.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
        write_atomic_bytes(f, serde_json::to_string_pretty(&Value::Object(st)).unwrap().as_bytes())
            .map_err(|e| format!("Не удалось сохранить состояние синхронизации: {}. Повторите синхронизацию.", e))?;
        if let Some(cf) = self.cache_file() {
            let files: serde_json::Map<String, Value> = self.cache.iter()
                .filter(|(rel, e)| self.state.get(*rel) == Some(&e.1))
                .map(|(rel, e)| (rel.clone(), json!({ "sig": e.0, "hash": e.1 }))).collect();
            let _ = write_atomic_bytes(&cf, serde_json::to_string_pretty(&json!({ "version": 1, "files": files })).unwrap().as_bytes());
        }
        Ok(())
    }

    pub fn state(&self) -> BTreeMap<String, String> { self.state.clone() }

    fn read_local(&self, rel: &str) -> R<Vec<u8>> { fs::read(self.dir.join(rel)).map_err(|e| format!("{}: {}", rel, e)) }

    /// Отличие отсутствия от ошибки чтения: `Ok(None)` — файла нет (NotFound), `Err` — ошибка доступа/ввода.
    /// Ошибку нельзя превращать в «пустоту»: нечитаемая глава не должна выпадать из слияния или удаляться.
    fn read_local_opt(&self, rel: &str) -> R<Option<Vec<u8>>> {
        match fs::read(self.dir.join(rel)) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("{}: {}", rel, e)),
        }
    }

    /// Хэш локального файла на диске; None, если файла уже нет. Позволяет заметить сохранение,
    /// случившееся после walk_local, но до обработки файла в проходе.
    fn local_hash(&self, rel: &str) -> R<Option<String>> {
        match fs::read(self.dir.join(rel)) {
            Ok(b) => Ok(Some(hash_bytes(&b))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("{}: {}", rel, e)),
        }
    }

    fn write_local(&self, rel: &str, bytes: &[u8]) -> R<()> {
        let target = self.dir.join(rel);
        if let Some(p) = target.parent() { fs::create_dir_all(p).map_err(|e| e.to_string())?; }
        write_atomic_bytes(&target, bytes)
    }

    fn remote_bytes(&mut self, entry: &mut RemoteEntry, rel: &str) -> R<Vec<u8>> {
        if let Some(b) = &entry.bytes { return Ok(b.clone()); }
        let b = self.remote.read(rel)?.ok_or("Файл в папке недоступен. Синхронизация остановлена, ничего не удалено.")?;
        entry.bytes = Some(b.clone());
        Ok(b)
    }

    /// Чужую (или вытесненную) версию кладём в «Конфликты» и у нас, и в папке.
    /// Ошибка чтения имени-кандидата и ошибка облачного сохранения копии НЕ подавляются: иначе вызывающая
    /// операция (перезапись/удаление вытесняемой версии) продолжилась бы, хотя копия не подтверждена.
    fn keep(&mut self, rel: &str, bytes: &[u8], label: &str, suffix: &str) -> R<String> {
        // Имя должно подойти и у нас, и в папке: другая версия под тем же именем (та же секунда) не затирается,
        // тогда берётся имя с SHA-256. Проверка папки идёт без замка: сеть под замком не держим.
        let mut candidates: Vec<String> = Vec::new();
        for name in conflict_names(&now_local(), label, suffix, &extname(rel), bytes) {
            let rel_conflict = format!("{}/{}", CONFLICT_DIR, name);
            match self.remote.read(&rel_conflict) {
                Ok(None) => candidates.push(name),
                // содержимое уже подтверждено чтением — ту же версию можно переиспользовать
                Ok(Some(b)) if b.as_slice() == bytes => candidates.push(name),
                // известная ДРУГАЯ версия под этим именем: имя не занимаем
                Ok(Some(_)) => {}
                Err(e) => {
                    return Err(format!(
                        "Не удалось прочитать конфликтную копию «{}»: {}. Вытесненная версия не сохранена — операция остановлена.",
                        rel_conflict, e
                    ))
                }
            }
        }
        if candidates.is_empty() {
            return Err("Не удалось подобрать имя для конфликтной копии: все имена заняты другими версиями. Операция остановлена.".into());
        }
        let name = save_conflict_copy(&self.dir.join(CONFLICT_DIR), &candidates, bytes)?;
        let rel_conflict = format!("{}/{}", CONFLICT_DIR, name);
        match self.remote.mkdir(CONFLICT_DIR).and_then(|_| self.remote.write(&rel_conflict, bytes)) {
            Ok(()) => {
                self.state.insert(rel_conflict, hash_bytes(bytes));
                Ok(name)
            }
            Err(e) => Err(format!(
                "Не удалось сохранить конфликтную копию «{}» в папке: {}. Локальная копия сохранена, вытесняемая версия не изменялась. Операция остановлена.",
                rel_conflict, e
            )),
        }
    }
    /// Запись в облако с проверкой версии: перед записью файл читается заново, и если он не такой, каким мы его видели
    /// (`expect` — хэш, None — «файла не было»), чужая версия сначала сохраняется в «Конфликтах». Список в начале прохода
    /// может быть старше записи на минуты, а кэш по размеру и дате не видит правку с тем же размером и временем.
    /// Ошибка чтения отменяет запись: лучше повторить проход, чем затереть чужую версию вслепую.
    fn write_checked(&mut self, rel: &str, data: &[u8], expect: Option<&str>, res: &mut SyncResult) -> R<()> {
        #[cfg(test)]
        sync_hook::fire_remote();
        if let Some((parent, _)) = rel.rsplit_once('/') { self.remote.mkdir(parent)?; }
        let fresh = self.remote.read(rel)?;
        if let Some(b) = &fresh {
            let h = hash_bytes(b);
            if Some(h.as_str()) != expect && h != hash_bytes(data) {
                self.keep_foreign(rel, b, &label_of(rel))?;
                if !res.conflicts.contains(&rel.to_string()) { res.conflicts.push(rel.to_string()); }
            }
        }
        #[cfg(test)]
        sync_hook::fire_remote_after();
        if expect.is_none() {
            // Файла, по нашим сведениям, ещё нет: пишем без перезаписи. Если другое устройство успело
            // создать его между проверкой и записью, create это обнаружит и чужое не будет затёрто молча.
            match self.remote.create(rel, data) {
                Ok(()) => return Ok(()),
                Err(_) => {
                    if fresh.is_none() {
                        if let Some(b) = self.remote.read(rel)? {
                            if hash_bytes(&b) != hash_bytes(data) {
                                self.keep_foreign(rel, &b, &label_of(rel))?;
                                if !res.conflicts.contains(&rel.to_string()) { res.conflicts.push(rel.to_string()); }
                            }
                        }
                    }
                }
            }
        }
        self.remote.write(rel, data)
    }

    fn remove_local(&self, rel: &str) -> R<()> {
        match fs::remove_file(self.dir.join(rel)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("Не удалось удалить локальный файл «{}»: {}. Синхронизация остановлена, состояние не изменено.", rel, e)),
        }
    }

    fn keep_foreign(&mut self, rel: &str, bytes: &[u8], label: &str) -> R<String> { self.keep(rel, bytes, label, "с другого устройства") }

    fn adopt_remote_structure(&mut self, remote: &mut BTreeMap<String, RemoteEntry>, local: &mut BTreeMap<String, String>) -> R<()> {
        let mut entry = remote.remove("project.json").unwrap();
        let entry_hash = entry.hash.clone();
        let remote_raw = self.remote_bytes(&mut entry, "project.json");
        remote.insert("project.json".into(), entry);
        let Ok(remote_raw) = remote_raw else { return Ok(()) };
        let (Ok(remote_meta), Ok(local_raw)) = (serde_json::from_slice::<Value>(&remote_raw), self.read_local("project.json")) else { return Ok(()) };
        let Ok(local_meta) = serde_json::from_slice::<Value>(&local_raw) else { return Ok(()) };
        if !is_meta(&remote_meta) || !is_meta(&local_meta) { return Ok(()); }

        let id_re = Regex::new(r"^[a-z0-9]{6,32}$").unwrap();
        let lists = [("chapters", "Главы", "md"), ("characters", "Персонажи", "json"), ("places", "Места", "json"), ("items", "Предметы", "json"), ("notes", "Заметки", "md")];
        let mut merged = remote_meta.as_object().unwrap().clone();
        let mut added: Vec<String> = vec![];
        let mut dropped: Vec<String> = vec![];
        for (list, folder, ext) in lists {
            let base = arr(&remote_meta, list).to_vec();
            let have: BTreeSet<String> = base.iter().filter_map(|e| e.get("id").and_then(|x| x.as_str()).map(String::from)).collect();
            let mut extra = vec![];
            for e in arr(&local_meta, list) {
                let Some(id) = e.get("id").and_then(|x| x.as_str()) else { continue };
                if !id_re.is_match(id) || have.contains(id) { continue; }
                let rel = format!("{}/{}.{}", folder, id, ext);
                if list == "chapters" {
                    // Пустота — только по успешно прочитанному файлу. Ошибку чтения нельзя принимать
                    // за пустоту: иначе нечитаемая глава выпадет из слияния и её текст останется без ссылки.
                    let empty = match self.read_local_opt(&rel) {
                        Ok(Some(b)) => text(&b).trim().is_empty(),
                        Ok(None) => false, // файла нет — отдельный безопасный случай, ссылку сохраняем
                        Err(e) => return Err(format!(
                            "Не удалось прочитать главу «{}» при слиянии структуры: {}. Слияние остановлено, чтобы не потерять текст.",
                            rel, e
                        )),
                    };
                    if empty { dropped.push(rel); continue; }
                }
                extra.push(e.clone());
                added.push(rel);
            }
            if !extra.is_empty() { let mut all = base; all.extend(extra); merged.insert(list.into(), Value::Array(all)); }
        }
        let base_trash = arr(&remote_meta, "trash").to_vec();
        let trash_ids: BTreeSet<String> = base_trash.iter().filter_map(|e| e.get("tid").and_then(|x| x.as_str()).map(String::from)).collect();
        let trash_extra: Vec<Value> = arr(&local_meta, "trash").iter()
            .filter(|e| e.get("tid").and_then(|x| x.as_str()).map(|t| !trash_ids.contains(t)).unwrap_or(false)).cloned().collect();
        if !trash_extra.is_empty() { let mut all = base_trash; all.extend(trash_extra.iter().cloned()); merged.insert("trash".into(), Value::Array(all)); }

        let meta_differs = remote_meta != local_meta;
        let has_local_content = !added.is_empty() || !trash_extra.is_empty()
            || local_meta.get("words").is_some()
            || arr(&local_meta, "chapters").iter().any(|c| c.get("id").and_then(|x| x.as_str())
                .map(|id| match self.read_local_opt(&format!("Главы/{}.md", id)) {
                    Ok(Some(b)) => !text(&b).trim().is_empty(),
                    Ok(None) => false,
                    // Ошибка чтения: считаем, что содержимое может быть, и сохраняем копию project.json.
                    Err(_) => true,
                }).unwrap_or(false))
            || ["characters", "places", "items", "notes"].iter().any(|k| !arr(&local_meta, k).is_empty())
            || local_meta.get("name").and_then(|x| x.as_str()).map(|n| !n.is_empty() && n != "1" && n != "Проект" && Some(n) != remote_meta.get("name").and_then(|x| x.as_str())).unwrap_or(false);
        if meta_differs && has_local_content {
            self.keep("project.json", &local_raw, "project", "было на этом устройстве")?;
            if local.contains_key("stats.json") && remote.get("stats.json").map(|e| Some(&e.hash) != local.get("stats.json")).unwrap_or(false) {
                let raw = self.read_local("stats.json")?;
                self.keep("stats.json", &raw, "stats", "было на этом устройстве")?;
            }
        }
        for rel in &dropped {
            // Глава была пустой при чтении, но за время прохода (сеть выше) в неё могли напечатать текст.
            let _guard = crate::store::sync_save_lock().lock().map_err(|_| "Внутренний замок сохранения недоступен.".to_string())?;
            let still_empty = match self.read_local_opt(rel) {
                Ok(Some(b)) => text(&b).trim().is_empty(),
                Ok(None) => true, // файла уже нет: удалять нечего, это не ошибка данных
                Err(e) => return Err(format!(
                    "Не удалось прочитать главу «{}» перед удалением: {}. Удаление остановлено, чтобы не потерять текст.",
                    rel, e
                )),
            };
            if still_empty {
                match fs::remove_file(self.dir.join(rel)) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(format!("Не удалось удалить пустую главу «{}»: {}. Удаление остановлено.", rel, e)),
                }
                local.remove(rel);
            }
        }
        let out = if !added.is_empty() || !trash_extra.is_empty() { serde_json::to_string_pretty(&Value::Object(merged)).unwrap().into_bytes() } else { remote_raw };
        // Локальную мету могли сохранить за время прохода (сеть выше). Пишем результат, только если файл не менялся
        // с момента чтения; иначе эту версию тоже кладём в «Конфликты» (сеть — вне замка) и проверяем снова.
        let mut seen = local_raw.clone();
        let mut attempts = 0;
        loop {
            {
                let _guard = crate::store::sync_save_lock().lock().map_err(|_| "Внутренний замок сохранения недоступен.".to_string())?;
                let fresh = self.read_local("project.json")?;
                if fresh == seen {
                    self.write_local("project.json", &out)?;
                    break;
                }
                seen = fresh;
            }
            attempts += 1;
            if attempts >= 3 {
                return Err("Проект менялся во время первой синхронизации. Ничего не удалено, повторим при следующем проходе.".into());
            }
            self.keep("project.json", &seen, "project", "было на этом устройстве")?;
        }
        local.insert("project.json".into(), hash_bytes(&out));
        self.state.insert("project.json".into(), entry_hash);

        if local.contains_key("stats.json") && remote.get("stats.json").map(|e| Some(&e.hash) != local.get("stats.json")).unwrap_or(false) {
            let mut e = remote.remove("stats.json").unwrap();
            let raw = self.remote_bytes(&mut e, "stats.json");
            let h = e.hash.clone();
            remote.insert("stats.json".into(), e);
            {
                // Сериализуем со статистикой окна (set_day_words): их read–modify–write не должен пересекаться.
                let _guard = crate::store::sync_save_lock().lock().map_err(|_| "Внутренний замок сохранения недоступен.".to_string())?;
                self.write_local("stats.json", &raw?)?;
            }
            local.insert("stats.json".into(), h.clone());
            self.state.insert("stats.json".into(), h);
        }
        Ok(())
    }

    /// Один проход: что снаружи — к нам, что у нас — наружу.
    pub fn sync(&mut self) -> R<SyncResult> {
        let cache = std::mem::take(&mut self.cache);
        let walked = walk_remote(&mut self.remote, Some(&cache));
        self.cache = cache;
        let mut remote = walked?;
        let mut local = walk_local(&self.dir)?;
        let mut res = SyncResult::default();
        let rr = root_re();

        let had_root = self.state.keys().any(|k| rr.is_match(k));
        let has_root = remote.keys().any(|k| rr.is_match(k));
        if had_root && !has_root {
            return Err("В папке не видно файлов проекта (облако не отвечает или папка пуста). Синхронизация остановлена, ничего не удалено.".into());
        }
        if !self.state.contains_key("project.json") && remote.contains_key("project.json") && local.contains_key("project.json")
            && Some(&remote["project.json"].hash) != local.get("project.json") {
            self.adopt_remote_structure(&mut remote, &mut local)?;
        }

        let rels: BTreeSet<String> = remote.keys().chain(local.keys()).chain(self.state.keys()).filter(|r| is_syncable(r)).cloned().collect();
        let vanished = rels.iter().filter(|r| self.state.contains_key(*r) && !remote.contains_key(*r) && local.get(*r) == self.state.get(*r)).count();
        let tracked = self.state.keys().filter(|r| is_syncable(r)).count();
        if vanished >= MASS_DELETE_MIN && vanished * 2 >= tracked {
            return Err("Снаружи пропала большая часть файлов проекта. Похоже на неполный ответ облака, поэтому синхронизация остановлена и у вас ничего не удалено.".into());
        }

        for rel in &rels {
            // Решение по файлу принимаем заново, если перечитывание локального файла показало, что снимок l
            // устарел (сохранение во время прохода). Обычная ветка выходит через break.
            loop {
                let r = remote.get(rel).map(|e| e.hash.clone());
                let l = local.get(rel).cloned();
                let b = self.state.get(rel).cloned();
                if r.is_none() && l.is_none() { self.state.remove(rel); break; }
                if r.is_some() && r == l { self.state.insert(rel.clone(), r.unwrap()); break; }

                if let (Some(rh), Some(lh)) = (&r, &l) {
                    if b.as_ref() == Some(rh) {
                        let data = self.read_local(rel)?;
                        self.write_checked(rel, &data, Some(rh), &mut res)?;
                        self.state.insert(rel.clone(), lh.clone());
                        res.pushed.push(rel.clone());
                        break;
                    }
                    if b.as_ref() == Some(lh) {
                        // Облако обновило файл, а снимок говорит, что мы его не меняли. Перед тем как затереть свой файл,
                        // перечитаем его: сохранение во время этого прохода уже изменило файл. Замок не даёт штатному
                        // сохранению вклиниться между проверкой и записью; сетевых вызовов под замком нет.
                        let mut e = remote.remove(rel).unwrap();
                        let bytes = self.remote_bytes(&mut e, rel);
                        remote.insert(rel.clone(), e);
                        let bytes = bytes?;
                        let _guard = crate::store::sync_save_lock().lock().map_err(|_| "Внутренний замок сохранения недоступен.".to_string())?;
                        if let Some(fresh) = self.local_hash(rel)? {
                            if &fresh != lh {
                                local.insert(rel.clone(), fresh);
                                continue;
                            }
                        }
                        self.write_local(rel, &bytes)?;
                        self.state.insert(rel.clone(), rh.clone());
                        res.pulled.push(rel.clone());
                        break;
                    }
                    let mut e = remote.remove(rel).unwrap();
                    let foreign = self.remote_bytes(&mut e, rel);
                    remote.insert(rel.clone(), e);
                    let foreign = foreign?;
                    self.keep_foreign(rel, &foreign, &label_of(rel))?;
                    // Чтение, слияние и запись под общим замком: сохранение не вклинится между чтением и записью
                    // и не будет затёрто результатом, посчитанным по старой версии. Сети под замком нет.
                    let with_words = {
                        let _guard = crate::store::sync_save_lock().lock().map_err(|_| "Внутренний замок сохранения недоступен.".to_string())?;
                        let mine = self.read_local(rel)?;
                        #[cfg(test)]
                        if rel == "project.json" { sync_hook::fire(); } // ТЕСТОВАЯ ТОЧКА: после чтения, до записи результата
                        let merged = if rel == "project.json" { merge_meta_words(&mine, &foreign) } else { None };
                        if let Some(w) = &merged { self.write_local(rel, w)?; }
                        merged
                    };
                    let now_local = self.read_local(rel)?;
                    let foreign_hash = hash_bytes(&foreign);
                    self.write_checked(rel, &now_local, Some(&foreign_hash), &mut res)?;
                    self.state.insert(rel.clone(), match &with_words { Some(w) => hash_bytes(w), None => lh.clone() });
                    res.pushed.push(rel.clone());
                    res.conflicts.push(rel.clone());
                    break;
                }

                if let Some(rh) = &r { // снаружи есть, у нас нет
                    let mut e = remote.remove(rel).unwrap();
                    let bytes = self.remote_bytes(&mut e, rel);
                    remote.insert(rel.clone(), e);
                    if b.is_none() {
                        self.write_local(rel, &bytes?)?;
                        self.state.insert(rel.clone(), rh.clone());
                        res.pulled.push(rel.clone());
                    } else {
                        if b.as_ref() != Some(rh) { let bytes = bytes?; self.keep_foreign(rel, &bytes, &label_of(rel))?; }
                        self.remove_local(rel)?;
                        self.state.remove(rel);
                        res.pulled.push(rel.clone());
                    }
                    break;
                }

                // у нас есть, снаружи нет
                let lh = l.unwrap();
                if b.is_none() {
                    let data = self.read_local(rel)?;
                    self.write_checked(rel, &data, None, &mut res)?;
                    self.state.insert(rel.clone(), lh);
                    res.pushed.push(rel.clone());
                } else if Some(&lh) == b.as_ref() {
                    // Перед удалением перечитаем локальный файл: сохранение во время прохода могло изменить его.
                    {
                        let _guard = crate::store::sync_save_lock().lock().map_err(|_| "Внутренний замок сохранения недоступен.".to_string())?;
                        if let Some(fresh) = self.local_hash(rel)? {
                            if fresh != lh {
                                local.insert(rel.clone(), fresh);
                                continue;
                            }
                        }
                    }
                    // Прямое чтение подтверждает исчезновение: неполный список облака не должен приводить к удалению.
                    if self.remote.read(rel)?.is_some() { break; }
                    self.remove_local(rel)?;
                    self.state.remove(rel);
                    res.pulled.push(rel.clone());
                } else {
                    res.conflicts.push(rel.clone());
                }
                break;
            }
        }

        self.cache.clear();
        for (rel, e) in &remote {
            if let Some(sig) = &e.sig {
                if !res.pushed.contains(rel) && !res.conflicts.contains(rel) { self.cache.insert(rel.clone(), (sig.clone(), e.hash.clone())); }
            }
        }
        self.save()?;
        Ok(res)
    }

    /// Быстрая выгрузка только указанных файлов.
    pub fn push(&mut self, rels: &[String]) -> R<SyncResult> {
        let mut res = SyncResult::default();
        let uniq: BTreeSet<&String> = rels.iter().collect();
        for rel in uniq {
            if !is_syncable(rel) { continue; }
            self.cache.remove(rel);
            if !self.dir.join(rel).exists() {
                if !self.state.contains_key(rel) { continue; }
                self.after_local_delete(rel, &mut res)?;
                continue;
            }
            let data = self.read_local(rel)?;
            let l = hash_bytes(&data);
            if self.state.get(rel) == Some(&l) { continue; }
            let bytes = match self.remote.read(rel) { Ok(b) => b, Err(_) => continue };
            let r = bytes.as_ref().map(|b| hash_bytes(b));
            if r.as_ref() == Some(&l) { self.state.insert(rel.clone(), l); continue; }
            // Та же проверка версии и безопасная запись, что и в основном проходе: чужое не затирается
            // молча, а новый файл создаётся без перезаписи (create-only).
            self.write_checked(rel, &data, self.state.get(rel).cloned().as_deref(), &mut res)?;
            self.state.insert(rel.clone(), l);
            res.pushed.push(rel.clone());
        }
        self.save()?;
        Ok(res)
    }

    fn after_local_delete(&mut self, rel: &str, res: &mut SyncResult) -> R<()> {
        // Ошибку чтения нельзя принять за «чужой версии нет»: иначе чужой текст удалится без копии.
        let bytes = self.remote.read(rel)?;
        if let Some(b) = bytes {
            if Some(&hash_bytes(&b)) != self.state.get(rel) { self.keep_foreign(rel, &b, &label_of(rel))?; res.conflicts.push(rel.to_string()); }
        }
        // Ошибку удаления не выдаём за успешно выполненное удаление: состояние не меняем, повторим при следующем проходе.
        self.remote.remove(rel)?;
        self.state.remove(rel);
        res.removed.push(rel.to_string());
        Ok(())
    }

    /// Выгрузить локальный проект поверх папки; чего у нас нет, уходит в «Конфликты» папки.
    pub fn replace_all(&mut self) -> R<usize> {
        let remote = walk_remote(&mut self.remote, None)?;
        let local = walk_local(&self.dir)?;
        let mut hidden = 0;
        for (rel, e) in &remote {
            if local.contains_key(rel) || rel.starts_with(&format!("{}/", CONFLICT_DIR)) { continue; }
            let bytes = e.bytes.as_deref().unwrap_or(&[]);
            // Другая версия под тем же именем (та же секунда) не затирается: берём имя с SHA-256, иначе останавливаемся.
            let name = conflict_names(&now_local(), &label_of(rel), "было в папке", &extname(rel), bytes).into_iter()
                .find(|n| !matches!(self.remote.read(&format!("{}/{}", CONFLICT_DIR, n)), Ok(Some(b)) if b.as_slice() != bytes))
                .ok_or_else(|| "Копия в «Конфликты» уже существует и была изменена. Замена остановлена, чтобы не затереть её.".to_string())?;
            self.remote.mkdir(CONFLICT_DIR)?;
            self.remote.write(&format!("{}/{}", CONFLICT_DIR, name), bytes)?;
            self.remote.remove(rel)?;
            hidden += 1;
        }
        self.export_all()?;
        Ok(hidden)
    }

    pub fn has_project(&mut self) -> R<bool> {
        if self.remote.read("project.json")?.is_some() { return Ok(true); }
        let re = Regex::new(r"^project.*\.json$").unwrap();
        Ok(self.remote.list("")?.iter().any(|it| re.is_match(&it.name)))
    }

    /// Скопировать папку в локальный каталог (первое открытие проекта из папки).
    pub fn import_all(&mut self) -> R<Vec<String>> {
        let remote = walk_remote(&mut self.remote, None)?;
        self.state.clear();
        self.cache.clear();
        for (rel, e) in &remote {
            self.write_local(rel, e.bytes.as_deref().unwrap_or(&[]))?;
            self.state.insert(rel.clone(), e.hash.clone());
            if let Some(sig) = &e.sig { self.cache.insert(rel.clone(), (sig.clone(), e.hash.clone())); }
        }
        self.save()?;
        Ok(remote.keys().cloned().collect())
    }

    /// Выгрузить локальный проект в пустую папку.
    pub fn export_all(&mut self) -> R<Vec<String>> {
        let local = walk_local(&self.dir)?;
        self.state.clear();
        self.cache.clear();
        for (rel, hash) in &local {
            self.remote.mkdir(rel.rsplit_once('/').map(|x| x.0).unwrap_or(""))?;
            let data = self.read_local(rel)?;
            self.remote.write(rel, &data)?;
            self.state.insert(rel.clone(), hash.clone());
        }
        self.save()?;
        Ok(local.keys().cloned().collect())
    }

    pub fn reset(&mut self) -> R<()> { self.state.clear(); self.cache.clear(); self.save() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::*;

    fn w(dir: &Path, rel: &str, s: &str) { let p = dir.join(rel); fs::create_dir_all(p.parent().unwrap()).unwrap(); fs::write(p, s).unwrap(); }
    fn r(dir: &Path, rel: &str) -> String { fs::read_to_string(dir.join(rel)).unwrap_or_default() }
    fn project(dir: &Path, ch: &[(&str, &str)]) {
        let list: Vec<Value> = ch.iter().map(|(id, _)| json!({"id": id, "title": id})).collect();
        w(dir, "project.json", &serde_json::to_string_pretty(&json!({"name":"Роман","chapters":list})).unwrap());
        for (id, t) in ch { w(dir, &format!("Главы/{}.md", id), t); }
    }
    fn sync_of(dir: &Path, s: &FakeServer, st: &str) -> FolderSync<crate::yandexdisk::YandexDisk<FakeServer>> {
        FolderSync::new(dir, dav_on(s, "/Кабинет/Роман"), Some(dir.parent().unwrap().join(format!("{}.state", st)))).unwrap()
    }

    /// Слияние слов словаря в конфликтной ветке: сохранение меты между чтением и записью не должно теряться.
    /// Сохранение идёт из ДРУГОГО потока, как настоящая команда: после исправления она ждёт замок, а не вклинивается.
    #[test]
    fn meta_saved_during_word_merge_is_not_lost() {
        use std::sync::{Arc, Mutex, mpsc};
        use std::time::Duration;
        let s = FakeServer::new();
        let a = tmpdir("a").join("p");
        w(&a, "project.json", &serde_json::to_string_pretty(&json!({"name":"Роман","chapters":[{"id":"aaaaaa","title":"aaaaaa"}],"words":["альфа"]})).unwrap());
        w(&a, "Главы/aaaaaa.md", "текст");
        let mut sa = sync_of(&a, &s, "a");
        sa.export_all().unwrap();
        let b = tmpdir("b").join("p");
        let mut sb = sync_of(&b, &s, "b");
        sb.import_all().unwrap();

        // Оба устройства меняют мету: у A появилось слово «гамма», у B — «бета».
        let meta = |words: &[&str]| serde_json::to_string_pretty(&json!({"name":"Роман","chapters":[{"id":"aaaaaa","title":"aaaaaa"}],"words":words})).unwrap();
        w(&a, "project.json", &meta(&["альфа", "гамма"]));
        sa.sync().unwrap();
        w(&b, "project.json", &meta(&["альфа", "бета"]));

        let handle: Arc<Mutex<Option<std::thread::JoinHandle<()>>>> = Arc::new(Mutex::new(None));
        let (h2, b2) = (handle.clone(), b.clone());
        sync_hook::set(move || {
            let (tx, rx) = mpsc::channel();
            let t = std::thread::spawn(move || {
                crate::store::rename_chapter(&b2, "aaaaaa", "название, сохранённое во время прохода").unwrap();
                let _ = tx.send(());
            });
            *h2.lock().unwrap() = Some(t);
            // До исправления сохранение успевает завершиться здесь; после — ждёт замок, а таймаут лишь страховка.
            let _ = rx.recv_timeout(Duration::from_millis(600));
        });
        sb.sync().unwrap();
        if let Some(t) = handle.lock().unwrap().take() { t.join().unwrap(); }

        let live = r(&b, "project.json");
        let in_conflicts = fs::read_dir(b.join("Конфликты")).map(|d| d.flatten().any(|e| fs::read_to_string(e.path()).map(|t| t.contains("название, сохранённое")).unwrap_or(false))).unwrap_or(false);
        assert!(live.contains("название, сохранённое во время прохода") || in_conflicts,
            "конфликтная ветка sync затёрла project.json, сохранённый во время слияния слов");
        assert!(live.contains("бета"), "наше слово словаря должно остаться в живой мете");
    }

    /// Имена из облака, которые на Windows выходят за папку проекта или занимают устройство, не принимаем.
    #[test]
    fn unsafe_remote_names_are_not_pulled() {
        let s = FakeServer::new();
        let a = tmpdir("unsafe-names").join("p");
        project(&a, &[("aaaaaa", "текст")]);
        let mut sa = sync_of(&a, &s, "unsafe-names");
        sa.export_all().unwrap();
        for bad in ["Главы/x\\..\\..\\evil.md", "Главы/a:stream.md", "Главы/CON.md", "Главы/nul.txt", "Главы/trailing.md.", "Главы/a*b.md", "Главы/tab\tname.md", "project..\\x.json"] {
            s.put(&format!("Кабинет/Роман/{}", bad), b"evil");
        }
        s.put("Кабинет/Роман/Главы/bbbbbb.md", b"good");
        let res = sa.sync().unwrap();
        assert_eq!(r(&a, "Главы/bbbbbb.md"), "good", "обычное имя должно скачаться");
        let names: Vec<String> = fs::read_dir(a.join("Главы")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names.len(), 2, "скачано лишнее: {:?} / {:?}", names, res.pulled);
        assert!(!a.parent().unwrap().join("evil.md").exists());
    }

    /// Папку с главами заменили файлом: чтение каталога падает не «нет файла», а ошибкой. Раньше это считалось
    /// «все главы удалены локально», и удаление уходило в облако.
    #[test]
    fn unreadable_local_folder_is_not_taken_for_deletion() {
        let s = FakeServer::new();
        let a = tmpdir("walk-err").join("p");
        project(&a, &[("aaaaaa", "текст"), ("bbbbbb", "ещё")]);
        let mut sa = sync_of(&a, &s, "walk-err");
        sa.export_all().unwrap();
        fs::remove_dir_all(a.join("Главы")).unwrap();
        fs::write(a.join("Главы"), b"not a folder").unwrap();
        let res = sa.sync();
        assert!(res.is_err(), "проход должен остановиться, а не принять нечитаемую папку за пустую");
        assert!(s.names().iter().any(|n| n.ends_with("Главы/aaaaaa.md")) && s.names().iter().any(|n| n.ends_with("Главы/bbbbbb.md")),
            "главы в облаке удалены из-за ошибки чтения");
    }

    /// Нет прав на чтение файла (не root): файл не должен считаться удалённым.
    #[cfg(unix)]
    #[test]
    fn unreadable_local_file_is_not_taken_for_deletion() {
        use std::os::unix::fs::PermissionsExt;
        let s = FakeServer::new();
        let a = tmpdir("walk-file").join("p");
        project(&a, &[("aaaaaa", "текст")]);
        let mut sa = sync_of(&a, &s, "walk-file");
        sa.export_all().unwrap();
        let f = a.join("Главы/aaaaaa.md");
        fs::set_permissions(&f, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read(&f).is_ok() { fs::set_permissions(&f, fs::Permissions::from_mode(0o644)).unwrap(); return; } // root читает всё: проверка неприменима
        let res = sa.sync();
        fs::set_permissions(&f, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(res.is_err());
        assert!(s.names().iter().any(|n| n.ends_with("Главы/aaaaaa.md")), "файл в облаке удалён из-за ошибки чтения");
    }

    /// Контроль: папки с главами нет совсем (удалена) — это обычное удаление, не ошибка чтения.
    #[test]
    fn missing_local_folder_is_still_a_normal_deletion() {
        let a = tmpdir("walk-missing").join("p");
        project(&a, &[("aaaaaa", "текст")]);
        fs::remove_dir_all(a.join("Главы")).unwrap();
        let local = walk_local(&a).unwrap();
        assert!(local.keys().all(|k| !k.starts_with("Главы/")));
        assert!(local.contains_key("project.json"));
    }

    fn fixed_second() { crate::syncguard::set_test_now(Some(chrono::TimeZone::with_ymd_and_hms(&chrono::Local, 2026, 11, 14, 12, 0, 0).single().unwrap())); }
    fn local_conflicts(dir: &Path) -> Vec<String> {
        fs::read_dir(dir.join("Конфликты")).map(|d| d.flatten().filter_map(|e| fs::read_to_string(e.path()).ok()).collect()).unwrap_or_default()
    }
    fn remote_conflicts(s: &FakeServer) -> Vec<String> {
        s.names().iter().filter(|n| n.contains("/Конфликты/")).filter_map(|n| s.get(n)).map(|b| String::from_utf8_lossy(&b).into_owned()).collect()
    }

    /// P1: облако изменилось уже после списка в начале прохода. Наша запись не должна затереть чужую версию молча.
    #[test]
    fn cloud_change_after_listing_is_kept_before_our_push() {
        let s = FakeServer::new();
        let a = tmpdir("a").join("p");
        project(&a, &[("aaaaaa", "исходный")]);
        let mut sa = sync_of(&a, &s, "a");
        sa.export_all().unwrap();
        sa.sync().unwrap();
        w(&a, "Главы/aaaaaa.md", "правка на этом устройстве");
        let s2 = s.clone();
        sync_hook::set_remote(move || s2.put("Кабинет/Роман/Главы/aaaaaa.md", "правка с другого устройства".as_bytes()));
        let res = sa.sync().unwrap();
        assert_eq!(s.get("Кабинет/Роман/Главы/aaaaaa.md").unwrap(), "правка на этом устройстве".as_bytes());
        assert!(remote_conflicts(&s).contains(&"правка с другого устройства".to_string()), "чужая версия не сохранена: {:?}", remote_conflicts(&s));
        assert!(local_conflicts(&a).contains(&"правка с другого устройства".to_string()));
        assert!(res.conflicts.contains(&"Главы/aaaaaa.md".to_string()));
    }

    /// То же для нового файла: на момент списка его в облаке не было, к моменту записи другое устройство его создало.
    #[test]
    fn file_created_in_cloud_after_listing_is_kept_before_our_push() {
        let s = FakeServer::new();
        let a = tmpdir("a").join("p");
        project(&a, &[("aaaaaa", "один")]);
        let mut sa = sync_of(&a, &s, "a");
        sa.export_all().unwrap();
        sa.sync().unwrap();
        w(&a, "Главы/bbbbbb.md", "новая глава здесь");
        let s2 = s.clone();
        sync_hook::set_remote(move || s2.put("Кабинет/Роман/Главы/bbbbbb.md", "новая глава там".as_bytes()));
        sa.sync().unwrap();
        assert_eq!(s.get("Кабинет/Роман/Главы/bbbbbb.md").unwrap(), "новая глава здесь".as_bytes());
        assert!(remote_conflicts(&s).contains(&"новая глава там".to_string()));
    }

    /// Обычная запись без чужих правок не создаёт ложных конфликтов.
    #[test]
    fn plain_push_makes_no_false_conflict() {
        let s = FakeServer::new();
        let a = tmpdir("a").join("p");
        project(&a, &[("aaaaaa", "исходный")]);
        let mut sa = sync_of(&a, &s, "a");
        sa.export_all().unwrap();
        sa.sync().unwrap();
        w(&a, "Главы/aaaaaa.md", "обновлённый");
        w(&a, "Главы/cccccc.md", "новый");
        let res = sa.sync().unwrap();
        assert!(res.conflicts.is_empty() && remote_conflicts(&s).is_empty() && !a.join("Конфликты").exists());
        assert_eq!(s.get("Кабинет/Роман/Главы/aaaaaa.md").unwrap(), "обновлённый".as_bytes());
        assert_eq!(s.get("Кабинет/Роман/Главы/cccccc.md").unwrap(), "новый".as_bytes());
    }

    #[test]
    fn keep_does_not_overwrite_another_version_kept_in_the_same_second() {
        fixed_second();
        let s = FakeServer::new();
        let a = tmpdir("a").join("p");
        project(&a, &[("aaaaaa", "x")]);
        let mut sa = sync_of(&a, &s, "a");
        sa.keep_foreign("Главы/aaaaaa.md", b"version one", "aaaaaa").unwrap();
        sa.keep_foreign("Главы/aaaaaa.md", b"version two", "aaaaaa").unwrap();
        let (local, remote) = (local_conflicts(&a), remote_conflicts(&s));
        crate::syncguard::set_test_now(None);
        assert!(local.contains(&"version one".to_string()), "локально первая версия затёрта: {local:?}");
        assert!(local.contains(&"version two".to_string()), "локально вторая версия потеряна: {local:?}");
        assert!(remote.contains(&"version one".to_string()), "в папке первая версия затёрта: {remote:?}");
        assert!(remote.contains(&"version two".to_string()), "в папке вторая версия потеряна: {remote:?}");
    }

    #[test]
    fn keep_same_version_twice_makes_one_copy() {
        fixed_second();
        let s = FakeServer::new();
        let a = tmpdir("a").join("p");
        project(&a, &[("aaaaaa", "x")]);
        let mut sa = sync_of(&a, &s, "a");
        let first = sa.keep_foreign("Главы/aaaaaa.md", b"same", "aaaaaa").unwrap();
        let second = sa.keep_foreign("Главы/aaaaaa.md", b"same", "aaaaaa").unwrap();
        let (local, remote) = (local_conflicts(&a), remote_conflicts(&s));
        crate::syncguard::set_test_now(None);
        assert_eq!(first, second);
        assert_eq!((local.len(), remote.len()), (1, 1));
    }

    /// C1.1: ошибка чтения кандидата имени — Err, запись в непроверенный кандидат не выполняется.
    #[test]
    fn keep_read_error_returns_error_without_writing_candidate() {
        fixed_second();
        let s = FakeServer::new();
        let a = tmpdir("a").join("p");
        project(&a, &[("aaaaaa", "x")]);
        let mut sa = sync_of(&a, &s, "a");
        s.0.lock().unwrap().fail_get_prefixes.insert("/Кабинет/Роман/Конфликты/".to_string());
        let res = sa.keep_foreign("Главы/aaaaaa.md", "чужая версия".as_bytes(), "aaaaaa");
        let log = s.0.lock().unwrap().log.clone();
        let local_created = a.join("Конфликты").exists();
        crate::syncguard::set_test_now(None);
        assert!(res.is_err(), "ошибка чтения кандидата должна возвращать Err");
        assert!(log.iter().any(|l| l.starts_with("GETLINK /Кабинет/Роман/Конфликты/")), "ветка достигнута — чтение кандидата: {log:?}");
        assert!(!log.iter().any(|l| l.starts_with("PUT ")), "запись в непроверенный кандидат: {log:?}");
        assert!(!local_created, "локальная копия не должна создаваться при непроверенном имени");
    }

    /// C1.2: отказ mkdir «Конфликты» возвращается; состояние не отмечает несохранённую облачную копию.
    #[test]
    fn keep_mkdir_error_is_returned_and_state_not_marked() {
        fixed_second();
        let s = FakeServer::new();
        let a = tmpdir("a").join("p");
        project(&a, &[("aaaaaa", "x")]);
        let mut sa = sync_of(&a, &s, "a");
        s.0.lock().unwrap().fail_mkdir_paths.insert("/Кабинет/Роман/Конфликты".to_string());
        let res = sa.keep_foreign("Главы/aaaaaa.md", "чужая версия".as_bytes(), "aaaaaa");
        let log = s.0.lock().unwrap().log.clone();
        let marked = sa.state.keys().any(|k| k.starts_with("Конфликты/"));
        let local = local_conflicts(&a);
        crate::syncguard::set_test_now(None);
        assert!(res.is_err(), "отказ mkdir должен возвращаться вызывающему");
        assert!(log.iter().any(|l| l == "MKDIR /Кабинет/Роман/Конфликты"), "ветка достигнута: {log:?}");
        assert!(!marked, "состояние не должно отмечать облачную копию сохранённой");
        assert_eq!(local, vec!["чужая версия".to_string()], "локальная копия сохранена с правильными байтами");
    }

    /// C1.3: отказ записи облачной копии возвращается; локальная копия цела; повтор её не теряет.
    #[test]
    fn keep_cloud_write_error_is_returned_and_retry_keeps_local_copy() {
        fixed_second();
        let s = FakeServer::new();
        let a = tmpdir("a").join("p");
        project(&a, &[("aaaaaa", "x")]);
        let mut sa = sync_of(&a, &s, "a");
        s.0.lock().unwrap().fail_put_prefixes.insert("/Кабинет/Роман/Конфликты/".to_string());
        let res = sa.keep_foreign("Главы/aaaaaa.md", "чужая версия".as_bytes(), "aaaaaa");
        let log = s.0.lock().unwrap().log.clone();
        let marked = sa.state.keys().any(|k| k.starts_with("Конфликты/"));
        assert!(res.is_err(), "отказ записи облачной копии должен возвращаться");
        assert!(log.iter().any(|l| l.starts_with("PUT ") && l.contains("Конфликты")), "ветка достигнута — запись копии: {log:?}");
        assert!(!marked, "состояние не должно отмечать несуществующую облачную копию");
        assert_eq!(local_conflicts(&a), vec!["чужая версия".to_string()], "локальная копия цела");
        s.0.lock().unwrap().fail_put_prefixes.clear();
        let name = sa.keep_foreign("Главы/aaaaaa.md", "чужая версия".as_bytes(), "aaaaaa").unwrap();
        let local_after = local_conflicts(&a);
        crate::syncguard::set_test_now(None);
        assert!(a.join("Конфликты").join(&name).exists(), "повтор указывает на прежнюю локальную копию");
        assert_eq!(local_after, vec!["чужая версия".to_string()], "копия не потеряна и не задвоена");
        assert!(s.get(&format!("Кабинет/Роман/Конфликты/{}", name)).is_some(), "облачная копия подтверждена после повтора");
    }

    /// C1.4a: отказ копии перед ПЕРЕЗАПИСЬЮ останавливает запись; чужая версия не затёрта.
    #[test]
    fn keep_error_blocks_overwrite_of_foreign_version() {
        fixed_second();
        let s = FakeServer::new();
        let a = tmpdir("a").join("p");
        project(&a, &[("aaaaaa", "моё")]);
        let mut sa = sync_of(&a, &s, "a");
        sa.export_all().unwrap();
        s.put("Кабинет/Роман/Главы/aaaaaa.md", "чужая".as_bytes());
        w(&a, "Главы/aaaaaa.md", "моё новое");
        s.0.lock().unwrap().fail_put_prefixes.insert("/Кабинет/Роман/Конфликты/".to_string());
        let res = sa.push(&["Главы/aaaaaa.md".to_string()]);
        assert!(res.is_err(), "отказ копии должен останавливать перезапись");
        assert_eq!(s.get("Кабинет/Роман/Главы/aaaaaa.md").unwrap(), "чужая".as_bytes(), "вытесняемая версия не перезаписана");
        assert_eq!(local_conflicts(&a), vec!["чужая".to_string()], "локальная копия вытесненной версии сохранена");
        s.0.lock().unwrap().fail_put_prefixes.clear();
        sa.push(&["Главы/aaaaaa.md".to_string()]).unwrap();
        assert_eq!(s.get("Кабинет/Роман/Главы/aaaaaa.md").unwrap(), "моё новое".as_bytes(), "повтор проходит после снятия отказа");
        assert_eq!(local_conflicts(&a), vec!["чужая".to_string()], "прежняя локальная копия не потеряна");
        crate::syncguard::set_test_now(None);
    }

    /// C1.4b: отказ копии перед УДАЛЕНИЕМ останавливает удаление облачной версии.
    #[test]
    fn keep_error_blocks_cloud_delete_of_foreign_version() {
        let s = FakeServer::new();
        let a = tmpdir("a").join("p");
        project(&a, &[("aaaaaa", "моё")]);
        let mut sa = sync_of(&a, &s, "a");
        sa.export_all().unwrap();
        s.put("Кабинет/Роман/Главы/aaaaaa.md", "чужая".as_bytes());
        fs::remove_file(a.join("Главы/aaaaaa.md")).unwrap();
        s.0.lock().unwrap().fail_put_prefixes.insert("/Кабинет/Роман/Конфликты/".to_string());
        let res = sa.push(&["Главы/aaaaaa.md".to_string()]);
        assert!(res.is_err(), "отказ копии должен останавливать удаление");
        assert_eq!(s.get("Кабинет/Роман/Главы/aaaaaa.md").unwrap(), "чужая".as_bytes(), "облачная версия не удалена");
        assert_eq!(local_conflicts(&a), vec!["чужая".to_string()], "вытесненная версия сохранена локально");
    }

    #[test]
    fn replace_all_does_not_overwrite_a_copy_hidden_in_the_same_second() {
        fixed_second();
        let s = FakeServer::new();
        let a = tmpdir("a").join("p");
        project(&a, &[("aaaaaa", "x")]);
        let mut sa = sync_of(&a, &s, "a");
        s.put("Кабинет/Роман/Главы/zzzzzz.md", b"folder version one");
        sa.replace_all().unwrap();
        s.put("Кабинет/Роман/Главы/zzzzzz.md", b"folder version two");
        sa.replace_all().unwrap();
        let remote = remote_conflicts(&s);
        crate::syncguard::set_test_now(None);
        assert!(remote.contains(&"folder version one".to_string()), "«было в папке»: первая версия затёрта: {remote:?}");
        assert!(remote.contains(&"folder version two".to_string()), "«было в папке»: вторая версия потеряна: {remote:?}");
    }

    #[test]
    fn syncable_rules() {
        assert!(is_syncable("project.json") && is_syncable("project-2.json") && is_syncable("stats.json"));
        assert!(is_syncable("Главы/abc123.md") && is_syncable("Конфликты/x.md"));
        assert!(!is_syncable("kabinet.lock") && !is_syncable("Копии/x.md") && !is_syncable("Главы/.x.md") && !is_syncable("Главы/a.tmp") && !is_syncable("Главы/a/b.md"));
    }

    #[test]
    fn export_then_import_on_second_device() {
        let s = FakeServer::new();
        let a = tmpdir("a").join("p");
        project(&a, &[("aaaaaa", "Первая"), ("bbbbbb", "Вторая")]);
        let mut sa = sync_of(&a, &s, "a");
        assert!(!sa.has_project().unwrap());
        sa.export_all().unwrap();
        assert!(sa.has_project().unwrap());
        assert_eq!(s.get("Кабинет/Роман/Главы/aaaaaa.md").unwrap(), "Первая".as_bytes());

        let b = tmpdir("b").join("p");
        let mut sb = sync_of(&b, &s, "b");
        let files = sb.import_all().unwrap();
        assert_eq!(files.len(), 3);
        assert_eq!(r(&b, "Главы/bbbbbb.md"), "Вторая");
        let res = sb.sync().unwrap();
        assert!(res.pulled.is_empty() && res.pushed.is_empty() && res.conflicts.is_empty());
    }

    #[test]
    fn edits_flow_both_ways() {
        let s = FakeServer::new();
        let a = tmpdir("a").join("p");
        project(&a, &[("aaaaaa", "один")]);
        let mut sa = sync_of(&a, &s, "a");
        sa.export_all().unwrap();
        let b = tmpdir("b").join("p");
        let mut sb = sync_of(&b, &s, "b");
        sb.import_all().unwrap();

        w(&a, "Главы/aaaaaa.md", "один два");
        w(&a, "Главы/cccccc.md", "новая");
        let res = sa.sync().unwrap();
        assert_eq!(res.pushed.len(), 2);
        let res = sb.sync().unwrap();
        assert_eq!(res.pulled.len(), 2);
        assert_eq!(r(&b, "Главы/aaaaaa.md"), "один два");
        assert_eq!(r(&b, "Главы/cccccc.md"), "новая");

        fs::remove_file(b.join("Главы/cccccc.md")).unwrap();
        sb.push(&["Главы/cccccc.md".to_string()]).unwrap();
        assert!(s.get("Кабинет/Роман/Главы/cccccc.md").is_none());
    }

    #[test]
    fn both_edited_keeps_foreign_in_conflicts() {
        let s = FakeServer::new();
        let a = tmpdir("a").join("p");
        project(&a, &[("aaaaaa", "база")]);
        let mut sa = sync_of(&a, &s, "a");
        sa.export_all().unwrap();
        let b = tmpdir("b").join("p");
        let mut sb = sync_of(&b, &s, "b");
        sb.import_all().unwrap();

        w(&a, "Главы/aaaaaa.md", "правка A");
        sa.sync().unwrap();
        w(&b, "Главы/aaaaaa.md", "правка B");
        let res = sb.sync().unwrap();
        assert_eq!(res.conflicts, vec!["Главы/aaaaaa.md".to_string()]);
        assert_eq!(r(&b, "Главы/aaaaaa.md"), "правка B");
        assert_eq!(s.get("Кабинет/Роман/Главы/aaaaaa.md").unwrap(), "правка B".as_bytes());
        let conflicts: Vec<String> = fs::read_dir(b.join("Конфликты")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert_eq!(conflicts.len(), 1);
        assert!(conflicts[0].contains("(с другого устройства)"));
        assert_eq!(r(&b, &format!("Конфликты/{}", conflicts[0])), "правка A");
        assert!(s.names().iter().any(|n| n.contains("Конфликты/")));
    }

    #[test]
    fn remote_delete_removes_untouched_local_but_keeps_edited() {
        let s = FakeServer::new();
        let a = tmpdir("a").join("p");
        project(&a, &[("aaaaaa", "1"), ("bbbbbb", "2")]);
        let mut sa = sync_of(&a, &s, "a");
        sa.export_all().unwrap();
        let b = tmpdir("b").join("p");
        let mut sb = sync_of(&b, &s, "b");
        sb.import_all().unwrap();

        s.0.lock().unwrap().files.remove("/Кабинет/Роман/Главы/aaaaaa.md");
        s.0.lock().unwrap().files.remove("/Кабинет/Роман/Главы/bbbbbb.md");
        w(&b, "Главы/bbbbbb.md", "правил у себя");
        let res = sb.sync().unwrap();
        assert!(!b.join("Главы/aaaaaa.md").exists());
        assert!(res.conflicts.contains(&"Главы/bbbbbb.md".to_string()));
        assert_eq!(r(&b, "Главы/bbbbbb.md"), "правил у себя");
    }

    #[test]
    fn incomplete_cloud_answers_delete_nothing() {
        let s = FakeServer::new();
        let a = tmpdir("a").join("p");
        project(&a, &[("aaaaaa", "1"), ("bbbbbb", "2"), ("cccccc", "3"), ("dddddd", "4"), ("eeeeee", "5"), ("ffffff", "6")]);
        let mut sa = sync_of(&a, &s, "a");
        sa.export_all().unwrap();
        // совсем пусто
        s.0.lock().unwrap().hide_all_files = true;
        let err = sa.sync().unwrap_err();
        assert!(err.contains("не видно файлов проекта"));
        // корень на месте, остальное пропало
        s.0.lock().unwrap().hide_all_files = false;
        s.put("Кабинет/Роман/project.json", &fs::read(a.join("project.json")).unwrap());
        for id in ["aaaaaa", "bbbbbb", "cccccc", "dddddd", "eeeeee", "ffffff"] { s.0.lock().unwrap().files.remove(&format!("/Кабинет/Роман/Главы/{}.md", id)); }
        let err = sa.sync().unwrap_err();
        assert!(err.contains("большая часть"));
        for id in ["aaaaaa", "ffffff"] { assert!(a.join(format!("Главы/{}.md", id)).exists()); }
    }

    #[test]
    fn failed_read_stops_before_changes() {
        let s = FakeServer::new();
        let a = tmpdir("a").join("p");
        project(&a, &[("aaaaaa", "1")]);
        let mut sa = sync_of(&a, &s, "a");
        sa.export_all().unwrap();
        s.0.lock().unwrap().fail_gets = true;
        w(&a, "Главы/aaaaaa.md", "правка");
        assert!(sa.sync().is_err());
        assert_eq!(r(&a, "Главы/aaaaaa.md"), "правка");
    }

    #[test]
    fn signature_cache_skips_unchanged_downloads() {
        let s = FakeServer::new();
        let a = tmpdir("a").join("p");
        project(&a, &[("aaaaaa", "1"), ("bbbbbb", "2")]);
        let mut sa = sync_of(&a, &s, "a");
        sa.export_all().unwrap();
        sa.sync().unwrap(); // прогрев кэша
        s.0.lock().unwrap().log.clear();
        sa.sync().unwrap();
        let gets = s.0.lock().unwrap().log.iter().filter(|l| l.starts_with("GET")).count();
        assert_eq!(gets, 0);
        // после перезапуска кэш читается с диска
        let mut sa2 = sync_of(&a, &s, "a");
        s.0.lock().unwrap().log.clear();
        sa2.sync().unwrap();
        assert_eq!(s.0.lock().unwrap().log.iter().filter(|l| l.starts_with("GET")).count(), 0);
    }

    #[test]
    fn first_connection_adopts_cloud_structure_and_keeps_authors_work() {
        let s = FakeServer::new();
        let a = tmpdir("a").join("p");
        project(&a, &[("aaaaaa", "старый роман")]);
        sync_of(&a, &s, "a").export_all().unwrap();

        let b = tmpdir("b").join("p");
        project(&b, &[("zzzzzz", ""), ("yyyyyy", "мой черновик")]);
        let mut sb = sync_of(&b, &s, "b");
        sb.sync().unwrap();
        let meta: Value = serde_json::from_str(&r(&b, "project.json")).unwrap();
        let ids: Vec<&str> = meta["chapters"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["aaaaaa", "yyyyyy"]); // пустая новая глава отброшена, непустая добавлена
        assert_eq!(r(&b, "Главы/aaaaaa.md"), "старый роман");
        assert!(!b.join("Главы/zzzzzz.md").exists());
        assert!(fs::read_dir(b.join("Конфликты")).unwrap().flatten().any(|e| e.file_name().to_string_lossy().contains("было на этом устройстве")));
    }

    /// Ошибку чтения главы нельзя принимать за пустоту: иначе нечитаемая глава выпадет из слияния
    /// и её текст останется без ссылки в проекте, а повторная проверка могла бы удалить файл.
    /// Подмена файла каталогом даёт ошибку чтения, отличную от NotFound; это воспроизводимый
    /// тест контракта, а не эквивалент всех ошибок доступа (см. карточку № 4 в ТЗ).
    #[test]
    fn unreadable_chapter_is_not_treated_as_empty_in_adopt() {
        let s = FakeServer::new();
        let a = tmpdir("adopt-read-err-a").join("p");
        project(&a, &[("aaaaaa", "старый роман")]);
        sync_of(&a, &s, "a").export_all().unwrap();

        let b = tmpdir("adopt-read-err-b").join("p");
        project(&b, &[("yyyyyy", "мой черновик")]);
        let file = b.join("Главы/yyyyyy.md");
        fs::remove_file(&file).unwrap();
        fs::create_dir(&file).unwrap();
        let meta_before = r(&b, "project.json");

        let mut sb = sync_of(&b, &s, "b");
        let res = sb.sync();
        assert!(res.is_err(), "слияние с нечитаемой главой должно остановиться, а не считать главу пустой");
        assert!(file.is_dir(), "файл не удалён: на его месте по-прежнему каталог");
        assert_eq!(r(&b, "project.json"), meta_before, "мета не должна потерять главу при ошибке чтения");
    }

    /// Отсутствие файла главы — отдельный безопасный случай: ссылку в мете сохраняем, за пустоту не считаем.
    #[test]
    fn adopt_keeps_chapter_reference_when_its_file_is_missing() {
        let s = FakeServer::new();
        let a = tmpdir("adopt-missing-a").join("p");
        project(&a, &[("aaaaaa", "старый роман")]);
        sync_of(&a, &s, "a").export_all().unwrap();

        let b = tmpdir("adopt-missing-b").join("p");
        project(&b, &[("yyyyyy", "черновик")]);
        fs::remove_file(b.join("Главы/yyyyyy.md")).unwrap(); // файла нет, ссылка в мете осталась
        let mut sb = sync_of(&b, &s, "b");
        sb.sync().unwrap();
        let meta: Value = serde_json::from_str(&r(&b, "project.json")).unwrap();
        let ids: Vec<&str> = meta["chapters"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap()).collect();
        assert!(ids.contains(&"yyyyyy"), "отсутствие файла не повод терять ссылку на главу: {ids:?}");
        assert!(ids.contains(&"aaaaaa"));
    }

    /// Ошибка удаления пустой главы в adopt доходит до вызывающего кода; файл и мета не публикуются.
    #[cfg(windows)]
    #[test]
    fn adopt_reports_failure_to_remove_empty_chapter() {
        use std::os::windows::fs::OpenOptionsExt;
        let s = FakeServer::new();
        let a = tmpdir("adopt-del-err-a").join("p");
        project(&a, &[("aaaaaa", "старый роман")]);
        sync_of(&a, &s, "a").export_all().unwrap();

        let b = tmpdir("adopt-del-err-b").join("p");
        project(&b, &[("zzzzzz", "")]); // пустая глава, которой нет в облаке → adopt её удалит
        let file = b.join("Главы/zzzzzz.md");
        // Читать файл можно, удалить — нельзя: воспроизводимый отказ удаления без chmod.
        let lock = fs::OpenOptions::new().read(true).share_mode(1).open(&file).unwrap();
        let mut sb = sync_of(&b, &s, "b");
        let err = match sb.sync() {
            Err(e) => e,
            Ok(r) => panic!("ожидалась ошибка удаления, получено Ok: {:?}", r.pulled),
        };
        assert!(err.contains("Не удалось удалить пустую главу"), "ошибка именно от удаления в adopt, а не раньше: {}", err);
        assert!(file.exists(), "файл пустой главы остался на месте");
        let meta: Value = serde_json::from_str(&r(&b, "project.json")).unwrap();
        let ids: Vec<&str> = meta["chapters"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["zzzzzz"], "после отказа мета сохраняет свою главу и не публикует новую структуру: {ids:?}");

        // После снятия блокировки повтор тем же объектом должен завершиться штатно.
        drop(lock);
        sb.sync().expect("повтор после снятия блокировки должен завершиться штатно");
        assert!(!file.exists(), "пустая глава удалена при повторе");
        assert!(b.join("Главы/aaaaaa.md").exists(), "облачная глава скачана при повторе");
        let meta: Value = serde_json::from_str(&r(&b, "project.json")).unwrap();
        let ids: Vec<&str> = meta["chapters"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["aaaaaa"], "облачная структура присутствует в локальной мете: {ids:?}");
    }

    /// Ветка `Err(_) => true` в `has_local_content`: нечитаемая глава уже есть в облаке (слияние её не читает),
    /// мета отличается нейтральным полем — без защиты локальная копия project.json не сохранилась бы.
    #[test]
    fn has_local_content_keeps_project_copy_when_chapter_read_fails() {
        let s = FakeServer::new();
        let a = tmpdir("hlc-a").join("p");
        project(&a, &[("aaaaaa", "текст")]);
        sync_of(&a, &s, "a").export_all().unwrap();

        let b = tmpdir("hlc-b").join("p");
        project(&b, &[("aaaaaa", "текст")]);
        let mut meta: Value = serde_json::from_str(&r(&b, "project.json")).unwrap();
        meta["neutralMarker"] = json!(1); // мета отличается, но это поле не входит в has_local_content
        w(&b, "project.json", &serde_json::to_string_pretty(&meta).unwrap());
        let file = b.join("Главы/aaaaaa.md");
        fs::remove_file(&file).unwrap();
        fs::create_dir(&file).unwrap(); // ошибка чтения возникает именно внутри has_local_content

        let mut sb = sync_of(&b, &s, "b");
        let _ = sb.sync(); // дальнейшие шаги могут упереться в каталог на месте файла — это не предмет теста
        let conflicts: Vec<String> = fs::read_dir(b.join("Конфликты"))
            .map(|d| d.flatten().filter_map(|e| fs::read_to_string(e.path()).ok()).collect()).unwrap_or_default();
        assert!(conflicts.iter().any(|t| t.contains("neutralMarker")),
            "ошибка чтения в has_local_content должна сохранить локальную копию project.json: {:?}", conflicts);
    }

    /// stats.json синхронизируется как обычный файл: статистика с другого устройства не теряется.
    #[test]
    fn stats_file_is_synced_between_devices() {
        let s = FakeServer::new();
        let a = tmpdir("stats-sync-a").join("p");
        project(&a, &[("aaaaaa", "текст")]);
        w(&a, "stats.json", &serde_json::to_string(&json!({ "days": { "2026-11-10": 100 } })).unwrap());
        sync_of(&a, &s, "a").export_all().unwrap();

        let b = tmpdir("stats-sync-b").join("p");
        let mut sb = sync_of(&b, &s, "b");
        sb.import_all().unwrap();
        let days: Value = serde_json::from_str(&r(&b, "stats.json")).unwrap();
        assert_eq!(days["days"]["2026-11-10"], 100, "статистика должна прийти с другого устройства");
    }

    /// Порча файла состояния не должна выдаваться за «первую синхронизацию»: иначе снимок пуст
    /// и возможны опасные решения (слияние/удаление). Создание FolderSync возвращает ошибку.
    #[test]
    fn corrupt_state_file_blocks_sync_instead_of_first_sync() {
        let s = FakeServer::new();
        let a = tmpdir("state-corrupt").join("p");
        project(&a, &[("aaaaaa", "текст")]);
        let state = a.parent().unwrap().join("bad.state");
        fs::write(&state, "{ битый").unwrap();
        let made = FolderSync::new(&a, dav_on(&s, "/Кабинет/Роман"), Some(state));
        assert!(made.is_err(), "повреждённое состояние должно блокировать синхронизацию");
    }

    /// Ошибка записи состояния не выдаётся за успешную синхронизацию.
    #[test]
    fn sync_reports_failed_state_save() {
        let s = FakeServer::new();
        let a = tmpdir("state-save-fail").join("p");
        project(&a, &[("aaaaaa", "текст")]);
        let state = a.parent().unwrap().join("state-later-dir");
        let mut sa = FolderSync::new(&a, dav_on(&s, "/Кабинет/Роман"), Some(state.clone())).unwrap();
        fs::create_dir(&state).unwrap(); // на месте файла состояния каталог: запись упадёт
        let res = sa.sync();
        assert!(res.is_err(), "ошибка записи состояния не должна выдаваться за успех");
        assert!(s.get("Кабинет/Роман/project.json").is_some(), "работа до сохранения состояния выполнена");
    }

    /// Прерывание МЕЖДУ публикацией state и обновлением cache: state новый, cache старый.
    /// Новый экземпляр должен восстановиться; локальный текст и чужая версия не теряются,
    /// устаревший/отсутствующий необязательный кэш не «подтверждает» удаление или перезапись.
    #[test]
    fn restart_after_state_saved_but_stale_cache_keeps_both_versions() {
        let s = FakeServer::new();
        let a = tmpdir("stale-cache").join("p");
        project(&a, &[("aaaaaa", "текст")]);
        let state_file = a.parent().unwrap().join("a.state");
        let cache_file = PathBuf::from(format!("{}.cache", state_file.display()));
        let mut sa = sync_of(&a, &s, "a");
        sa.export_all().unwrap();
        let state_before = fs::read(&state_file).unwrap();
        let cache_before = fs::read(&cache_file).unwrap();
        assert!(state_before.len() > 2 && cache_before.len() > 2, "исходные state и cache записаны");

        // Обе стороны изменились: проход обновит state и cache, чужая версия уйдёт в «Конфликты».
        s.put("Кабинет/Роман/Главы/aaaaaa.md", "чужая правка".as_bytes());
        w(&a, "Главы/aaaaaa.md", "моя правка");
        let res = sa.sync().unwrap();
        assert!(res.conflicts.contains(&"Главы/aaaaaa.md".to_string()), "конфликт зафиксирован: {:?}", res.conflicts);
        let state_after_first = fs::read(&state_file).unwrap();
        assert_ne!(state_before, state_after_first, "state обновился после прохода");

        // Моделируем прерывание: `save` публикует state ПЕРВЫМ и атомарно, затем пишет cache (ошибка кэша
        // не отменяет проход). Сбой/ошибка между ними оставляет новый state и старый cache — этот снимок
        // достижим в рабочем порядке записи.
        fs::write(&cache_file, &cache_before).unwrap();

        // НОВЫЙ экземпляр с теми же сохранёнными данными — не повтор тем же объектом.
        let state_json: Value = serde_json::from_slice(&state_after_first).unwrap();
        let mut sb = sync_of(&a, &s, "a");
        let loaded = sb.state();
        assert_eq!(loaded.get("Главы/aaaaaa.md").map(|s| s.as_str()), state_json["Главы/aaaaaa.md"].as_str(),
            "новый экземпляр загрузил state без потерь: {:?}", loaded);
        let res2 = sb.sync().unwrap();
        assert!(res2.pulled.is_empty() && res2.pushed.is_empty() && res2.removed.is_empty(),
            "устаревший кэш не должен вызывать решений: pulled={:?} pushed={:?} removed={:?}", res2.pulled, res2.pushed, res2.removed);
        assert_eq!(fs::read_to_string(a.join("Главы/aaaaaa.md")).unwrap(), "моя правка", "локальный текст сохранён");
        assert_eq!(s.get("Кабинет/Роман/Главы/aaaaaa.md").unwrap(), "моя правка".as_bytes(), "согласованная облачная версия сохранена");
        let conflicts: Vec<String> = fs::read_dir(a.join("Конфликты"))
            .map(|d| d.flatten().filter_map(|e| fs::read_to_string(e.path()).ok()).collect()).unwrap_or_default();
        assert!(conflicts.iter().any(|t| t.contains("чужая правка")), "чужая версия сохранена в «Конфликтах»: {:?}", conflicts);
        assert_eq!(fs::read(&state_file).unwrap(), state_after_first, "повтор не переписал state");

        // Отсутствующий необязательный кэш: новый экземпляр и проход тоже безопасны.
        fs::remove_file(&cache_file).unwrap();
        let mut sc = sync_of(&a, &s, "a");
        let res3 = sc.sync().unwrap();
        assert!(res3.pulled.is_empty() && res3.pushed.is_empty() && res3.removed.is_empty(),
            "без кэша решений быть не должно: pulled={:?} pushed={:?} removed={:?}", res3.pulled, res3.pushed, res3.removed);
        assert_eq!(fs::read_to_string(a.join("Главы/aaaaaa.md")).unwrap(), "моя правка", "локальный текст сохранён без кэша");
        assert_eq!(s.get("Кабинет/Роман/Главы/aaaaaa.md").unwrap(), "моя правка".as_bytes(), "облачная версия не тронута без кэша");
    }

    /// Ошибка чтения облачной копии не должна приводить к её удалению без сохранения чужой версии.
    #[test]
    fn delete_keeps_cloud_file_when_cloud_read_fails() {
        let s = FakeServer::new();
        let a = tmpdir("del-readerr").join("p");
        project(&a, &[("aaaaaa", "текст")]);
        let mut sa = sync_of(&a, &s, "a");
        sa.export_all().unwrap();
        fs::remove_file(a.join("Главы/aaaaaa.md")).unwrap(); // автор удалил главу локально
        s.0.lock().unwrap().fail_gets = true; // облако не отдаёт файл: ошибка, а не 404
        let res = sa.push(&["Главы/aaaaaa.md".to_string()]);
        assert!(res.is_err(), "ошибка чтения облака должна остановить удаление");
        assert!(s.get("Кабинет/Роман/Главы/aaaaaa.md").is_some(), "облачный файл сохранён");
    }

    /// Ошибка удаления в облаке не должна выдаваться за успешно выполненное удаление.
    #[test]
    fn delete_reports_cloud_remove_error() {
        let s = FakeServer::new();
        let a = tmpdir("del-remerr").join("p");
        project(&a, &[("aaaaaa", "текст")]);
        let mut sa = sync_of(&a, &s, "a");
        sa.export_all().unwrap();
        fs::remove_file(a.join("Главы/aaaaaa.md")).unwrap();
        s.0.lock().unwrap().fail_deletes = true;
        let res = sa.push(&["Главы/aaaaaa.md".to_string()]);
        assert!(res.is_err(), "ошибка удаления в облаке должна возвращаться");
        assert!(s.get("Кабинет/Роман/Главы/aaaaaa.md").is_some(), "файл в облаке ещё не удалён");
    }

    /// Чужая правка перед локальным удалением сохраняется в «Конфликты», а не теряется.
    #[test]
    fn local_delete_preserves_changed_cloud_version_before_removing() {
        let s = FakeServer::new();
        let a = tmpdir("del-foreign").join("p");
        project(&a, &[("aaaaaa", "текст")]);
        let mut sa = sync_of(&a, &s, "a");
        sa.export_all().unwrap();
        // локально удалили, а в облаке — другая версия (правка с другого устройства)
        fs::remove_file(a.join("Главы/aaaaaa.md")).unwrap();
        s.put("Кабинет/Роман/Главы/aaaaaa.md", "правка с телефона".as_bytes());
        let res = sa.push(&["Главы/aaaaaa.md".to_string()]).unwrap();
        assert!(res.conflicts.contains(&"Главы/aaaaaa.md".to_string()), "чужая правка должна попасть в конфликты");
        assert!(s.names().iter().any(|n| n.contains("Конфликты") && s.get(n).as_deref() == Some("правка с телефона".as_bytes())), "чужая версия сохранена: {:?}", s.names());
        assert!(s.get("Кабинет/Роман/Главы/aaaaaa.md").is_none(), "облачный файл удалён после сохранения копии");
    }

    /// Неполный список облака (файл пропал из списка, но не удалён) не должен удалять локальную главу.
    #[test]
    fn remote_list_paginates_without_losing_files() {
        let s = FakeServer::new();
        let a = tmpdir("pages").join("p");
        project(&a, &[("aaaaaa", "1"), ("bbbbbb", "2"), ("cccccc", "3"), ("dddddd", "4")]);
        let mut sa = sync_of(&a, &s, "a");
        sa.export_all().unwrap();
        s.0.lock().unwrap().page_limit = Some(2); // сервер отдаёт по 2 записи
        let mut r = dav_on(&s, "/Кабинет/Роман");
        let items = r.list("Главы").unwrap();
        assert_eq!(items.len(), 4, "пагинация не теряет записи: {:?}", items.iter().map(|i| i.name.clone()).collect::<Vec<_>>());
    }

    /// Нестабильный total (сжатие) может дать неполный список, но локальные файлы не удаляются.
    #[test]
    fn unstable_total_does_not_delete_local_files() {
        let s = FakeServer::new();
        let a = tmpdir("shrink").join("p");
        project(&a, &[("aaaaaa", "1"), ("bbbbbb", "2"), ("cccccc", "3"), ("dddddd", "4"), ("eeeeee", "5"), ("ffffff", "6")]);
        let mut sa = sync_of(&a, &s, "a");
        sa.export_all().unwrap();
        s.0.lock().unwrap().page_limit = Some(2);
        s.0.lock().unwrap().total_shrink = true;
        let _ = sa.sync();
        for (id, text) in [("aaaaaa", "1"), ("bbbbbb", "2"), ("cccccc", "3"), ("dddddd", "4"), ("eeeeee", "5"), ("ffffff", "6")] {
            assert_eq!(fs::read_to_string(a.join(format!("Главы/{}.md", id))).unwrap(), text, "сжатие total не должно удалять главу {}", id);
        }
    }

    /// Дубли в списке облака не вызывают изменений и не теряют файлы.
    #[test]
    fn duplicate_listing_entry_is_handled_once() {
        let s = FakeServer::new();
        let a = tmpdir("dup").join("p");
        project(&a, &[("aaaaaa", "текст")]);
        let mut sa = sync_of(&a, &s, "a");
        sa.export_all().unwrap();
        s.0.lock().unwrap().duplicate = true;
        let res = sa.sync().unwrap();
        assert!(res.pulled.is_empty() && res.pushed.is_empty(), "дубль в списке не должен вызывать изменений: {:?}", res.pulled.len() + res.pushed.len());
        assert_eq!(fs::read_to_string(a.join("Главы/aaaaaa.md")).unwrap(), "текст");
    }

    /// Папка пропала из списка (404 посреди обхода) — локальные файлы не удаляются.
    #[test]
    fn folder_gone_from_listing_does_not_delete_local_files() {
        let s = FakeServer::new();
        let a = tmpdir("folder-gone").join("p");
        project(&a, &[("aaaaaa", "текст")]);
        let mut sa = sync_of(&a, &s, "a");
        sa.export_all().unwrap();
        s.0.lock().unwrap().dirs.remove("/Кабинет/Роман/Главы");
        let _ = sa.sync();
        assert!(a.join("Главы/aaaaaa.md").exists(), "пропажа папки из списка не должна удалять локальные файлы");
    }

    /// Ошибка страницы списка останавливает обход, а не «файлов нет».
    #[test]
    fn list_page_error_is_reported() {
        let s = FakeServer::new();
        s.put("Кабинет/Роман/Главы/aaaaaa.md", "текст".as_bytes());
        let mut r = dav_on(&s, "/Кабинет/Роман");
        s.0.lock().unwrap().fail_list = true;
        assert!(r.list("Главы").is_err(), "ошибка страницы должна возвращаться как ошибка");
    }

    /// Исчезновение всего списка облака останавливает синхронизацию, ничего не удаляя.
    #[test]
    fn disappearing_list_stops_before_deleting_anything() {
        let s = FakeServer::new();
        let a = tmpdir("all-gone").join("p");
        project(&a, &[("aaaaaa", "текст")]);
        let mut sa = sync_of(&a, &s, "a");
        sa.export_all().unwrap();
        s.0.lock().unwrap().hide_all_files = true;
        assert!(sa.sync().is_err(), "исчезновение всего списка останавливает синхронизацию");
        assert!(a.join("Главы/aaaaaa.md").exists(), "локальные файлы не тронуты");
    }

    /// Сбой прохода не портит состояние: повтор после устранения сбоя проходит.
    #[test]
    fn failed_pass_is_retried_and_succeeds() {
        let s = FakeServer::new();
        let a = tmpdir("retry").join("p");
        project(&a, &[("aaaaaa", "текст")]);
        let mut sa = sync_of(&a, &s, "a");
        sa.export_all().unwrap();
        fs::remove_file(a.join("Главы/aaaaaa.md")).unwrap(); // автор удалил главу локально
        s.0.lock().unwrap().fail_gets = true;               // первый проход: ошибка чтения облака
        assert!(sa.push(&["Главы/aaaaaa.md".to_string()]).is_err(), "первый проход падает");
        assert!(s.get("Кабинет/Роман/Главы/aaaaaa.md").is_some(), "облако не тронуто после сбоя");
        s.0.lock().unwrap().fail_gets = false;              // сбой устранён — повтор
        let res = sa.push(&["Главы/aaaaaa.md".to_string()]).unwrap();
        assert!(res.removed.contains(&"Главы/aaaaaa.md".to_string()), "повтор удаляет облачную копию: {:?}", res.removed);
        assert!(s.get("Кабинет/Роман/Главы/aaaaaa.md").is_none(), "повтор прошёл");
    }

    /// Недоступное облако останавливает синхронизацию; локальные файлы не трогаются.
    #[test]
    fn unavailable_cloud_stops_sync_without_local_changes() {
        struct Offline;
        impl crate::remote::Remote for Offline {
            fn list(&mut self, _: &str) -> R<Vec<crate::remote::Item>> { Err("Нет связи".into()) }
            fn read(&mut self, _: &str) -> R<Option<Vec<u8>>> { Err("Нет связи".into()) }
            fn write(&mut self, _: &str, _: &[u8]) -> R<()> { Err("Нет связи".into()) }
            fn remove(&mut self, _: &str) -> R<()> { Err("Нет связи".into()) }
            fn mkdir(&mut self, _: &str) -> R<()> { Err("Нет связи".into()) }
        }
        let a = tmpdir("offline").join("p");
        project(&a, &[("aaaaaa", "текст")]);
        let mut sa = FolderSync::new(&a, Offline, None).unwrap();
        assert!(sa.sync().is_err(), "недоступное облако должно останавливать синхронизацию");
        assert_eq!(fs::read_to_string(a.join("Главы/aaaaaa.md")).unwrap(), "текст", "локальный файл не тронут");
    }

    /// Асинхронное удаление в облаке (202 + операция) подтверждается опросом статуса.
    #[test]
    fn async_cloud_delete_is_confirmed_by_operation() {
        let s = FakeServer::new();
        s.put("Кабинет/Роман/Главы/aaaaaa.md", "текст".as_bytes());
        let mut r = dav_on(&s, "/Кабинет/Роман");
        s.0.lock().unwrap().async_deletes = true;
        r.remove("Главы/aaaaaa.md").unwrap();
        assert!(s.get("Кабинет/Роман/Главы/aaaaaa.md").is_none(), "удаление через асинхронную операцию подтверждено");
    }

    /// Пустая промежуточная страница при непустом total — отказ, а не «файлов нет».
    #[test]
    fn empty_intermediate_page_is_rejected() {
        let s = FakeServer::new();
        let a = tmpdir("page-gap").join("p");
        project(&a, &[("aaaaaa", "1"), ("bbbbbb", "2"), ("cccccc", "3"), ("dddddd", "4")]);
        let mut sa = sync_of(&a, &s, "a");
        sa.export_all().unwrap();
        s.0.lock().unwrap().page_limit = Some(2);
        s.0.lock().unwrap().empty_page_at = Some(2);
        let mut r = dav_on(&s, "/Кабинет/Роман");
        assert!(r.list("Главы").is_err(), "пустая промежуточная страница должна останавливать список");
    }

    /// Неполный список облака (файл пропал из списка, но не удалён) не должен удалять локальную главу.
    #[test]
    fn incomplete_listing_does_not_delete_local_chapter() {
        let s = FakeServer::new();
        let a = tmpdir("hidden-one").join("p");
        project(&a, &[("aaaaaa", "текст")]);
        let mut sa = sync_of(&a, &s, "a");
        sa.export_all().unwrap();
        // Облако отдаёт неполный список: главы в списке нет, но прямая выдача файла работает.
        s.0.lock().unwrap().hide.insert("/Кабинет/Роман/Главы/aaaaaa.md".to_string());
        let res = sa.sync().unwrap();
        assert!(a.join("Главы/aaaaaa.md").exists(), "неполный список не должен удалять локальную главу");
        assert_eq!(fs::read_to_string(a.join("Главы/aaaaaa.md")).unwrap(), "текст");
        assert!(res.pulled.is_empty(), "ничего не должно быть удалено: {:?}", res.pulled);
    }

    /// Гонка создания: пока мы проверяли файл, другое устройство создало его — не затираем чужое молча.
    #[test]
    fn push_new_file_does_not_overwrite_concurrent_creation() {
        let s = FakeServer::new();
        let a = tmpdir("race-new").join("p");
        project(&a, &[("aaaaaa", "наш текст")]);
        let mut sa = sync_of(&a, &s, "a");
        let s2 = s.clone();
        sync_hook::set_remote_after(move || { s2.put("Кабинет/Роман/Главы/aaaaaa.md", "чужой текст".as_bytes()); });
        let res = sa.push(&["Главы/aaaaaa.md".to_string()]).unwrap();
        assert!(res.conflicts.contains(&"Главы/aaaaaa.md".to_string()), "гонка создания должна дать конфликт");
        assert_eq!(s.get("Кабинет/Роман/Главы/aaaaaa.md").unwrap(), "наш текст".as_bytes(), "наша версия записана");
        assert!(s.names().iter().any(|n| n.contains("Конфликты") && s.get(n).as_deref() == Some("чужой текст".as_bytes())), "чужая версия сохранена: {:?}", s.names());
    }

    /// Неудачное локальное удаление не должно молча считаться успехом (файл занят другим процессом).
    #[cfg(windows)]
    #[test]
    fn local_delete_failure_is_reported_not_hidden() {
        use std::os::windows::fs::OpenOptionsExt;
        let s = FakeServer::new();
        let a = tmpdir("del-lock").join("p");
        project(&a, &[("aaaaaa", "текст")]);
        let mut sa = sync_of(&a, &s, "a");
        sa.export_all().unwrap();
        // облако удалило главу, а локальный файл держим открытым так, что удалить его нельзя
        s.0.lock().unwrap().files.remove("/Кабинет/Роман/Главы/aaaaaa.md");
        let f = a.join("Главы/aaaaaa.md");
        let _lock = fs::OpenOptions::new().read(true).share_mode(1).open(&f).unwrap();
        let res = sa.sync();
        assert!(res.is_err(), "неудачное локальное удаление не должно молча считаться успехом: {:?}", res.as_ref().map(|r| r.pulled.clone()));
        assert!(f.exists(), "файл на месте");
        assert_eq!(fs::read_to_string(&f).unwrap(), "текст");
    }

    /// Папка-ссылка (junction) не должна обходиться: иначе в синхронизацию попадут файлы вне проекта.
    /// Обычная структура проекта обходится по папкам; вложенная подпапка не синхронизируется.
    #[test]
    fn normal_structure_is_walked_by_folders() {
        let dir = tmpdir("structure").join("p");
        project(&dir, &[("aaaaaa", "текст")]);
        fs::create_dir_all(dir.join("Персонажи")).unwrap();
        fs::write(dir.join("Персонажи/p1.json"), "{}").unwrap();
        fs::create_dir_all(dir.join("Главы/подпапка")).unwrap();
        fs::write(dir.join("Главы/подпапка/x.md"), "x").unwrap();
        let local = walk_local(&dir).unwrap();
        assert!(local.contains_key("project.json"));
        assert!(local.contains_key("Главы/aaaaaa.md"));
        assert!(local.contains_key("Персонажи/p1.json"));
        assert!(!local.keys().any(|k| k.contains("подпапка")), "вложенная подпапка не синхронизируется");
    }

    #[cfg(windows)]
    #[test]
    fn walk_local_does_not_enter_linked_folder() {
        use std::process::Command;
        let base = tmpdir("walk-link");
        let dir = base.join("p");
        project(&dir, &[("aaaaaa", "текст")]);
        // Внешний каталог с файлом, на который указывает junction вместо папки «Главы».
        let outside = base.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.md"), "внешний файл").unwrap();
        fs::remove_dir_all(dir.join("Главы")).unwrap();
        let st = Command::new("cmd").args(["/c", "mklink", "/J"]).arg(dir.join("Главы")).arg(&outside).status().unwrap();
        assert!(st.success(), "не удалось создать junction");
        let local = walk_local(&dir).unwrap();
        assert!(local.keys().all(|k| !k.contains("secret.md")), "walk_local зашёл в папку-ссылку: {:?}", local.keys().collect::<Vec<_>>());
    }

    #[test]
    fn dictionary_words_survive_project_conflict() {
        let local = r#"{"name":"A","chapters":[],"words":["один","два"]}"#.as_bytes();
        let remote = r#"{"name":"A","chapters":[],"words":["два","три"]}"#.as_bytes();
        let m = merge_meta_words(local, remote).unwrap();
        let v: Value = serde_json::from_slice(&m).unwrap();
        assert_eq!(v["words"], json!(["один", "два", "три"]));
        assert!(merge_meta_words(local, local).is_none());
        assert!(merge_meta_words(b"{}", remote).is_none());
    }

    #[test]
    fn push_uploads_and_deletes() {
        let s = FakeServer::new();
        let a = tmpdir("a").join("p");
        project(&a, &[("aaaaaa", "1")]);
        let mut sa = sync_of(&a, &s, "a");
        sa.export_all().unwrap();
        w(&a, "Главы/aaaaaa.md", "1 2");
        let res = sa.push(&["Главы/aaaaaa.md".to_string(), "kabinet.lock".to_string()]).unwrap();
        assert_eq!(res.pushed, vec!["Главы/aaaaaa.md".to_string()]);
        assert_eq!(s.get("Кабинет/Роман/Главы/aaaaaa.md").unwrap(), b"1 2");
        fs::remove_file(a.join("Главы/aaaaaa.md")).unwrap();
        let res = sa.push(&["Главы/aaaaaa.md".to_string()]).unwrap();
        assert_eq!(res.removed.len(), 1);
        assert!(s.get("Кабинет/Роман/Главы/aaaaaa.md").is_none());
    }

    #[test]
    fn replace_all_moves_foreign_files_to_conflicts() {
        let s = FakeServer::new();
        s.put("Кабинет/Роман/project.json", r#"{"name":"чужой","chapters":[]}"#.as_bytes());
        s.put("Кабинет/Роман/Главы/qqqqqq.md", "чужая глава".as_bytes());
        let a = tmpdir("a").join("p");
        project(&a, &[("aaaaaa", "моя")]);
        let mut sa = sync_of(&a, &s, "a");
        assert_eq!(sa.replace_all().unwrap(), 1);
        assert!(s.get("Кабинет/Роман/Главы/qqqqqq.md").is_none());
        assert!(s.names().iter().any(|n| n.contains("Конфликты/") && n.contains("(было в папке)")));
        assert_eq!(s.get("Кабинет/Роман/Главы/aaaaaa.md").unwrap(), "моя".as_bytes());
    }

    #[test]
    fn image_folders_keep_syncable_path_filters() {
        for folder in ["Картинки", "Изображения"] {
            assert!(is_syncable(&format!("{folder}/abcdef.png")));
            assert!(!is_syncable(&format!("{folder}/.hidden.png")));
            assert!(!is_syncable(&format!("{folder}/abcdef.png.tmp")));
            assert!(!is_syncable(&format!("{folder}/nested/abcdef.png")));
        }
    }

    #[test]
    fn added_tauri_image_survives_export_import_and_incremental_sync() {
        let s = FakeServer::new();
        let base = tmpdir("image-roundtrip");
        let a = base.join("a");
        project(&a, &[("aaaaaa", "текст")]);
        let source = base.join("source.png");
        let bytes = b"\x89PNG\r\n\x1a\n\x00\xff";
        fs::write(&source, bytes).unwrap();
        let file = crate::store::add_image(&a, &source).unwrap();
        let rel = format!("Картинки/{file}");
        let expected = crate::store::read_image(&a, &file).unwrap();
        assert!(walk_local(&a).unwrap().contains_key(&rel));
        let mut sa = sync_of(&a, &s, "image-a");
        assert!(sa.export_all().unwrap().contains(&rel));
        assert_eq!(s.get(&format!("Кабинет/Роман/{rel}")).unwrap(), bytes);
        let b = base.join("b");
        let mut sb = sync_of(&b, &s, "image-b");
        assert!(sb.import_all().unwrap().contains(&rel));
        assert_eq!(crate::store::read_image(&b, &file).unwrap(), expected);
        let updated = b"\x89PNG\r\n\x1a\n\x00\xfe\x01";
        fs::write(a.join(&rel), updated).unwrap();
        assert!(sa.push(&[rel.clone()]).unwrap().pushed.contains(&rel));
        assert!(sb.sync().unwrap().pulled.contains(&rel));
        assert_eq!(fs::read(b.join(&rel)).unwrap(), updated);
        assert_eq!(crate::store::read_image(&b, &file).unwrap(), crate::store::read_image(&a, &file).unwrap());
    }

    #[test]
    fn both_image_folders_preserve_distinct_files_with_the_same_name() {
        let s = FakeServer::new();
        let base = tmpdir("image-compat");
        let a = base.join("a");
        project(&a, &[("aaaaaa", "текст")]);
        for folder in ["Картинки", "Изображения"] { fs::create_dir_all(a.join(folder)).unwrap(); }
        fs::write(a.join("Картинки/abcdef.png"), b"\x00\xfftauri").unwrap();
        fs::write(a.join("Изображения/abcdef.png"), b"\x00\xfeexisting").unwrap();
        let mut sa = sync_of(&a, &s, "compat-a");
        sa.export_all().unwrap();
        let b = base.join("b");
        let mut sb = sync_of(&b, &s, "compat-b");
        sb.import_all().unwrap();
        for folder in ["Картинки", "Изображения"] {
            let rel = format!("{folder}/abcdef.png");
            assert_eq!(fs::read(b.join(&rel)).unwrap(), fs::read(a.join(&rel)).unwrap());
            assert_eq!(s.get(&format!("Кабинет/Роман/{rel}")).unwrap(), fs::read(a.join(&rel)).unwrap());
        }
        let res = sb.sync().unwrap();
        assert!(res.conflicts.is_empty() && res.pulled.is_empty() && res.pushed.is_empty());
    }
}
