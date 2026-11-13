//! Ядро Кабинета без оболочки окна: хранение проекта, WebDAV, синхронизация с папкой.
//! Всё здесь проверяется обычными тестами `cargo test`, без Tauri и без сети.
pub mod backup;
pub mod check;
pub mod davapi;
pub mod davlink;
pub mod declension;
pub mod dict;
pub mod export;
pub mod exporttarget;
pub mod foldersync;
pub mod import;
pub mod media;
pub mod remote;
pub mod searchreplace;
pub mod stats;
pub mod store;
pub mod syncguard;
pub mod watcher;
pub mod webdav;
pub mod yandexdisk;
pub mod yandexoauth;

#[cfg(test)]
pub mod testutil;
