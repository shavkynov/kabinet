#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![forbid(unsafe_code)]

fn main() {
    // No project access, plugins, custom commands, migrations or cloud credentials.
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("failed to run isolated Kabinet editor experiment");
}
