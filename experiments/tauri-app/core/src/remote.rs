//! Внешняя папка, с которой синхронизируется проект (адаптер). Порт интерфейса из src/folder.js.
use crate::store::R;

/// Запись в списке папки. size < 0 или mtime <= 0 значит «неизвестно» (кэш по размеру и дате не используется).
#[derive(Clone, Debug)]
pub struct Item {
    pub name: String,
    pub dir: bool,
    pub size: i64,
    pub mtime: i64,
}

pub trait Remote: Send {
    fn list(&mut self, rel: &str) -> R<Vec<Item>>;
    /// None: файла нет.
    fn read(&mut self, rel: &str) -> R<Option<Vec<u8>>>;
    fn write(&mut self, rel: &str, bytes: &[u8]) -> R<()>;
    /// Создать файл, только если его ещё нет (create-only, без перезаписи). Если хранилище этого
    /// не поддерживает — ошибка, а не молчаливая перезапись (примитив для протокола версий).
    fn create(&mut self, _rel: &str, _bytes: &[u8]) -> R<()> {
        Err("Создание без перезаписи не поддерживается этим хранилищем.".into())
    }
    fn remove(&mut self, rel: &str) -> R<()>;
    fn mkdir(&mut self, rel: &str) -> R<()>;
}

/// Папка, которой можно подключиться и в которой можно создать корень: сейчас её реализует только Яндекс Диск.
pub trait Folder: Remote {
    fn check(&mut self) -> R<bool>;
    fn ensure_root(&mut self) -> R<()>;
}

impl Remote for Box<dyn Folder> {
    fn list(&mut self, rel: &str) -> R<Vec<Item>> { (**self).list(rel) }
    fn read(&mut self, rel: &str) -> R<Option<Vec<u8>>> { (**self).read(rel) }
    fn write(&mut self, rel: &str, bytes: &[u8]) -> R<()> { (**self).write(rel, bytes) }
    fn create(&mut self, rel: &str, bytes: &[u8]) -> R<()> { (**self).create(rel, bytes) }
    fn remove(&mut self, rel: &str) -> R<()> { (**self).remove(rel) }
    fn mkdir(&mut self, rel: &str) -> R<()> { (**self).mkdir(rel) }
}
