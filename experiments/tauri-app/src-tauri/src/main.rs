#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// Кабинет на Tauri: этап 1 — ядро (проекты, главы, корзина, недавние). Интерфейс тот же, что в Electron-версии;
// он вызывает единственную команду `call(channel, args)`, как раньше ipcRenderer.invoke(channel, ...args).
use kabinet_core::davapi::DavApi;
use kabinet_core::davlink::{DavLink, Event, Secret};
use kabinet_core::{backup, export, exporttarget, import, mentions, searchreplace, store};
use kabinet_core::check::CheckApi;
use kabinet_core::media;
use kabinet_core::stats;
use kabinet_core::http::{Http, Retrying, UreqHttp};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;

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

/// Копия проекта в папку копий (внутри проекта или, для облачных папок, в данных приложения).
fn backup_now(app: &tauri::AppHandle, dir: &Path) -> Result<Option<String>, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    backup::make_backup(dir, &backup::backup_root(&data, dir), None)
}

/// Естественный порядок имён: «глава 2» раньше «глава 10».
fn natural_key(name: &str) -> Vec<(bool, u64, String)> {
    let mut out = Vec::new();
    let mut digits = String::new();
    let mut text = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_digit() {
            if !text.is_empty() { out.push((false, 0, std::mem::take(&mut text))); }
            digits.push(c);
        } else {
            if !digits.is_empty() { out.push((true, digits.parse().unwrap_or(0), String::new())); digits.clear(); }
            text.push(c);
        }
    }
    if !digits.is_empty() { out.push((true, digits.parse().unwrap_or(0), String::new())); }
    if !text.is_empty() { out.push((false, 0, text)); }
    out
}

/// Язык интерфейса: нужен для поиска в Википедии.
static LANG_EN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Адрес поиска для слова (поисковые системы зашиты в код: наружу открываются только они). Порт src/searchengines.js.
fn search_url(engine: &str, text: &str, en: bool) -> Option<String> {
    let q: String = text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(200).collect();
    if q.trim().is_empty() { return None; }
    let base = match engine {
        "yandex" => "https://yandex.ru/search/?text=".to_string(),
        "duckduckgo" => "https://duckduckgo.com/?q=".into(),
        "bing" => "https://www.bing.com/search?q=".into(),
        "wikipedia" => format!("https://{}.wikipedia.org/w/index.php?search=", if en { "en" } else { "ru" }),
        _ => "https://www.google.com/search?q=".into(),
    };
    Some(format!("{}{}", base, url::form_urlencoded::byte_serialize(q.as_bytes()).collect::<String>().replace('+', "%20")))
}

fn open_url(url: &str) {
    // Не через «cmd /C start»: в адресе входа Яндекса есть «&», и cmd принял бы его за конец команды.
    #[cfg(windows)] { let _ = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).spawn(); }
    #[cfg(target_os = "macos")] { let _ = std::process::Command::new("open").arg(url).spawn(); }
    #[cfg(not(any(windows, target_os = "macos")))] { let _ = std::process::Command::new("xdg-open").arg(url).spawn(); }
}

/// Пункт меню. Если сочетание клавиш система не приняла, пункт всё равно создаётся (без сочетания): меню не должно ломать запуск.
fn menu_item(app: &tauri::AppHandle, id: &str, label: &str, accel: Option<&str>) -> tauri::Result<tauri::menu::MenuItem<tauri::Wry>> {
    use tauri::menu::MenuItemBuilder;
    if let Some(a) = accel {
        if let Ok(item) = MenuItemBuilder::with_id(id, label).accelerator(a).build(app) { return Ok(item); }
    }
    MenuItemBuilder::with_id(id, label).build(app)
}

