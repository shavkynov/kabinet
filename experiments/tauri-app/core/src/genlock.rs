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

/// Серверное «сейчас» (mtime ТОЧНО своей созданной пробы) и mtime замка — из одного списка.
///
/// Контракт: если свою пробу создать не удалось, если её нет в полученном списке или её время
/// недостоверно — возвращается `Err`. Решение о просроченности замка по чужой/старой пробе,
/// по `now=0` или по местным часам недопустимо: иначе можно ошибочно отобрать чужой замок.
/// Пробу убираем и при ошибке списка; ошибка очистки не скрывает первичную ошибку.
fn server_time_and_lock(remote: &mut impl Remote) -> R<(i64, Option<i64>)> {
    let probe = format!("{}{:x}", PROBE_PREFIX, rand::random::<u64>());
    if let Err(e) = remote.create(&probe, b"") {
        return Err(format!("Не удалось создать пробу серверного времени «{}»: {}. Состояние замка не определено.", probe, e));
    }
    // Пробу убираем сразу после списка — в том числе когда список не удался.
    let listed = remote.list("");
    let cleanup = remote.remove(&probe);
    let cleanup_note = match &cleanup {
        Ok(()) => String::new(),
        Err(ce) => format!(" Убрать пробу «{}» не удалось: {}.", probe, ce),
    };
    let items = match listed {
        Ok(items) => items,
        Err(e) => {
            return Err(format!(
                "Не удалось прочитать список папки для пробы «{}»: {}. Состояние замка не определено.{}",
                probe, e, cleanup_note
            ))
        }
    };
    let Some(item) = items.iter().find(|i| i.name == probe) else {
        return Err(format!(
            "Собственной пробы «{}» нет в списке папки — время сервера недостоверно. Состояние замка не определено.{}",
            probe, cleanup_note
        ));
    };
    let now = item.mtime;
    if now <= 0 {
        return Err(format!(
            "Время собственной пробы «{}» недостоверно ({}). Состояние замка не определено.{}",
            probe, now, cleanup_note
        ));
    }
    if let Err(ce) = cleanup {
        return Err(format!("Не удалось убрать пробу «{}»: {}. Состояние замка не определено.", probe, ce));
    }
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
        // Замка нет в списке: создаём. Подтверждённый конфликт имени — «занято» (false),
        // любой другой отказ — ошибка, а не догадка «занято».
        None => remote.create_if_absent(LOCK_FILE, &body(device, token)),
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
    use crate::testutil::{dav_on, FakeServer, Gate};
    use serde_json::Value;

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

    /// L1.1: старая чужая проба лексикографически раньше — время всё равно берётся по СВОЕЙ пробе.
    #[test]
    fn own_probe_time_is_used_even_if_foreign_probe_is_first() {
        let s = FakeServer::new();
        let mut a = remote(&s);
        assert!(try_acquire(&mut a, "A", "tok-a", 100_000).unwrap());
        let lock_mtime = s.0.lock().unwrap().files.get("/Кабинет/Роман/kabinet.lock").unwrap().1;
        // чужая старая проба с именем, которое в списке идёт раньше случайного собственного
        s.put_at("Кабинет/Роман/kabinet.probe.0000000000000000", b"", lock_mtime - 5_000_000);
        // серверное время ушло вперёд: замок просрочен по СВЕЖЕМУ времени
        let clock = s.0.lock().unwrap().clock;
        s.0.lock().unwrap().clock = clock + 1_000_000;
        let mut b = remote(&s);
        assert!(try_acquire(&mut b, "B", "tok-b", 100_000).unwrap(),
            "время берётся по своей пробе (замок просрочен), а не по старой чужой");
    }

    /// L1.2: ошибка создания своей пробы — Err; замок не изменён; пробы не используются.
    #[test]
    fn probe_create_error_is_returned_and_lock_untouched() {
        let s = FakeServer::new();
        let mut a = remote(&s);
        assert!(try_acquire(&mut a, "A", "tok-a", 100_000).unwrap());
        let before = s.get("Кабинет/Роман/kabinet.lock").unwrap();
        s.0.lock().unwrap().fail_put_prefixes.insert("/Кабинет/Роман/kabinet.probe.".to_string());
        let mut b = remote(&s);
        let res = try_acquire(&mut b, "B", "tok-b", 100_000);
        assert!(res.is_err(), "ошибка создания пробы должна возвращаться явно");
        assert_eq!(s.get("Кабинет/Роман/kabinet.lock").unwrap(), before, "замок не изменён");
        assert_eq!(s.names().iter().filter(|n| n.contains("kabinet.probe.")).count(), 0, "пробы не используются");
    }

    /// L1.3: create успешен, но своей пробы нет в списке — Err, решения по замку нет.
    #[test]
    fn missing_own_probe_in_list_is_error() {
        let s = FakeServer::new();
        let mut a = remote(&s);
        assert!(try_acquire(&mut a, "A", "tok-a", 100_000).unwrap());
        let before = s.get("Кабинет/Роман/kabinet.lock").unwrap();
        s.0.lock().unwrap().hide_prefixes.insert("/Кабинет/Роман/kabinet.probe.".to_string());
        let mut b = remote(&s);
        let res = try_acquire(&mut b, "B", "tok-b", 100_000);
        assert!(res.is_err(), "отсутствие своей пробы в списке — Err, а не now=0");
        assert_eq!(s.get("Кабинет/Роман/kabinet.lock").unwrap(), before, "замок не перезаписан");
    }

    /// L1.4: ошибка list после успешного create — исходная ошибка и удаление ИМЕННО своей пробы.
    #[test]
    fn list_error_returns_error_and_removes_own_probe() {
        let s = FakeServer::new();
        let mut a = remote(&s);
        assert!(try_acquire(&mut a, "A", "tok-a", 100_000).unwrap());
        let mut b = remote(&s);
        s.0.lock().unwrap().fail_list = true;
        let res = try_acquire(&mut b, "B", "tok-b", 100_000);
        let log = s.0.lock().unwrap().log.clone();
        let probes = s.names().iter().filter(|n| n.contains("kabinet.probe.")).count();
        assert!(res.is_err(), "ошибка списка возвращается");
        assert!(log.iter().any(|l| l.starts_with("DELETE /Кабинет/Роман/kabinet.probe.")), "попытка удалить точное имя пробы: {log:?}");
        assert_eq!(probes, 0, "своя проба убрана несмотря на ошибку списка");
    }

    /// L1.5a: ошибка очистки пробы — явная ошибка, не молчаливый успех.
    #[test]
    fn probe_cleanup_error_is_reported() {
        let s = FakeServer::new();
        let mut a = remote(&s);
        assert!(try_acquire(&mut a, "A", "tok-a", 100_000).unwrap());
        s.0.lock().unwrap().fail_delete_prefixes.insert("/Кабинет/Роман/kabinet.probe.".to_string());
        let mut b = remote(&s);
        let msg = try_acquire(&mut b, "B", "tok-b", 100_000).expect_err("ошибка очистки не должна давать молчаливый успех");
        assert!(msg.contains("пробу"), "явно сказано про пробу: {msg}");
    }

    /// L1.5b: первичная ошибка списка не теряется за ошибкой очистки.
    #[test]
    fn primary_list_error_is_not_lost_behind_cleanup_error() {
        let s = FakeServer::new();
        let mut a = remote(&s);
        assert!(try_acquire(&mut a, "A", "tok-a", 100_000).unwrap());
        let mut b = remote(&s);
        s.0.lock().unwrap().fail_list = true;
        s.0.lock().unwrap().fail_delete_prefixes.insert("/Кабинет/Роман/kabinet.probe.".to_string());
        let msg = try_acquire(&mut b, "B", "tok-b", 100_000).unwrap_err();
        assert!(msg.contains("список"), "первичная ошибка списка сохранена: {msg}");
        assert!(msg.contains("пробу"), "ошибка очистки тоже сообщена: {msg}");
    }

    /// L1b: замок есть в папке, но не в списке — подтверждённый конфликт создания → Ok(false).
    #[test]
    fn missing_lock_with_confirmed_conflict_is_not_acquired() {
        let s = FakeServer::new();
        let mut d = remote(&s);
        assert!(d.create_if_absent("kabinet.lock", b"{\"device\":\"A\",\"token\":\"tok-a\"}").unwrap());
        s.0.lock().unwrap().hide.insert("/Кабинет/Роман/kabinet.lock".to_string());
        let mut b = remote(&s);
        assert!(!try_acquire(&mut b, "B", "tok-b", 100_000).unwrap(), "подтверждённый конфликт — замок не наш");
        let log = s.0.lock().unwrap().log.clone();
        assert!(log.iter().any(|l| l.starts_with("DELETE /Кабинет/Роман/kabinet.probe.")), "своя проба прошла: {log:?}");
    }

    /// L1b: отказ создания LOCK_FILE — Err, а не «занято» (старая ветка `.is_ok()` давала Ok(false)).
    #[test]
    fn missing_lock_create_failure_is_error_not_busy() {
        let s = FakeServer::new();
        let mut d = remote(&s);
        s.0.lock().unwrap().fail_put_prefixes.insert("/Кабинет/Роман/kabinet.lock".to_string());
        let res = try_acquire(&mut d, "A", "tok-a", 100_000);
        let log = s.0.lock().unwrap().log.clone();
        assert!(res.is_err(), "отказ создания замка — Err, не Ok(false)");
        assert!(log.iter().any(|l| l.starts_with("DELETE /Кабинет/Роман/kabinet.probe.")), "своя проба перед этим прошла: {log:?}");
        assert!(s.get("Кабинет/Роман/kabinet.lock").is_none(), "замок не создан");
    }

    /// L1.6: штатный сценарий — своя проба создаётся, читается и убирается.
    #[test]
    fn normal_probe_is_created_read_and_removed() {
        let s = FakeServer::new();
        let mut a = remote(&s);
        assert!(try_acquire(&mut a, "A", "tok-a", 100_000).unwrap());
        assert!(s.get("Кабинет/Роман/kabinet.lock").is_some(), "замок взят");
        assert_eq!(s.names().iter().filter(|n| n.contains("kabinet.probe.")).count(), 0, "своя проба убрана");
    }

    // ==== L2: диагностика конкурентных ограничений (характеризация, НЕ доказательство безопасности) ====
    //
    // Для каждого сценария порядок событий задан явно: операция приостанавливается в нужной точке,
    // второй участник действует в промежутке, затем первая операция продолжается. Ожидания ограничены
    // по времени (5 с). Производственная логика не меняется; тесты закрепляют ТЕКУЩЕЕ поведение.

    // Управляемая остановка (Gate) — в общей тестовой инфраструктуре `testutil`.

    /// Тестовая обёртка Remote: пауза после чтения LOCK_FILE и/или замена замка в этот момент.
    struct Wedge<T> { inner: T, gate: Option<Gate>, replace: Option<(String, String)> }
    impl<T: crate::remote::Remote> crate::remote::Remote for Wedge<T> {
        fn list(&mut self, rel: &str) -> R<Vec<crate::remote::Item>> { self.inner.list(rel) }
        fn read(&mut self, rel: &str) -> R<Option<Vec<u8>>> {
            let r = self.inner.read(rel)?;
            if rel == LOCK_FILE {
                if let Some((device, token)) = self.replace.take() { self.inner.write(rel, &body(&device, &token))?; }
                if let Some(gate) = self.gate.take() { gate.hold(); }
            }
            Ok(r)
        }
        fn write(&mut self, rel: &str, bytes: &[u8]) -> R<()> { self.inner.write(rel, bytes) }
        fn create(&mut self, rel: &str, bytes: &[u8]) -> R<()> { self.inner.create(rel, bytes) }
        fn create_if_absent(&mut self, rel: &str, bytes: &[u8]) -> R<bool> { self.inner.create_if_absent(rel, bytes) }
        fn remove(&mut self, rel: &str) -> R<()> { self.inner.remove(rel) }
        fn mkdir(&mut self, rel: &str) -> R<()> { self.inner.mkdir(rel) }
    }

    fn lock_token(s: &FakeServer) -> Option<String> {
        let b = s.get("Кабинет/Роман/kabinet.lock")?;
        let v: Value = serde_json::from_slice(&b).ok()?;
        v.get("token").and_then(|t| t.as_str()).map(|t| t.to_string())
    }

    /// L2.1 ХАРАКТЕРИЗАЦИЯ известного дефекта: два претендента на просроченный замок оба получают Ok(true).
    /// Не доказывает безопасность; при исправлении тест заменить проверкой «ровно один получил замок».
    #[test]
    fn l2_1_two_claimants_of_expired_lock_both_win_characterization() {
        let s = FakeServer::new();
        let mut seed = remote(&s);
        seed.write(LOCK_FILE, &body("old", "tok-old")).unwrap();
        s.0.lock().unwrap().clock += 1_000_000; // TTL 100_000 — замок просрочен

        let gate = Gate::new();
        let mut a = Wedge { inner: remote(&s), gate: Some(gate.clone()), replace: None };
        let t = std::thread::spawn(move || try_acquire(&mut a, "A", "tok-a", 100_000));
        gate.wait_reached(); // A прочитал старое состояние и приостановлен ДО записи
        let mut b = remote(&s);
        let rb = try_acquire(&mut b, "B", "tok-b", 100_000); // B тоже видит старое состояние
        gate.allow();
        let ra = t.join().unwrap();

        let writes = s.0.lock().unwrap().log.iter().filter(|l| *l == "PUT /Кабинет/Роман/kabinet.lock").count();
        assert_eq!(ra.unwrap(), true, "A считает, что взял замок");
        assert_eq!(rb.unwrap(), true, "B считает, что взял замок — двойное владение");
        assert!(writes >= 2, "было не менее двух записей замка: {writes}");
        assert_eq!(lock_token(&s).as_deref(), Some("tok-a"), "конечный владелец — A (последняя запись)");
    }

    /// L2.2 ХАРАКТЕРИЗАЦИЯ известного дефекта: release удаляет замок, заменённый на чужой токен между
    /// чтением токена и remove. Не доказывает безопасность.
    #[test]
    fn l2_2_release_removes_lock_replaced_after_token_read_characterization() {
        let s = FakeServer::new();
        let mut a = remote(&s);
        assert!(try_acquire(&mut a, "A", "tok-a", 100_000).unwrap());
        let mut w = Wedge { inner: remote(&s), gate: None, replace: Some(("B".to_string(), "tok-b".to_string())) };
        let res = release(&mut w, "tok-a");
        assert!(res.is_ok(), "release вернул успех");
        assert!(s.get("Кабинет/Роман/kabinet.lock").is_none(), "release удалил замок, принадлежавший B");
    }

    /// L2.3 ХАРАКТЕРИЗАЦИЯ: два экземпляра одного device оба считают, что владеют замком;
    /// у прежнего владельца нет проверки владения до следующей записи.
    #[test]
    fn l2_3_same_device_two_instances_both_win_characterization() {
        let s = FakeServer::new();
        let mut a = remote(&s);
        assert!(try_acquire(&mut a, "D", "tok-a", 100_000).unwrap());
        let mut b = remote(&s);
        assert_eq!(try_acquire(&mut b, "D", "tok-b", 100_000).unwrap(), true, "heartbeat чужого экземпляра того же device");
        assert_eq!(lock_token(&s).as_deref(), Some("tok-b"), "токен заменён вторым экземпляром");
        // у A нет примитива «проверить, что замок ещё мой»: единственная сверка токена — в release
        assert!(release(&mut a, "tok-a").is_ok());
        assert!(s.get("Кабинет/Роман/kabinet.lock").is_some(), "release прежнего токена не снимает чужой замок");
    }

    /// L2.4 ХАРАКТЕРИЗАЦИЯ: после отбора просроченного замка прежний владелец продолжает работу —
    /// примитив genlock не перепроверяет владение перед операциями.
    #[test]
    fn l2_4_previous_owner_continues_after_ttl_characterization() {
        let s = FakeServer::new();
        let mut a = remote(&s);
        assert!(try_acquire(&mut a, "A", "tok-a", 100_000).unwrap());
        s.0.lock().unwrap().clock += 1_000_000; // TTL истёк
        let mut b = remote(&s);
        assert!(try_acquire(&mut b, "B", "tok-b", 100_000).unwrap(), "просроченный замок отобран");
        // A продолжает защищаемую работу: primitives не блокируют запись по потерянному замку
        a.write("Главы/aaaaaa.md", "запись после потери замка".as_bytes()).unwrap();
        assert_eq!(s.get("Кабинет/Роман/Главы/aaaaaa.md").unwrap(), "запись после потери замка".as_bytes());
    }
}
