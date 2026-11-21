use kabinet_core::{export, mentions, searchreplace, store};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

const TEXTS: [&str; 3] = ["Дракон спал", "Дракон проснулся и улетел", "Тихая ночь над рекой"];

struct Project {
    dir: PathBuf,
    ids: Vec<String>,
}

impl Project {
    fn new(texts: &[&str]) -> Self {
        let dir = std::env::temp_dir().join(format!("kabinet-lenient-{}-{:016x}", std::process::id(), rand::random::<u64>()));
        let view = store::create_project(&dir, "Проверка сводных операций", None).unwrap();
        let mut ids = vec![view["chapters"][0]["id"].as_str().unwrap().to_string()];
        for _ in 1..texts.len() {
  ids.push(store::add_chapter(&dir, None).unwrap()["id"].as_str().unwrap().to_string());
        }
        for (id, text) in ids.iter().zip(texts) {
  store::write_chapter(&dir, id, text).unwrap();
        }
        Project { dir, ids }
    }

    fn file(&self, index: usize) -> PathBuf {
        self.dir.join("Главы").join(format!("{}.md", self.ids[index]))
    }

    fn remove(&self, index: usize) {
        fs::remove_file(self.file(index)).unwrap();
    }
}

impl Drop for Project {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn words_of(list: &Value, id: &str) -> i64 {
    list.as_array().unwrap().iter().find(|c| c["id"] == id).unwrap()["words"].as_i64().unwrap()
}

#[test]
fn stats_and_board_survive_a_missing_chapter() {
    let p = Project::new(&TEXTS);
    p.remove(1);
    let stats = store::project_stats(&p.dir).unwrap();
    assert_eq!(stats["total"].as_i64().unwrap(), 6);
    assert_eq!(stats["chapters"].as_array().unwrap().len(), 3);
    assert_eq!(words_of(&stats["chapters"], &p.ids[0]), 2);
    assert_eq!(words_of(&stats["chapters"], &p.ids[1]), 0);
    let board = store::board_data(&p.dir).unwrap();
    assert_eq!(board.as_array().unwrap().len(), 3);
    assert_eq!(words_of(&board, &p.ids[1]), 0);
    assert_eq!(words_of(&board, &p.ids[2]), 4);
    assert!(!p.file(1).exists());
}

#[test]
fn search_and_replace_skip_a_missing_chapter_without_recreating_it() {
    let p = Project::new(&TEXTS);
    p.remove(1);
    let found = searchreplace::search_project(&p.dir, "дракон").unwrap();
    let ids: Vec<&str> = found.as_array().unwrap().iter().map(|d| d["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec![p.ids[0].as_str()]);
    let done = searchreplace::replace_project(&p.dir, "дракон", "змей", false).unwrap();
    assert_eq!(done["total"].as_u64().unwrap(), 1);
    assert_eq!(store::read_chapter(&p.dir, &p.ids[0]).unwrap(), "змей спал");
    assert_eq!(store::read_chapter(&p.dir, &p.ids[2]).unwrap(), "Тихая ночь над рекой");
    assert!(!p.file(1).exists());
}

#[test]
fn mentions_ignore_a_missing_chapter() {
    let p = Project::new(&TEXTS);
    let card = store::add_item(&p.dir, "character", None).unwrap()["id"].as_str().unwrap().to_string();
    store::rename_item(&p.dir, "character", &card, "Дракон").unwrap();
    p.remove(1);
    let result = mentions::card_mentions(&p.dir, "character", &card).unwrap();
    let list = result["chapters"].as_array().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["id"].as_str(), Some(p.ids[0].as_str()));
    assert!(list[0]["count"].as_i64().unwrap() >= 1);
}

#[test]
fn export_stays_strict_when_a_chapter_is_missing() {
    let p = Project::new(&TEXTS);
    p.remove(1);
    let error = export::build_export(&p.dir, "md", "ru", false, true).unwrap_err();
    assert!(error.contains(&p.ids[1]));
    assert!(!p.file(1).exists());
}

#[test]
fn an_existing_empty_chapter_is_zero_words_and_exports() {
    let p = Project::new(&["", "Текст"]);
    let stats = store::project_stats(&p.dir).unwrap();
    assert_eq!(stats["total"].as_i64().unwrap(), 1);
    assert!(export::build_export(&p.dir, "md", "ru", false, true).is_ok());
}

#[test]
fn unreadable_text_is_still_an_error_for_aggregates() {
    let p = Project::new(&["Один", "Два"]);
    fs::write(p.file(1), [0xff, 0xfe, 0xff]).unwrap();
    assert!(store::project_stats(&p.dir).is_err());
    assert_eq!(fs::read(p.file(1)).unwrap(), vec![0xff, 0xfe, 0xff]);
}
