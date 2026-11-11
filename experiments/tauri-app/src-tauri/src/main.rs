#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// Кабинет на Tauri: этап 1 — ядро (проекты, главы, корзина, недавние). Интерфейс тот же, что в Electron-версии;
// он вызывает единственную команду `call(channel, args)`, как раньше ipcRenderer.invoke(channel, ...args).
mod store;

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Manager, State};

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

fn open_at(app: &tauri::AppHandle, state: &State<'_, AppState>, dir: &Path) -> Result<Value, String> {
    let proj = store::open_project(dir)?;
    set_current(state, Some(dir.to_path_buf()));
    let name = proj["name"].as_str().unwrap_or("");
    store::recents_add(&recents_file(app)?, &dir.to_string_lossy(), name)?;
    Ok(proj)
}

async fn pick_folder(title: &str) -> Option<PathBuf> {
    rfd::AsyncFileDialog::new().set_title(title).pick_folder().await.map(|h| h.path().to_path_buf())
}

#[tauri::command]
async fn call(app: tauri::AppHandle, state: State<'_, AppState>, channel: String, args: Vec<Value>) -> Result<Value, String> {
    let a = &args;
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
            store::recents_add(&recents_file(&app)?, &dir.to_string_lossy(), proj["name"].as_str().unwrap_or(""))?;
            Ok(proj)
        }
        "project:openDialog" => {
            let Some(dir) = pick_folder("Открыть проект: выберите папку, в которой лежит project.json").await else { return Ok(Value::Null) };
            open_at(&app, &state, &dir)
        }
        "project:openRecent" => {
            let p = arg_str(a, 0)?;
            if !store::recents_has(&recents_file(&app)?, &p) { return Err("Этого проекта нет в списке недавних.".into()); }
            open_at(&app, &state, Path::new(&p))
        }
        "project:close" => { set_current(&state, None); Ok(json!(true)) }
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
        "cards:index" => Ok(json!([])),
        "fonts:list" => Ok(json!([])),
        "trash:restore" => store::restore_trash(&current_dir(&state)?, &arg_str(a, 0)?),
        "trash:purge" => store::purge_trash(&current_dir(&state)?, &arg_str(a, 0)?),
        "trash:empty" => store::empty_trash(&current_dir(&state)?),
        other => Err(format!("Эта функция пока не перенесена в версию на Tauri: {}", other)),
    }
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![call])
        .run(tauri::generate_context!())
        .expect("не удалось запустить Кабинет на Tauri");
}
