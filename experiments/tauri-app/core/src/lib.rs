//! Ядро Кабинета без оболочки окна: хранение проекта, WebDAV, синхронизация с папкой.
//! Всё здесь проверяется обычными тестами `cargo test`, без Tauri и без сети.
pub mod backup;
pub mod davapi;
pub mod davlink;
pub mod export;
pub mod exporttarget;
pub mod foldersync;
pub mod import;
pub mod remote;
pub mod searchreplace;
pub mod store;
pub mod syncguard;
pub mod webdav;

#[cfg(test)]
pub mod testutil;
