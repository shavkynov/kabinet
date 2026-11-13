//! Двусторонняя синхронизация проекта с внешней папкой. Порт src/folder.js.
//! Правило: ничего не затираем молча. Для каждого файла хранится хэш последней согласованной
//! версии; при правках с обеих сторон чужая версия уходит в «Конфликты».
use crate::remote::Remote;
use crate::store::{write_atomic_bytes, R};
use crate::syncguard::{extname, safe_name, stamp_now, stem, CONFLICT_DIR};
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

pub fn is_syncable(rel: &str) -> bool {
    let parts: Vec<&str> = rel.split('/').filter(|x| !x.is_empty()).collect();
    let Some(name) = parts.last() else { return false };
    if name.starts_with('.') || name.ends_with(".tmp") { return false; }
    if parts.len() == 1 { return root_re().is_match(name); }
    parts.len() == 2 && FOLDERS.contains(&parts[0])
}

pub fn hash_bytes(b: &[u8]) -> String {
    let mut h = Sha1::new();
    h.update(b);
    h.finalize().iter().map(|x| format!("{:02x}", x)).collect()
}

/// Снимок локального проекта: относительный путь → хэш.
pub fn walk_local(dir: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut add = |rel: String| { if let Ok(b) = fs::read(dir.join(&rel)) { out.insert(rel, hash_bytes(&b)); } };
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if e.path().is_file() && is_syncable(&name) { add(name); }
        }
    }
    for folder in FOLDERS {
        if let Ok(rd) = fs::read_dir(dir.join(folder)) {
            for e in rd.flatten() {
                let name = format!("{}/{}", folder, e.file_name().to_string_lossy());
                if e.path().is_file() && is_syncable(&name) { add(name); }
            }
        }
    }
    out
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
        let name = format!("{} {} ({}){}", stamp_now(), safe_name(label), suffix, extname(rel));
        let rel_conflict = format!("{}/{}", CONFLICT_DIR, name);
        self.write_local(&rel_conflict, bytes)?;
        let pushed = self.remote.mkdir(CONFLICT_DIR).and_then(|_| self.remote.write(&rel_conflict, bytes));
        if pushed.is_ok() { self.state.insert(rel_conflict, hash_bytes(bytes)); }
        Ok(name)
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
        for rel in &dropped { let _ = fs::remove_file(self.dir.join(rel)); local.remove(rel); }
        let out = if !added.is_empty() || !trash_extra.is_empty() { serde_json::to_string_pretty(&Value::Object(merged)).unwrap().into_bytes() } else { remote_raw };
        self.write_local("project.json", &out)?;
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
        let mut local = walk_local(&self.dir);
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
                        self.remote.write(rel, &data)?;
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
                    let mine = self.read_local(rel)?;
                    let with_words = if rel == "project.json" { merge_meta_words(&mine, &foreign) } else { None };
                    if let Some(w) = &with_words { self.write_local(rel, w)?; }
                    let now_local = self.read_local(rel)?;
                    self.remote.write(rel, &now_local)?;
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
                    if let Some((parent, _)) = rel.rsplit_once('/') { self.remote.mkdir(parent)?; }
                    let data = self.read_local(rel)?;
                    self.remote.write(rel, &data)?;
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
        let local = walk_local(&self.dir);
        let mut hidden = 0;
        for (rel, e) in &remote {
            if local.contains_key(rel) || rel.starts_with(&format!("{}/", CONFLICT_DIR)) { continue; }
            let name = format!("{} {} (было в папке){}", stamp_now(), safe_name(&label_of(rel)), extname(rel));
            self.remote.mkdir(CONFLICT_DIR)?;
            self.remote.write(&format!("{}/{}", CONFLICT_DIR, name), e.bytes.as_deref().unwrap_or(&[]))?;
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
        let local = walk_local(&self.dir);
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
        assert!(walk_local(&a).contains_key(&rel));
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