/// Главное меню, как в Electron-версии. Пункты «ui:…» передаются окну событием с тем же именем.
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{MenuBuilder, SubmenuBuilder};
    let mac = cfg!(target_os = "macos");
    let it = |id: &str, label: &str, accel: Option<&str>| menu_item(app, id, label, accel);

    let lang = SubmenuBuilder::new(app, "Язык интерфейса")
        .item(&it("lang:ru", "Русский", None)?)
        .item(&it("lang:en", "English", None)?)
        .build()?;
    let about = it("app:about", "О программе «Кабинет»", None)?;
    let backups = SubmenuBuilder::new(app, "Резервные копии")
        .item(&it("ui:backupNow", "Сделать копию сейчас", None)?)
        .item(&it("backup:restore", "Восстановить из копии…", None)?)
        .item(&it("backup:info", "Где хранятся копии…", None)?)
        .item(&it("ui:openBackups", "Открыть папку копий", None)?)
        .build()?;

    let mut file = SubmenuBuilder::new(app, "Файл")
        .item(&it("ui:newProject", "Новый проект…", Some("CmdOrCtrl+N"))?)
        .item(&it("ui:openProject", "Открыть проект…", Some("CmdOrCtrl+O"))?)
        .item(&it("ui:importFiles", "Импорт глав…", None)?)
        .separator()
        .item(&it("ui:export", "Экспорт проекта…", Some("CmdOrCtrl+E"))?)
        .separator()
        .item(&it("ui:openTemplates", "Шаблоны карточек…", None)?)
        .item(&backups)
        .item(&it("ui:openSync", "Синхронизация…", None)?)
        .item(&it("ui:syncNow", "Синхронизировать сейчас", Some(if mac { "Cmd+Shift+S" } else { "F5" }))?)
        .separator()
        .item(&it("ui:closeProject", "Закрыть проект", Some("CmdOrCtrl+Shift+W"))?)
        .close_window_with_text("Закрыть окно");
    if !mac { file = file.separator().item(&lang).item(&about).separator().quit_with_text("Выход"); }
    let file = file.build()?;

    let edit = SubmenuBuilder::new(app, "Правка")
        .undo_with_text("Отменить")
        .redo_with_text("Повторить")
        .separator()
        .cut_with_text("Вырезать")
        .copy_with_text("Копировать")
        .paste_with_text("Вставить")
        .select_all_with_text("Выделить всё")
        .separator()
        .item(&it("ui:openCheck", "Проверить текст главы…", Some("CmdOrCtrl+Shift+L"))?)
        .item(&it("ui:toggleSpell", "Орфография при наборе вкл / выкл", None)?)
        .build()?;

    let view = SubmenuBuilder::new(app, "Вид")
        .item(&it("ui:openSearch", "Поиск по проекту…", Some("CmdOrCtrl+F"))?)
        .separator()
        .item(&it("ui:toggleSidebar", "Показать / скрыть панель глав", Some("CmdOrCtrl+\\"))?)
        .item(&it("ui:toggleFocus", "Только лист", Some("CmdOrCtrl+Shift+F"))?)
        .item(&it("ui:toggleTypewriter", "Режим «печатная машинка»", Some("CmdOrCtrl+Shift+T"))?)
        .item(&it("ui:toggleMarks", "Скрытые символы", Some("CmdOrCtrl+Shift+8"))?)
        .item(&it("ui:toggleSound", "Звуки клавиш вкл / выкл", Some("CmdOrCtrl+Shift+M"))?)
        .item(&it("ui:toggleAmbient", "Фоновый эмбиент вкл / выкл", Some("CmdOrCtrl+Shift+A"))?)
        .item(&it("ui:openSettings", "Текст и оформление…", Some("CmdOrCtrl+,"))?)
        .separator()
        .item(&it("app:fullscreen", "Полный экран", Some(if mac { "Ctrl+Cmd+F" } else { "F11" }))?)
        .build()?;

    let updates = SubmenuBuilder::new(app, "Обновления")
        .item(&it("app:updates", "Где взять новые версии…", None)?)
        .build()?;
    let window = SubmenuBuilder::new(app, "Окно").minimize_with_text("Свернуть").build()?;

    let mut menu = MenuBuilder::new(app);
    if mac {
        let app_menu = SubmenuBuilder::new(app, "Кабинет").item(&about).separator().item(&lang).separator().hide().hide_others().show_all().separator().quit().build()?;
        menu = menu.item(&app_menu);
    }
    menu.item(&file).item(&edit).item(&view).item(&updates).item(&window).build()
}

