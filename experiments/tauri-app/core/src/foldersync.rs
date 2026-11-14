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
            match fs::metadata(entry.path()) {
                Ok(m) => out.push((name, m.is_file())),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {} // исчез по дороге (или битая ссылка)
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
    }
    /// Вторая точка: в write_checked перед проверкой версии в облаке (имитирует запись с другого устройства).
    pub fn set_remote<F: FnOnce() + 'static>(f: F) { REMOTE_HOOK.with(|h| *h.borrow_mut() = Some(Box::new(f))); }
    pub fn fire_remote() {
        let hook = REMOTE_HOOK.with(|h| h.borrow_mut().take());
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
    pub fn new(dir: &Path, remote: T, state_file: Option<PathBuf>) -> Self {
        let mut s = FolderSync { dir: dir.to_path_buf(), remote, state_file, state: BTreeMap::new(), cache: HashMap::new() };
        s.load();
        s
    }

    fn cache_file(&self) -> Option<PathBuf> { self.state_file.as_ref().map(|p| PathBuf::from(format!("{}.cache", p.display()))) }

    fn load(&mut self) {
        if let Some(f) = &self.state_file {
            if let Ok(raw) = fs::read_to_string(f) {
                if let Ok(Value::Object(o)) = serde_json::from_str::<Value>(&raw) {
                    for (k, v) in o { if let Some(s) = v.as_str() { self.state.insert(k, s.to_string()); } }
                }
            }
        }
        let Some(cf) = self.cache_file() else { return };
        let Ok(raw) = fs::read_to_string(cf) else { return };
        let Ok(v) = serde_json::from_str::<Value>(&raw) else { return };
        if v.get("version").and_then(|x| x.as_i64()) != Some(1) { return; }
        let Some(files) = v.get("files").and_then(|x| x.as_object()) else { return };
        let sig_re = Regex::new(r"^\d+:\d+$").unwrap();
        let hash_re = Regex::new(r"^[a-f0-9]{40}$").unwrap();
        for (rel, e) in files {
            let (Some(sig), Some(hash)) = (e.get("sig").and_then(|x| x.as_str()), e.get("hash").and_then(|x| x.as_str())) else { continue };
            if !is_syncable(rel) || !sig_re.is_match(sig) || !hash_re.is_match(hash) || self.state.get(rel).map(|s| s.as_str()) != Some(hash) { continue; }
            self.cache.insert(rel.clone(), (sig.to_string(), hash.to_string()));
        }
    }

    fn save(&self) {
        let Some(f) = &self.state_file else { return };
        if let Some(p) = f.parent() { let _ = fs::create_dir_all(p); }
        let st: serde_json::Map<String, Value> = self.state.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
        let _ = write_atomic_bytes(f, serde_json::to_string_pretty(&Value::Object(st)).unwrap().as_bytes());
        if let Some(cf) = self.cache_file() {
            let files: serde_json::Map<String, Value> = self.cache.iter()
                .filter(|(rel, e)| self.state.get(*rel) == Some(&e.1))
                .map(|(rel, e)| (rel.clone(), json!({ "sig": e.0, "hash": e.1 }))).collect();
            let _ = write_atomic_bytes(&cf, serde_json::to_string_pretty(&json!({ "version": 1, "files": files })).unwrap().as_bytes());
        }
    }

    pub fn state(&self) -> BTreeMap<String, String> { self.state.clone() }

    fn read_local(&self, rel: &str) -> R<Vec<u8>> { fs::read(self.dir.join(rel)).map_err(|e| format!("{}: {}", rel, e)) }

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
    fn keep(&mut self, rel: &str, bytes: &[u8], label: &str, suffix: &str) -> R<String> {
        // Имя должно подойти и у нас, и в папке: другая версия под тем же именем (та же секунда) не затирается,
        // тогда берётся имя с SHA-256. Проверка папки идёт без замка: сеть под замком не держим.
        let candidates: Vec<String> = conflict_names(&now_local(), label, suffix, &extname(rel), bytes).into_iter()
            .filter(|name| !matches!(self.remote.read(&format!("{}/{}", CONFLICT_DIR, name)), Ok(Some(b)) if b.as_slice() != bytes))
            .collect();
        let name = save_conflict_copy(&self.dir.join(CONFLICT_DIR), &candidates, bytes)?;
        let rel_conflict = format!("{}/{}", CONFLICT_DIR, name);
        let pushed = self.remote.mkdir(CONFLICT_DIR).and_then(|_| self.remote.write(&rel_conflict, bytes));
        if pushed.is_ok() { self.state.insert(rel_conflict, hash_bytes(bytes)); }
        Ok(name)
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
        self.remote.write(rel, data)
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
                    let t = self.read_local(&rel).map(|b| text(&b)).unwrap_or_default();
                    if t.trim().is_empty() { dropped.push(rel); continue; }
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
                .map(|id| self.read_local(&format!("Главы/{}.md", id)).map(|b| !text(&b).trim().is_empty()).unwrap_or(false)).unwrap_or(false))
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
            let still_empty = self.read_local(rel).map(|b| text(&b).trim().is_empty()).unwrap_or(true);
            if still_empty { let _ = fs::remove_file(self.dir.join(rel)); local.remove(rel); }
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
            self.write_local("stats.json", &raw?)?;
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
                        let _ = fs::remove_file(self.dir.join(rel));
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
                    // Перед удалением перечитаем файл: сохранение во время прохода могло изменить его.
                    let _guard = crate::store::sync_save_lock().lock().map_err(|_| "Внутренний замок сохранения недоступен.".to_string())?;
                    if let Some(fresh) = self.local_hash(rel)? {
                        if fresh != lh {
                            local.insert(rel.clone(), fresh);
                            continue;
                        }
                    }
                    let _ = fs::remove_file(self.dir.join(rel));
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
        self.save();
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
            if let (Some(rh), Some(b)) = (&r, &bytes) {
                if self.state.get(rel) != Some(rh) { self.keep_foreign(rel, b, &label_of(rel))?; res.conflicts.push(rel.clone()); }
            }
            if let Some((parent, _)) = rel.rsplit_once('/') { self.remote.mkdir(parent)?; }
            self.remote.write(rel, &data)?;
            self.state.insert(rel.clone(), l);
            res.pushed.push(rel.clone());
        }
        self.save();
        Ok(res)
    }

    fn after_local_delete(&mut self, rel: &str, res: &mut SyncResult) -> R<()> {
        let bytes = self.remote.read(rel).ok().flatten();
        if let Some(b) = bytes {
            if Some(&hash_bytes(&b)) != self.state.get(rel) { self.keep_foreign(rel, &b, &label_of(rel))?; res.conflicts.push(rel.to_string()); }
        }
        let _ = self.remote.remove(rel);
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
        self.save();
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
        self.save();
        Ok(local.keys().cloned().collect())
    }

    pub fn reset(&mut self) { self.state.clear(); self.cache.clear(); self.save(); }
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
    fn sync_of(dir: &Path, s: &FakeServer, st: &str) -> FolderSync<crate::webdav::WebDav<FakeServer>> {
        FolderSync::new(dir, dav_on(s, "/Кабинет/Роман"), Some(dir.parent().unwrap().join(format!("{}.state", st))))
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
