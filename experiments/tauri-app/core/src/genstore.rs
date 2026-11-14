//! Поколения состояния в облаке: неизменяемые объекты + «текущее» поколение как максимум по списку.
//! Поколение создаётся create-only (`overwrite=false`), поэтому его нельзя затереть: гонка писателей
//! разрешается перебором следующего свободного номера. Читатель берёт максимальный номер.
//! Это примитив протокола версий (задача № 1/10); в движок синхронизации пока не подключён.

use crate::remote::{Item, Remote};
use crate::store::R;

pub const GEN_DIR: &str = "kabinet.gen";

fn max_gen(items: &[Item]) -> Option<u64> {
    items.iter().filter_map(|i| i.name.strip_suffix(".json")).filter_map(|n| n.parse::<u64>().ok()).max()
}

/// Опубликовать новое поколение состояния (байты). Возвращает номер поколения.
/// Существующие поколения не перезаписываются: при конфликте берётся следующий номер.
pub fn publish(remote: &mut impl Remote, state: &[u8]) -> R<u64> {
    let items = remote.list(GEN_DIR)?;
    let max = max_gen(&items).unwrap_or(0);
    for n in (max + 1)..(max + 8) {
        if remote.create(&format!("{}/{}.json", GEN_DIR, n), state).is_ok() { return Ok(n); }
    }
    Err("Не удалось опубликовать новое поколение состояния.".into())
}

/// Прочитать текущее (максимальное) поколение и его содержимое.
pub fn load(remote: &mut impl Remote) -> R<Option<(u64, Vec<u8>)>> {
    let items = remote.list(GEN_DIR)?;
    let Some(n) = max_gen(&items) else { return Ok(None) };
    let bytes = remote.read(&format!("{}/{}.json", GEN_DIR, n))?;
    Ok(bytes.map(|b| (n, b)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::Folder;
    use crate::testutil::{dav_on, FakeServer};

    fn disk(s: &FakeServer) -> crate::yandexdisk::YandexDisk<FakeServer> {
        let mut r = dav_on(s, "/Кабинет/Роман");
        r.ensure_root().unwrap();
        r
    }

    #[test]
    fn publish_and_load_generations() {
        let s = FakeServer::new();
        let mut r = disk(&s);
        assert_eq!(publish(&mut r, b"one").unwrap(), 1);
        assert_eq!(publish(&mut r, b"two").unwrap(), 2);
        let (n, data) = load(&mut r).unwrap().unwrap();
        assert_eq!(n, 2);
        assert_eq!(data, b"two");
        assert!(!crate::foldersync::is_syncable("kabinet.gen/1.json"), "поколения не синхронизируются как файлы проекта");
    }

    #[test]
    fn existing_generation_is_not_overwritten() {
        let s = FakeServer::new();
        let mut r = disk(&s);
        s.put("Кабинет/Роман/kabinet.gen/1.json", b"old");
        assert_eq!(publish(&mut r, b"new").unwrap(), 2, "занятое поколение не перезаписывается");
        assert_eq!(s.get("Кабинет/Роман/kabinet.gen/1.json").unwrap(), b"old", "старое поколение неизменно");
        assert_eq!(load(&mut r).unwrap().unwrap().0, 2);
    }

    #[test]
    fn empty_cloud_has_no_generation() {
        let s = FakeServer::new();
        let mut r = disk(&s);
        assert!(load(&mut r).unwrap().is_none(), "без публикаций поколения нет");
    }
}
