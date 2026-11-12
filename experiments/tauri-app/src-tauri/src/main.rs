#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// Кабинет на Tauri: этап 1 — ядро (проекты, главы, корзина, недавние). Интерфейс тот же, что в Electron-версии;
// он вызывает единственную команду `call(channel, args)`, как раньше ipcRenderer.invoke(channel, ...args).
use kabinet_core::davapi::DavApi;
use kabinet_core::davlink::{DavLink, Event, Secret};
use kabinet_core::{export, exporttarget, store};
use kabinet_core::webdav::{Http, Retrying, UreqHttp};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};

/// Пароль облака лежит в связке ключей системы; в файле связей остаётся только ссылка «kr:…».
struct KeyringSecret;

#[cfg(any(windows, target_os = "macos"))]
impl Secret for KeyringSecret {
    fn seal(&self, key: &str, pass: &str) -> Result<String, String> {
        let e = keyring::Entry::new("Кабинет: сетевая папка", key).map_err(|e| e.to_string())?;
        e.set_password(pass).map_err(|e| format!("Не удалось сохранить пароль в защищённом хранилище системы: {}", e))?;
        Ok(format!("kr:{}", key))
    }
    fn open(&self, key: &str, sealed: &str) -> Result<String, String> {
        if !sealed.starts_with("kr:") { return Err("Пароль не найден в защищённом хранилище.".into()); }
        keyring::Entry::new("Кабинет: сетевая папка", key).and_then(|e| e.get_password()).map_err(|e| e.to_string())
    }
    fn forget(&self, key: &str) {
        if let Ok(e) = keyring::Entry::new("Кабинет: сетевая папка", key) { let _ = e.delete_credential(); }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
impl Secret for KeyringSecret {
    fn seal(&self, _key: &str, _pass: &str) -> Result<String, String> { Err("Безопасное хранилище паролей на этой системе пока не подключено.".into()) }
    fn open(&self, _key: &str, _sealed: &str) -> Result<String, String> { Err("Безопасное хранилище паролей на этой системе пока не подключено.".into()) }
}

fn device_name() -> String {
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).or_else(|_| std::env::var("HOST")).unwrap_or_else(|_| "Компьютер".into())
}

fn open_path(p: &Path) {
    #[cfg(windows)] { let _ = std::process::Command::new("explorer").arg(p).spawn(); }
    #[cfg(target_os = "macos")] { let _ = std::process::Command::new("open").arg(p).spawn(); }
    #[cfg(not(any(windows, target_os = "macos")))] { let _ = std::process::Command::new("xdg-open").arg(p).spawn(); }
}

fn reveal(p: &Path) {
    #[cfg(windows)] { let _ = std::process::Command::new("explorer").arg(format!("/select,{}", p.display())).spawn(); }
    #[cfg(target_os = "macos")] { let _ = std::process::Command::new("open").arg("-R").arg(p).spawn(); }
    #[cfg(not(any(windows, target_os = "macos")))] { if let Some(d) = p.parent() { open_path(d); } }
}

/// Остановить обмен с облаком прежнего проекта (с дозаписью) и запустить для нового, если он связан.
async fn switch_sync(dav: &Arc<DavApi>, dir: Option<PathBuf>) {
    let d = dav.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        d.link.stop();
        if let Some(dir) = dir { d.link.start(&dir); }
    }).await;
}

#[derive(Default)]
struct AppState {
    current: Mutex<Option<PathBuf>>,
}

fn arg_str(args: &[Value], i: usize) -> Result<String, String> {
    match args.get(i) {
        Some(Value::String(s)) => Ok(s.clone()),
        Some(Value::Number(n)) => Ok(n.to_string()),
        _ => Err("Неверные параметры вызова.".to_string()),
    }
}

fn arg_opt_str(args: &[Value], i: usize) -> Option<String> {
    args.get(i).and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn recents_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("Нет папки данных приложения: {}", e))?;
    Ok(dir.join("recents.json"))
}

fn current_dir(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    state.current.lock().map_err(|_| "Внутренняя ошибка состояния.".to_string())?
        .clone().ok_or_else(|| "Проект не открыт.".to_string())
}

