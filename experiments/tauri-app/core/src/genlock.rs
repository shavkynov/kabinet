//! Замок взаимного исключения синхронизации через общую папку.
//! Используются только документированные примитивы (create-only `overwrite=false`, чтение, список,
//! удаление). «Сейчас» берётся с сервера — mtime свежего пробного файла, — чтобы разница часов
//! устройств не давала ложных срабатываний.
//!
//! Замок — примитив протокола версий (задача № 1). В движок синхронизации пока не подключён.

use crate::remote::Remote;
use crate::store::R;
use serde_json::{json, Value};

pub const LOCK_FILE: &str = "kabinet.lock";
const PROBE_PREFIX: &str = "kabinet.probe.";

fn body(device: &str, token: &str) -> Vec<u8> {
    json!({ "device": device, "token": token }).to_string().into_bytes()
}

fn holder_device(remote: &mut impl Remote) -> R<Option<String>> {
    let Some(b) = remote.read(LOCK_FILE)? else { return Ok(None) };
    let v: Value = serde_json::from_slice(&b).unwrap_or(Value::Null);
    Ok(v.get("device").and_then(|d| d.as_str()).map(|d| d.to_string()))
}

/// Серверное «сейчас» (mtime пробного файла) и mtime замка — из одного списка.
fn server_time_and_lock(remote: &mut impl Remote) -> R<(i64, Option<i64>)> {
    let probe = format!("{}{:x}", PROBE_PREFIX, rand::random::<u64>());
    let created = remote.create(&probe, b"").is_ok();
    let items = remote.list("")?;
    if created { let _ = remote.remove(&probe); }
    let now = items.iter().find(|i| i.name.starts_with(PROBE_PREFIX)).map(|i| i.mtime).unwrap_or(0);
    let lock = items.iter().find(|i| i.name == LOCK_FILE).map(|i| i.mtime);
    Ok((now, lock))
}

/// Взять или обновить замок. Ok(true) — замок наш (взят, обновлён или отобран у просроченного).
/// Ошибка — состояние неизвестно; вызывающий решает, повторять ли проход позже.
pub fn try_acquire(remote: &mut impl Remote, device: &str, token: &str, ttl_ms: i64) -> R<bool> {
    let (now, lock_mtime) = server_time_and_lock(remote)?;
    match lock_mtime {
        Some(mtime) => {
            if holder_device(remote)?.as_deref() == Some(device) {
                remote.write(LOCK_FILE, &body(device, token))?; // heartbeat: продлеваем
                return Ok(true);
            }
            if now - mtime > ttl_ms {
                remote.write(LOCK_FILE, &body(device, token))?; // просрочен по серверному времени
                return Ok(true);
            }
            Ok(false)
        }
        None => Ok(remote.create(LOCK_FILE, &body(device, token)).is_ok()),
    }
}

/// Снять замок, только если он наш (по токену).
pub fn release(remote: &mut impl Remote, token: &str) -> R<()> {
    let Some(b) = remote.read(LOCK_FILE)? else { return Ok(()) };
    let v: Value = serde_json::from_slice(&b).unwrap_or(Value::Null);
    if v.get("token").and_then(|t| t.as_str()) == Some(token) {
        remote.remove(LOCK_FILE)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::Folder;
    use crate::testutil::{dav_on, FakeServer};

    fn remote(s: &FakeServer) -> crate::yandexdisk::YandexDisk<FakeServer> {
        let mut r = dav_on(s, "/Кабинет/Роман");
        r.ensure_root().unwrap();
        r
    }

    #[test]
    fn lock_is_exclusive_and_released_by_token() {
        let s = FakeServer::new();
        let mut a = remote(&s);
        assert!(try_acquire(&mut a, "A", "tok-a", 100_000).unwrap(), "первый берёт замок");
        let mut b = remote(&s);
        assert!(!try_acquire(&mut b, "B", "tok-b", 100_000).unwrap(), "второй не берёт свежий замок");
        release(&mut b, "tok-b").unwrap(); // чужой токен не снимает
        assert!(s.get("Кабинет/Роман/kabinet.lock").is_some(), "чужой release не снимает замок");
        release(&mut a, "tok-a").unwrap();
        assert!(s.get("Кабинет/Роман/kabinet.lock").is_none(), "свой release снимает замок");
        assert!(try_acquire(&mut b, "B", "tok-b", 100_000).unwrap(), "после снятия замок свободен");
    }

    #[test]
    fn expired_lock_is_taken_over() {
        let s = FakeServer::new();
        let mut a = remote(&s);
        assert!(try_acquire(&mut a, "A", "tok-a", 100_000).unwrap());
        // серверное время ушло далеко вперёд — замок просрочен
        s.0.lock().unwrap().clock += 1_000_000;
        let mut b = remote(&s);
        assert!(try_acquire(&mut b, "B", "tok-b", 100_000).unwrap(), "просроченный замок можно забрать");
        assert!(s.get("Кабинет/Роман/kabinet.lock").is_some());
    }

    #[test]
    fn lock_and_probe_are_not_synced_as_project_files() {
        // Замок и проба лежат в корне папки, но не должны попадать в синхронизацию как файлы проекта.
        assert!(!crate::foldersync::is_syncable("kabinet.lock"), "замок не синхронизируется");
        assert!(!crate::foldersync::is_syncable("kabinet.probe.1234abcd"), "проба не синхронизируется");
    }
}
