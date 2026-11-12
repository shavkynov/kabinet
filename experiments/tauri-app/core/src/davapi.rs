//! Каналы `dav:*` окна: вход, выбор папки, подключение проекта. Порт обработчиков из main.js.
//! Пароль окну не отдаётся: после входа остаётся только номер сеанса.
use crate::davlink::{Acc, DavLink};
use crate::store::{safe_folder_name, R};
use crate::webdav::PRESETS;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct DavApi {
    pub link: DavLink,
    sessions: Mutex<HashMap<String, Acc>>,
}

fn s(args: &[Value], i: usize) -> String { args.get(i).and_then(|v| v.as_str()).unwrap_or("").to_string() }

impl DavApi {
    pub fn new(link: DavLink) -> Self { DavApi { link, sessions: Mutex::new(HashMap::new()) } }

    fn new_session(&self, mut acc: Acc, label: &str) -> String {
        let id: String = (0..8).map(|_| format!("{:02x}", rand::random::<u8>())).collect();
        acc.label = label.to_string();
        self.sessions.lock().unwrap().insert(id.clone(), acc);
        id
    }

    fn session(&self, id: &str) -> R<Acc> {
        self.sessions.lock().unwrap().get(id).cloned().ok_or_else(|| "Вход устарел. Войдите заново.".to_string())
    }

    pub fn presets() -> Value {
        Value::Array(PRESETS.iter().map(|p| json!({ "id": p.id, "name": p.name, "url": p.url, "hint": p.hint })).collect())
    }

    /// Обычные каналы. `cur` — открытый проект. Каналы «open» и «info» требуют окон выбора и разбираются снаружи.
    pub fn call(&self, op: &str, a: &[Value], cur: Option<&Path>) -> R<Value> {
        let need = || cur.ok_or_else(|| "Проект не открыт.".to_string());
        match op {
            "presets" => Ok(Self::presets()),
            "saved" => Ok(Value::Array(self.link.logins().iter().enumerate().map(|(i, l)| json!({
                "index": i, "label": l["label"], "user": l["user"], "url": l["url"] })).collect())),
            "useSaved" => {
                let logins = self.link.logins();
                let l = a.first().and_then(|v| v.as_u64()).and_then(|i| logins.get(i as usize)).ok_or("Сохранённый вход не найден.")?;
                let label = l["label"].as_str().unwrap_or("").to_string();
                let acc = Acc { url: l["url"].as_str().unwrap_or("").into(), user: l["user"].as_str().unwrap_or("").into(), pass: l["pass"].as_str().unwrap_or("").into(), ..Default::default() };
                Ok(json!({ "session": self.new_session(acc, &label), "label": label }))
            }
            "login" => {
                let form = a.first().cloned().unwrap_or(Value::Null);
                let id = form["preset"].as_str().unwrap_or("");
                let preset = PRESETS.iter().find(|p| p.id == id).unwrap_or(&PRESETS[PRESETS.len() - 1]);
                let url = if preset.url.is_empty() { form["url"].as_str().unwrap_or("") } else { preset.url };
                let (user, pass) = (form["user"].as_str().unwrap_or(""), form["pass"].as_str().unwrap_or(""));
                if user.is_empty() || pass.is_empty() { return Err("Введите логин и пароль.".into()); }
                let acc = self.link.login(url, user, pass)?;
                Ok(json!({ "session": self.new_session(acc, preset.name), "label": preset.name }))
            }
            "browse" => {
                let acc = self.session(&s(a, 0))?;
                let at = s(a, 1);
                let at_clean = if at == "/" { String::new() } else { at.clone() };
                Ok(json!({ "path": if at.is_empty() { "/".to_string() } else { at }, "folders": self.link.browse(&acc, &at_clean)? }))
            }
            "mkdir" => {
                let acc = self.session(&s(a, 0))?;
                let at = s(a, 1);
                Ok(json!(self.link.make_folder(&acc, if at == "/" { "" } else { &at }, &s(a, 2))?))
            }
            "attach" => {
                let dir = need()?;
                let mut acc = self.session(&s(a, 0))?;
                acc.root = s(a, 1);
                if acc.root.is_empty() { return Err("Выберите папку.".into()); }
                let mode = { let m = s(a, 2); if m.is_empty() { "ask".to_string() } else { m } };
                self.link.attach(dir, &acc, &mode)
            }
            "status" => Ok(self.link.status(cur)),
            "syncNow" => self.link.sync_now(),
            "detach" => { self.link.detach(need()?)?; Ok(json!(true)) }
            other => Err(format!("Неизвестная операция синхронизации: {}", other)),
        }
    }