fn on_menu(app: &tauri::AppHandle, id: &str) {
    match id {
        "lang:ru" => { let _ = app.emit("ui:setLang", "ru"); }
        "lang:en" => { let _ = app.emit("ui:setLang", "en"); }
        "app:about" => {
            let text = format!("Кабинет {}\nВерсия на Tauri (Rust).\n\nРедактор для писателей: тексты лежат у вас в папке обычными файлами.", env!("CARGO_PKG_VERSION"));
            tauri::async_runtime::spawn(async move { rfd::AsyncMessageDialog::new().set_title("О программе «Кабинет»").set_description(text).show().await; });
        }
        "app:updates" => open_url("https://github.com/shavkynov/kabinet/releases"),
        "app:fullscreen" => {
            if let Some(w) = app.get_webview_window("main").or_else(|| app.webview_windows().into_values().next()) {
                let on = w.is_fullscreen().unwrap_or(false);
                let _ = w.set_fullscreen(!on);
            }
        }
        "backup:info" => {
            // Текст о месте хранения копий берётся из существующего раздела «Резервные копии».
            // Путь вычисляется ровно той же `backup_root`, что и `make_backup`, — в интерфейсе алгоритм не дублируется.
            let app2 = app.clone();
            tauri::async_runtime::spawn(async move {
                let dir = app2.state::<AppState>().current.lock().ok().and_then(|g| g.clone());
                let text = match dir {
                    Some(dir) => match app2.path().app_data_dir() {
                        Ok(data) => {
                            let folder = backup::backup_root(&data, &dir);
                            format!("Автоматические копии: до 30 на этом устройстве\n\nПапка копий: {}", folder.display())
                        }
                        Err(e) => format!("Не удалось определить папку копий: {}", e),
                    },
                    None => "Откройте проект, чтобы узнать папку его резервных копий.".to_string(),
                };
                rfd::AsyncMessageDialog::new().set_title("Резервные копии").set_description(text).show().await;
            });
        }
        "backup:restore" => {
            // Восстановление из копии без участия renderer: меню → нативный выбор копии → согласованное восстановление.
            let app2 = app.clone();
            tauri::async_runtime::spawn(async move {
                let dav = app2.state::<Arc<DavApi>>().inner().clone();
                let state = app2.state::<AppState>();
                let Ok(dir) = current_dir(&state) else { return; };
                let _ = restore_interactive(&app2, dir, dav).await;
            });
        }
        other if other.starts_with("ui:") => { let _ = app.emit(other, ()); }
        _ => {}
    }
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

/// Выбор копии нативным диалогом и согласованное восстановление (обмен на время восстановления останавливается).
async fn restore_interactive(app: &tauri::AppHandle, dir: PathBuf, dav: Arc<DavApi>) -> Result<Option<Vec<String>>, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let root = backup::backup_root(&data, &dir);
    let picked = rfd::AsyncFileDialog::new().set_title("Выберите резервную копию").set_directory(&root).pick_folder().await;
    let Some(folder) = picked else { return Ok(None) };
    let name = folder.path().file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    if name.is_empty() { return Ok(None); }
    switch_sync(&dav, None).await;
    let d = dir.clone();
    let result = tauri::async_runtime::spawn_blocking(move || backup::restore_backup(&d, &root, &name)).await.map_err(|e| e.to_string())?;
    switch_sync(&dav, Some(dir)).await;
    Ok(Some(result?))
}

#[derive(Default)]
struct AppState {
    current: Mutex<Option<PathBuf>>,
    watcher: Mutex<Option<kabinet_core::watcher::Watcher>>,
    /// Окно уже дописало несохранённое и теперь закрывается по-настоящему.
    closing: std::sync::atomic::AtomicBool,
    quit_requested: std::sync::atomic::AtomicBool,
    on_external: std::sync::OnceLock<Arc<dyn Fn(Vec<String>) + Send + Sync>>,
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
    // Наблюдатель за внешними правками файлов (облако принесло изменения, другая программа).
    if let Ok(mut w) = state.watcher.lock() {
        *w = match (&dir, state.on_external.get()) {
            (Some(d), Some(cb)) => Some(kabinet_core::watcher::Watcher::start(d, cb.clone(), std::time::Duration::from_millis(800), std::time::Duration::from_secs(5))),
            _ => None,
        };
    }
    if let Ok(mut g) = state.current.lock() { *g = dir; }
}

async fn open_at(app: &tauri::AppHandle, state: &State<'_, AppState>, dav: &Arc<DavApi>, dir: &Path) -> Result<Value, String> {
    let proj = store::open_project(dir)?;
    set_current(state, Some(dir.to_path_buf()));
    let _ = backup_now(app, dir);
    switch_sync(dav, Some(dir.to_path_buf())).await;
    let name = proj["name"].as_str().unwrap_or("");
    store::recents_add(&recents_file(app)?, &dir.to_string_lossy(), name)?;
    Ok(proj)
}