fn set_current(state: &State<'_, AppState>, dir: Option<PathBuf>) {
    if let Ok(mut g) = state.current.lock() { *g = dir; }
}

async fn open_at(app: &tauri::AppHandle, state: &State<'_, AppState>, dav: &Arc<DavApi>, dir: &Path) -> Result<Value, String> {
    let proj = store::open_project(dir)?;
    set_current(state, Some(dir.to_path_buf()));
    switch_sync(dav, Some(dir.to_path_buf())).await;
    let name = proj["name"].as_str().unwrap_or("");
    store::recents_add(&recents_file(app)?, &dir.to_string_lossy(), name)?;
    Ok(proj)
}

async fn pick_folder(title: &str) -> Option<PathBuf> {
    rfd::AsyncFileDialog::new().set_title(title).pick_folder().await.map(|h| h.path().to_path_buf())
}

#[tauri::command]
async fn call(app: tauri::AppHandle, state: State<'_, AppState>, dav: State<'_, Arc<DavApi>>, channel: String, args: Vec<Value>) -> Result<Value, String> {
    let a = &args;
    let dav: Arc<DavApi> = dav.inner().clone();
    match channel.as_str() {
        "app:version" => Ok(json!(env!("CARGO_PKG_VERSION"))),
        "app:setLang" | "ui:setTheme" | "app:about" => Ok(json!(true)),
        "recents:list" => Ok(store::recents_list(&recents_file(&app)?)),
        "recents:remove" => { store::recents_remove(&recents_file(&app)?, &arg_str(a, 0)?)?; Ok(json!(true)) }
        "project:current" => match state.current.lock().map_err(|_| "Внутренняя ошибка состояния.".to_string())?.clone() {
            Some(dir) => store::open_project(&dir),
            None => Ok(Value::Null),
        },
        "project:create" => {
            let name = arg_str(a, 0)?;
            let folder = store::safe_folder_name(&name)?;
            let Some(parent) = pick_folder("Где создать проект?").await else { return Ok(Value::Null) };
            let dir = parent.join(folder);
            let proj = store::create_project(&dir, &name, arg_opt_str(a, 1).as_deref())?;
            set_current(&state, Some(dir.clone()));
            switch_sync(&dav, None).await;
            store::recents_add(&recents_file(&app)?, &dir.to_string_lossy(), proj["name"].as_str().unwrap_or(""))?;
            Ok(proj)
        }
        "project:openDialog" => {
            let Some(dir) = pick_folder("Открыть проект: выберите папку, в которой лежит project.json").await else { return Ok(Value::Null) };
            open_at(&app, &state, &dav, &dir).await
        }
        "project:openRecent" => {
            let p = arg_str(a, 0)?;
            if !store::recents_has(&recents_file(&app)?, &p) { return Err("Этого проекта нет в списке недавних.".into()); }
            open_at(&app, &state, &dav, Path::new(&p)).await
        }
        "project:close" => { set_current(&state, None); switch_sync(&dav, None).await; Ok(json!(true)) }
        "project:reload" => store::open_project(&current_dir(&state)?),
        "chapter:add" => store::add_chapter(&current_dir(&state)?, arg_opt_str(a, 0).as_deref()),
        "chapter:rename" => store::rename_chapter(&current_dir(&state)?, &arg_str(a, 0)?, &arg_str(a, 1)?),
        "chapter:move" => store::move_chapter(&current_dir(&state)?, &arg_str(a, 0)?, a.get(1).and_then(|v| v.as_f64()).unwrap_or(0.0)),
        "chapter:setGoal" => store::set_chapter_goal(&current_dir(&state)?, &arg_str(a, 0)?, a.get(1)),
        "chapter:setMarker" => store::set_chapter_marker(&current_dir(&state)?, &arg_str(a, 0)?, arg_opt_str(a, 1).as_deref()),
        "project:setDefaultGoal" => store::set_default_goal(&current_dir(&state)?, a.get(0)),
        "chapter:delete" => store::delete_chapter(&current_dir(&state)?, &arg_str(a, 0)?),
        "chapter:read" => Ok(json!(store::read_chapter(&current_dir(&state)?, &arg_str(a, 0)?)?)),
        "chapter:write" => store::write_chapter(&current_dir(&state)?, &arg_str(a, 0)?, &arg_str(a, 1).unwrap_or_default()),
        "project:stats" => store::project_stats(&current_dir(&state)?),
        "cards:index" => store::card_index(&current_dir(&state)?),
        "item:add" => store::add_item(&current_dir(&state)?, &arg_str(a, 0)?, arg_opt_str(a, 1).as_deref()),
        "item:rename" => store::rename_item(&current_dir(&state)?, &arg_str(a, 0)?, &arg_str(a, 1)?, &arg_str(a, 2)?),
        "item:move" => store::move_item(&current_dir(&state)?, &arg_str(a, 0)?, &arg_str(a, 1)?, a.get(2).and_then(|v| v.as_f64()).unwrap_or(0.0)),
        "item:setIcon" => store::set_item_icon(&current_dir(&state)?, &arg_str(a, 0)?, &arg_str(a, 1)?, a.get(2)),
        "item:delete" => store::delete_item(&current_dir(&state)?, &arg_str(a, 0)?, &arg_str(a, 1)?),
        "item:read" => Ok(json!(store::read_item(&current_dir(&state)?, &arg_str(a, 0)?, &arg_str(a, 1)?)?)),
        "item:write" => store::write_item(&current_dir(&state)?, &arg_str(a, 0)?, &arg_str(a, 1)?, &arg_str(a, 2)?),
        "project:setTemplate" => store::set_template(&current_dir(&state)?, &arg_str(a, 0)?, a.get(1)),
        "chapter:readMeta" => store::read_chapter_meta(&current_dir(&state)?, &arg_str(a, 0)?),
        "chapter:writeMeta" => store::write_chapter_meta(&current_dir(&state)?, &arg_str(a, 0)?, a.get(1).unwrap_or(&Value::Null)),
        "project:setProjectGoal" => store::set_project_goal(&current_dir(&state)?, a.get(0)),
        "project:setDeadline" => store::set_project_deadline(&current_dir(&state)?, a.get(0)),
        "project:setMode" => store::set_project_mode(&current_dir(&state)?, arg_opt_str(a, 0).as_deref()),
        "project:setGoalUnit" => store::set_goal_unit(&current_dir(&state)?, arg_opt_str(a, 0).as_deref()),
        "project:setCharLimit" => store::set_char_limit(&current_dir(&state)?, a.get(0)),
        "project:board" => store::board_data(&current_dir(&state)?),
        "image:read" => store::read_image(&current_dir(&state)?, &arg_str(a, 0)?),
        "fonts:list" => Ok(json!([])),
        "trash:restore" => store::restore_trash(&current_dir(&state)?, &arg_str(a, 0)?),
        "trash:purge" => store::purge_trash(&current_dir(&state)?, &arg_str(a, 0)?),
        "trash:empty" => store::empty_trash(&current_dir(&state)?),
        "project:export" => {
            let dir = current_dir(&state)?;
            let opts = a.first().cloned().unwrap_or(Value::Null);
            let indent = opts["indent"].as_bool().unwrap_or(false);
            let numbers = opts["chapterNumbers"].as_bool() == Some(true);
            let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
            let docs = app.path().document_dir().unwrap_or_else(|_| dir.clone());
            let default = exporttarget::default_path(&data, &dir, &docs);
            let mut dlg = rfd::AsyncFileDialog::new().set_title("Экспорт проекта").set_directory(default.parent().unwrap_or(&docs))
                .set_file_name(default.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
            for (ext, name) in exporttarget::filters(&default) { dlg = dlg.add_filter(name, &[ext]); }
            let Some(picked) = dlg.save_file().await else { return Ok(Value::Null) };
            let mut file = picked.path().to_path_buf();
            let mut ext = file.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
            if !exporttarget::FORMATS.contains(&ext.as_str()) { ext = "docx".into(); file.set_extension("docx"); }
            let lang = "ru".to_string();
            let d2 = dir.clone();
            let ext2 = ext.clone();
            let bytes = tauri::async_runtime::spawn_blocking(move || export::build_export(&d2, &ext2, &lang, indent, numbers))
                .await.map_err(|e| e.to_string())??;
            store::write_atomic_bytes(&file, &bytes)?;
            let _ = exporttarget::remember(&data, &dir, &file);
            reveal(&file);
            Ok(json!(file.to_string_lossy()))
        }
        "dav:open" => {
            let (session, root) = (arg_str(a, 0)?, arg_str(a, 1)?);
            let Some(parent) = pick_folder("Где сохранить копию проекта на этом компьютере?").await else { return Ok(Value::Null) };
            let (acc, target) = dav.open_target(&session, &root, &parent)?;
            set_current(&state, None);
            switch_sync(&dav, None).await;
            let d = dav.clone();
            let t = target.clone();
            tauri::async_runtime::spawn_blocking(move || d.link.open_remote(&acc, &t)).await.map_err(|e| e.to_string())??;
            open_at(&app, &state, &dav, &target).await
        }
        "dav:info" => {
            let dir = state.current.lock().ok().and_then(|g| g.clone());
            let mut text = String::new();
            if dir.is_some() { text.push_str("Сейчас проект лежит на этом компьютере. Чтобы он синхронизировался, выберите «Файл → Синхронизация…».\n\n"); }
            text.push_str("Облако без установки программ: подключает Яндекс Диск, Mail.ru, Nextcloud и другие серверы WebDAV по логину и паролю приложения. Проект остаётся на этом компьютере, а его копия синхронизируется с облаком; на телефоне в Кабинете для Android подключается тот же сервер.\n\nПравки с обеих сторон сохраняются: если один и тот же текст изменили на двух устройствах, чужая версия сохраняется в папке «Конфликты».\n\nСовет: работайте на одном устройстве за раз и закрывайте проект перед переходом на другое, чтобы облако успело всё передать.");
            let buttons = if dir.is_some() { rfd::MessageButtons::OkCancelCustom("OK".into(), "Открыть папку «Конфликты»".into()) } else { rfd::MessageButtons::Ok };
            let res = rfd::AsyncMessageDialog::new().set_title("Синхронизация").set_description(text).set_buttons(buttons).show().await;
            if let (Some(dir), rfd::MessageDialogResult::Custom(c)) = (dir, res) {
                if c.starts_with("Открыть") {
                    let f = dir.join("Конфликты");
                    let _ = std::fs::create_dir_all(&f);
                    open_path(&f);
                }
            }
            Ok(json!(true))
        }
        other if other.starts_with("dav:") => {
            let op = other[4..].to_string();
            let cur = state.current.lock().ok().and_then(|g| g.clone());
            let args = args.clone();
            tauri::async_runtime::spawn_blocking(move || dav.call(&op, &args, cur.as_deref())).await.map_err(|e| e.to_string())?
        }
        other => Err(format!("Эта функция пока не перенесена в версию на Tauri: {}", other)),
    }
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .setup(|app| {
            let data = app.path().app_data_dir().map_err(|e| format!("Нет папки данных приложения: {}", e))?;
            let handle = app.handle().clone();
            let on_event = Arc::new(move |e: Event| match e {
                Event::Conflict => { let _ = handle.emit("dav:event", json!({ "type": "conflict" })); }
                Event::Error(m) => { let _ = handle.emit("dav:event", json!({ "type": "error", "message": m })); }
                Event::Changed(files) => { let _ = handle.emit("sync:changed", files); }
            });
            let link = DavLink::new(&data, Arc::new(KeyringSecret), &device_name(),
                Arc::new(|| Box::new(Retrying::new(UreqHttp::new())) as Box<dyn Http>), on_event);
            app.manage(Arc::new(DavApi::new(link)));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(d) = window.app_handle().try_state::<Arc<DavApi>>() { d.link.stop(); }
            }
        })
        .invoke_handler(tauri::generate_handler![call])
        .run(tauri::generate_context!())
        .expect("не удалось запустить Кабинет на Tauri");
}