    /// Куда положить копию облачного проекта: «parent/Имя», при занятом имени — «Имя 2», «Имя 3»…
    pub fn open_target(&self, session: &str, root: &str, parent: &Path) -> R<(Acc, PathBuf)> {
        let mut acc = self.session(session)?;
        acc.root = root.to_string();
        let last = root.split('/').filter(|x| !x.is_empty()).last().unwrap_or("Проект");
        let name = safe_folder_name(last)?;
        let mut target = parent.join(&name);
        let mut i = 2;
        while target.exists() { target = parent.join(format!("{} {}", name, i)); i += 1; }
        Ok((acc, target))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::davlink::PlainSecret;
    use crate::testutil::*;
    use crate::webdav::Http;
    use std::sync::Arc;

    fn api(s: &FakeServer, data: &Path) -> DavApi {
        let s = s.clone();
        DavApi::new(DavLink::new(data, Arc::new(PlainSecret), "Т", Arc::new(move || Box::new(s.clone()) as Box<dyn Http>), Arc::new(|_| {})))
    }

    #[test]
    fn login_browse_attach_flow() {
        let s = FakeServer::new();
        s.put("Кабинет/старый/project.json", b"{}");
        let a = api(&s, &tmpdir("data"));
        assert!(a.call("login", &[json!({ "preset": "other", "url": "https://dav.example.com", "user": "", "pass": "" })], None).is_err());
        let r = a.call("login", &[json!({ "preset": "other", "url": "https://dav.example.com", "user": "u", "pass": "p" })], None).unwrap();
        let id = r["session"].as_str().unwrap().to_string();
        assert!(r.get("pass").is_none());
        let b = a.call("browse", &[json!(id), json!("/")], None).unwrap();
        assert_eq!(b["folders"][0]["name"], json!("Кабинет"));
        assert_eq!(a.call("mkdir", &[json!(id), json!("/Кабинет"), json!("Новый")], None).unwrap(), json!("/Кабинет/Новый"));

        let dir = tmpdir("proj");
        std::fs::write(dir.join("project.json"), r#"{"name":"Н","chapters":[]}"#).unwrap();
        assert!(a.call("attach", &[json!(id), json!("")], Some(&dir)).is_err());
        let v = a.call("attach", &[json!(id), json!("/Кабинет/Новый")], Some(&dir)).unwrap();
        assert_eq!(v["exists"], json!(false));
        assert_eq!(a.call("status", &[], Some(&dir)).unwrap()["linked"], json!(true));
        assert_eq!(a.call("saved", &[], None).unwrap().as_array().unwrap().len(), 1);
        a.link.stop();
        assert_eq!(a.call("detach", &[], Some(&dir)).unwrap(), json!(true));
        assert!(a.call("browse", &[json!("нет такого")], None).unwrap_err().contains("устарел"));
    }

    #[test]
    fn api_is_shareable_between_threads() {
        fn assert_ok<T: Send + Sync>() {}
        assert_ok::<DavApi>();
    }

    #[test]
    fn open_target_avoids_existing_names() {
        let s = FakeServer::new();
        let a = api(&s, &tmpdir("data"));
        let r = a.call("login", &[json!({ "preset": "other", "url": "https://dav.example.com", "user": "u", "pass": "p" })], None).unwrap();
        let id = r["session"].as_str().unwrap();
        let parent = tmpdir("parent");
        std::fs::create_dir_all(parent.join("Роман")).unwrap();
        let (_, t) = a.open_target(id, "/Кабинет/Роман", &parent).unwrap();
        assert_eq!(t, parent.join("Роман 2"));
    }
}