async fn pick_folder(title: &str) -> Option<PathBuf> {
    rfd::AsyncFileDialog::new().set_title(title).pick_folder().await.map(|h| h.path().to_path_buf())
}

#[tauri::command]
async fn call(app: tauri::AppHandle, state: State<'_, AppState>, dav: State<'_, Arc<DavApi>>, chk: State<'_, Arc<CheckApi>>, channel: String, args: Vec<Value>) -> Result<Value, String> {
    let a = &args;
    let dav: Arc<DavApi> = dav.inner().clone();
    match channel.as_str() {
        "app:version" => Ok(json!(env!("CARGO_PKG_VERSION"))),
        "app:close-cancel" => {
            state.quit_requested.store(false, std::sync::atomic::Ordering::SeqCst);
            state.closing.store(false, std::sync::atomic::Ordering::SeqCst);
            Ok(json!(true))
        }
        "app:exit" => {
            let d = dav.clone();
            tauri::async_runtime::spawn_blocking(move || d.link.stop()).await.map_err(|e| e.to_string())?;
            state.closing.store(true, std::sync::atomic::Ordering::SeqCst);
            if state.quit_requested.load(std::sync::atomic::Ordering::SeqCst) {
                app.exit(0);
            } else if let Some(w) = app.get_webview_window("main") {
                if let Err(e) = w.close() {
                    state.closing.store(false, std::sync::atomic::Ordering::SeqCst);
                    return Err(e.to_string());
                }
            } else { app.exit(0); }
            Ok(json!(true))
        }
        "app:setLang" => { LANG_EN.store(arg_str(a, 0).ok().as_deref() == Some("en"), std::sync::atomic::Ordering::SeqCst); chk.set_lang_if_fixed(if arg_str(a, 0).ok().as_deref() == Some("en") { "en" } else { "ru" }); Ok(json!(true)) }
        "ui:setTheme" | "app:about" => Ok(json!(true)),
        "stats:setDay" => { stats::set_day_words(&current_dir(&state)?, &arg_str(a, 0)?, a.get(1).unwrap_or(&Value::Null))?; Ok(json!(true)) }
        "stats:summary" => {
            let dir = current_dir(&state)?;
            let v = store::open_project(&dir)?;
            let st = store::project_stats(&dir)?;
            let total = if v["mode"] == "stories" && v["goalUnit"] == "chars" { st["totalChars"].as_i64() } else { st["total"].as_i64() }.unwrap_or(0);
            let today_words = a.get(1).cloned().unwrap_or(Value::Null);
            stats::summary(&dir, stats::SummaryIn { today: &arg_str(a, 0)?, today_words: &today_words, goal: v["projectGoal"].as_i64(), deadline: v["deadline"].as_str(), total })
        }
        "project:setAnalysisSkip" => store::set_analysis_skip(&current_dir(&state)?, a.get(0).unwrap_or(&Value::Null)),
        "image:pick" => {
            let dir = current_dir(&state)?;
            let Some(f) = rfd::AsyncFileDialog::new().set_title("Выберите картинку").add_filter("Картинки", &["png", "jpg", "jpeg", "webp", "gif"]).pick_file().await else { return Ok(Value::Null) };
            Ok(json!(store::add_image(&dir, f.path())?))
        }
        "ctx:edit" => {
            let js = match arg_str(a, 0)?.as_str() {
                "cut" => "document.execCommand('cut')",
                "copy" => "document.execCommand('copy')",
                "selectAll" => "document.execCommand('selectAll')",
                "undo" => "document.execCommand('undo')",
                "redo" => "document.execCommand('redo')",
                "paste" => "navigator.clipboard.readText().then(t=>document.execCommand('insertText',false,t)).catch(()=>{})",
                _ => return Err("Неизвестная команда.".into()),
            };
            if let Some(w) = app.get_webview_window("main") { let _ = w.eval(js); }
            Ok(json!(true))
        }
        "ctx:replaceMisspelling" => {
            let word = serde_json::to_string(&arg_str(a, 0)?).map_err(|e| e.to_string())?;
            if let Some(w) = app.get_webview_window("main") { let _ = w.eval(format!("document.execCommand('insertText',false,{})", word)); }
            Ok(json!(true))
        }
        "ctx:webSearch" => {
            let q = arg_str(a, 0).unwrap_or_default();
            let en = LANG_EN.load(std::sync::atomic::Ordering::SeqCst);
            match search_url(&arg_opt_str(a, 1).unwrap_or_default(), &q, en) { Some(u) => { open_url(&u); Ok(json!(true)) } None => Ok(json!(false)) }
        }
        "app:popupMenu" => {
            use tauri::menu::ContextMenu;
            if let (Some(menu), Some(w)) = (app.menu(), app.get_webview_window("main")) {
                let wv: &tauri::Webview = w.as_ref();
                let (x, y) = (a.get(0).and_then(|v| v.as_f64()).unwrap_or(0.0), a.get(1).and_then(|v| v.as_f64()).unwrap_or(0.0));
                let _ = menu.popup_at(wv.window(), tauri::LogicalPosition::new(x, y));
            }
            Ok(json!(true))
        }
        c if c.starts_with("check:") => {
            let op = c["check:".len()..].to_string();
            let chk: Arc<CheckApi> = chk.inner().clone();
            let cur = state.current.lock().map_err(|_| "Внутренняя ошибка состояния.".to_string())?.clone();
            let args = args.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let h = app.clone();
                chk.call(&op, &args, cur.as_deref(), &move |done, total| { let _ = h.emit("check:progress", json!({ "done": done, "total": total })); })
            }).await.map_err(|e| e.to_string())?
        }
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
        "project:close" => { if let Ok(d) = current_dir(&state) { let _ = backup_now(&app, &d); } set_current(&state, None); switch_sync(&dav, None).await; Ok(json!(true)) }
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
        "cards:mentions" => {
            let dir = current_dir(&state)?;
            mentions::card_mentions(&dir, &arg_str(a, 0)?, &arg_str(a, 1)?)
        }
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
        "fonts:list" | "fonts:add" | "fonts:remove" | "sounds:list" | "sounds:read" | "sounds:add" | "sounds:remove" | "sounds:openFolder" => {
            let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
            match channel.as_str() {
                "fonts:list" => tauri::async_runtime::spawn_blocking(move || Ok(json!(media::fonts_list(&data)))).await.map_err(|e| e.to_string())?,
                "fonts:add" => {
                    let picked = rfd::AsyncFileDialog::new().set_title("Добавить шрифты").add_filter("Шрифты", &["ttf", "otf", "woff", "woff2"]).pick_files().await;
                    let Some(files) = picked else { return Ok(json!([])) };
                    let paths: Vec<PathBuf> = files.iter().map(|f| f.path().to_path_buf()).collect();
                    Ok(json!(media::fonts_add(&data, &paths)?))
                }
                "fonts:remove" => { media::fonts_remove(&data, &arg_str(a, 0)?)?; Ok(json!(true)) }
                "sounds:list" => Ok(media::sounds_list(&data)),
                "sounds:read" => { let (s, f) = (arg_str(a, 0)?, arg_str(a, 1)?); tauri::async_runtime::spawn_blocking(move || media::sound_read(&data, &s, &f).map(Value::String)).await.map_err(|e| e.to_string())? }
                "sounds:add" => {
                    let slot = arg_str(a, 0)?;
                    let picked = rfd::AsyncFileDialog::new().set_title("Загрузить звук").add_filter("Звук", &["wav", "mp3", "ogg", "m4a", "aac"]).pick_files().await;
                    let Some(files) = picked else { return Ok(json!([])) };
                    let paths: Vec<PathBuf> = files.iter().map(|f| f.path().to_path_buf()).collect();
                    Ok(json!(media::sounds_add(&data, &slot, &paths)?))
                }
                "sounds:remove" => { media::sound_remove(&data, &arg_str(a, 0)?, &arg_str(a, 1)?)?; Ok(json!(true)) }
                _ => { open_path(&media::sounds_folder(&data)?); Ok(json!(true)) }
            }
        }
        "trash:restore" => store::restore_trash(&current_dir(&state)?, &arg_str(a, 0)?),
        "trash:purge" => store::purge_trash(&current_dir(&state)?, &arg_str(a, 0)?),
        "trash:empty" => store::empty_trash(&current_dir(&state)?),
        "project:search" => {
            let dir = current_dir(&state)?;
            let q = arg_str(a, 0)?;
            tauri::async_runtime::spawn_blocking(move || searchreplace::search_project(&dir, &q)).await.map_err(|e| e.to_string())?
        }
        "project:replace" => {
            let dir = current_dir(&state)?;
            let (find, repl) = (arg_str(a, 0)?, arg_str(a, 1).unwrap_or_default());
            let dry = a.get(2).map(|v| v.as_bool().unwrap_or(false) || v.as_i64() == Some(1)).unwrap_or(false);
            let app2 = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if !dry { backup_now(&app2, &dir)?; } // если копия не удалась, ничего не меняем
                searchreplace::replace_project(&dir, &find, &repl, dry)
            }).await.map_err(|e| e.to_string())?
        }
        "backup:now" => {
            let dir = current_dir(&state)?;
            Ok(match backup_now(&app, &dir)? { Some(n) => json!(n), None => Value::Null })
        }
        "backup:openFolder" => {
            let dir = current_dir(&state)?;
            let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
            let folder = backup::backup_root(&data, &dir);
            std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
            open_path(&folder);
            Ok(json!(true))
        }
        "backup:list" => {
            let dir = current_dir(&state)?;
            let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
            Ok(json!(backup::list_backups(&backup::backup_root(&data, &dir))))
        }
        "backup:restore" => {
            let dir = current_dir(&state)?;
            let name = arg_str(a, 0)?;
            let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
            let root = backup::backup_root(&data, &dir);
            // Остановить обмен, чтобы в облако не ушёл частично восстановленный проект.
            switch_sync(&dav, None).await;
            let d = dir.clone();
            let result = tauri::async_runtime::spawn_blocking(move || backup::restore_backup(&d, &root, &name)).await.map_err(|e| e.to_string())?;
            switch_sync(&dav, Some(dir)).await;
            Ok(json!(result?))
        }
        "backup:restoreInteractive" => {
            let dir = current_dir(&state)?;
            Ok(match restore_interactive(&app, dir, dav.clone()).await? { Some(v) => json!(v), None => Value::Null })
        }
        "project:import" => {
            let dir = current_dir(&state)?;
            let picked = rfd::AsyncFileDialog::new().set_title("Импорт глав")
                .add_filter("Документы", &["docx", "rtf", "md", "markdown", "txt"]).pick_files().await;
            let Some(files) = picked else { return Ok(Value::Null) };
            let mut paths: Vec<PathBuf> = files.iter().map(|f| f.path().to_path_buf()).collect();
            paths.sort_by_key(|p| natural_key(&p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()));
            let app2 = app.clone();
            let out = tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
                let mut items: Vec<(String, String)> = Vec::new();
                let mut skipped: Vec<String> = Vec::new();
                for p in &paths {
                    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                    let res = std::fs::metadata(p).map_err(|e| e.to_string())
                        .and_then(|md| if md.len() as usize > import::MAX_FILE { Err("Файл слишком большой для импорта (больше 30 МБ).".to_string()) } else { Ok(()) })
                        .and_then(|_| std::fs::read(p).map_err(|e| e.to_string()))
                        .and_then(|bytes| import::parse_file(&name, &bytes));
                    match res {
                        Ok(chs) => items.extend(chs.into_iter().map(|c| (c.title, c.text))),
                        Err(e) => skipped.push(format!("{}: {}", name, e)),
                    }
                }
                if items.is_empty() { return Err(if skipped.is_empty() { "В файлах нет текста.".into() } else { skipped.join("\n") }); }
                backup_now(&app2, &dir)?; // без копии ничего не меняем
                let out = store::import_chapters(&dir, &items)?;
                Ok(json!({ "project": out["project"], "ids": out["ids"], "skipped": skipped }))
            }).await.map_err(|e| e.to_string())??;
            Ok(out)
        }
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
        "dav:yandexOAuth" => {
            let y = dav.yandex.clone();
            tauri::async_runtime::spawn_blocking(move || y.run(&|u| { open_url(u); true })).await.map_err(|e| e.to_string())?
        }
        "dav:yandexCancel" => { dav.yandex.cancel(); Ok(json!(true)) }
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
            text.push_str("Облако без установки программ: подключает Яндекс Диск через вход в браузере (пароль вводится только на сайте Яндекса). Проект остаётся на этом компьютере, а его копия синхронизируется с облаком; на телефоне в Кабинете для Android подключается тот же Яндекс Диск.\n\nПравки с обеих сторон сохраняются: если один и тот же текст изменили на двух устройствах, чужая версия сохраняется в папке «Конфликты».\n\nСовет: работайте на одном устройстве за раз и закрывайте проект перед переходом на другое, чтобы облако успело всё передать.");
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

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") { let _ = w.unminimize(); let _ = w.show(); let _ = w.set_focus(); }
}

