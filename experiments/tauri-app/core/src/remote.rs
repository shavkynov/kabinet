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
    fn remove(&mut self, rel: &str) -> R<()>;
    fn mkdir(&mut self, rel: &str) -> R<()>;
}