fn main() {
    tauri::Builder::default()
        // Второй запуск (например, возврат из браузера по ссылке kabinet://) не открывает вторую копию:
        // ссылка передаётся уже работающей, а окно выходит вперёд.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| { show_main(app); }))
        .plugin(tauri_plugin_deep_link::init())
        .manage(AppState::default())
        .plugin(tauri::plugin::Builder::<tauri::Wry, ()>::new("safe-close")
            .on_event(|app, event| {
                if let tauri::RunEvent::ExitRequested { api, .. } = event {
                    let st = app.state::<AppState>();
                    if !st.closing.load(std::sync::atomic::Ordering::SeqCst) {
                        if let Some(w) = app.get_webview_window("main") {
                            api.prevent_exit();
                            st.quit_requested.store(true, std::sync::atomic::Ordering::SeqCst);
                            let _ = w.close();
                        }
                    }
                }
            }).build())
        .setup(|app| {
            let data = app.path().app_data_dir().map_err(|e| format!("Нет папки данных приложения: {}", e))?;
            let handle = app.handle().clone();
            let h2 = handle.clone();
            let _ = app.state::<AppState>().on_external.set(Arc::new(move |files: Vec<String>| { let _ = h2.emit("sync:changed", files); }));
            let on_event = Arc::new(move |e: Event| match e {
                Event::Conflict => { let _ = handle.emit("dav:event", json!({ "type": "conflict" })); }
                Event::Error(m) => { let _ = handle.emit("dav:event", json!({ "type": "error", "message": m })); }
                Event::Changed(files) => { let _ = handle.emit("sync:changed", files); }
            });
            let link = DavLink::new(&data, Arc::new(KeyringSecret), &device_name(),
                Arc::new(|| Box::new(Retrying::new(UreqHttp::new())) as Box<dyn Http>), on_event);
            app.manage(Arc::new(DavApi::new(link)));
            // Возврат из браузера после входа в Яндекс: ссылка kabinet://oauth/yandex?… Чужие ссылки ядро игнорирует.
            #[cfg(any(windows, target_os = "linux"))]
            { let _ = app.deep_link().register_all(); }
            let (dav_for_links, app_for_links) = (app.state::<Arc<DavApi>>().inner().clone(), app.handle().clone());
            let take = move |urls: Vec<String>| {
                for u in urls {
                    let (y, a) = (dav_for_links.yandex.clone(), app_for_links.clone());
                    std::thread::spawn(move || { if y.receive(&u) { show_main(&a); } });
                }
            };
            if let Ok(Some(start)) = app.deep_link().get_current() { take(start.iter().map(|u| u.to_string()).collect()); }
            app.deep_link().on_open_url(move |e| take(e.urls().iter().map(|u| u.to_string()).collect()));
            app.manage(Arc::new(CheckApi::new(&data, Arc::new(|| Box::new(UreqHttp::with_timeout(45)) as Box<dyn Http>))));
            app.set_menu(build_menu(app.handle()).map_err(|e| format!("Не удалось построить меню: {}", e))?).map_err(|e| format!("Не удалось установить меню: {}", e))?;
            // Копия раз в 20 минут. Ошибка копирования не мешает писать.
            let h = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(20 * 60));
                let cur = h.state::<AppState>().current.lock().ok().and_then(|g| g.clone());
                if let Some(d) = cur { let _ = backup_now(&h, &d); }
            });
            Ok(())
        })
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let st = window.app_handle().state::<AppState>();
                if !st.closing.load(std::sync::atomic::Ordering::SeqCst) {
                    // Закрываем только после подтверждения успешной записи из окна.
                    api.prevent_close();
                    let _ = window.emit("app:close-requested", ());
                    return;
                }
                if let Some(d) = window.app_handle().try_state::<Arc<DavApi>>() { d.link.stop(); }
            }
        })
        .invoke_handler(tauri::generate_handler![call])
        .run(tauri::generate_context!())
        .expect("не удалось запустить Кабинет на Tauri");
}
