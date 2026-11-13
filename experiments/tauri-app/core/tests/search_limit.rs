use kabinet_core::{searchreplace, store};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};

struct Project { dir: PathBuf, meta: Value, next: usize }
impl Project {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("kabinet-search-limit-{}-{:016x}", std::process::id(), rand::random::<u64>()));
        fs::create_dir_all(dir.join("Главы")).unwrap();
        Self { dir, meta: json!({"name":"Проверка поиска", "chapters":[], "characters":[], "places":[], "items":[], "notes":[]}), next: 0 }
    }
    fn add(&mut self, kind: &str, title: &str, bytes: &[u8]) -> String {
        let (key, folder, ext) = match kind {
            "chapter" => ("chapters", "Главы", "md"),
            "character" => ("characters", "Персонажи", "json"),
            "place" => ("places", "Места", "json"),
            "item" => ("items", "Предметы", "json"),
            "note" => ("notes", "Заметки", "md"),
            _ => panic!("unknown kind"),
        };
        let id = format!("d{:05}", self.next);
        self.next += 1;
        fs::create_dir_all(self.dir.join(folder)).unwrap();
        fs::write(self.dir.join(folder).join(format!("{id}.{ext}")), bytes).unwrap();
        self.meta[key].as_array_mut().unwrap().push(json!({"id":id, "title":title}));
        id
    }
    fn finish(&self) {
        fs::write(self.dir.join("project.json"), serde_json::to_vec_pretty(&self.meta).unwrap()).unwrap();
    }
}
impl Drop for Project {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.dir); }
}

#[test]
fn search_does_not_read_a_broken_file_after_one_hundred_hits() {
    let mut p = Project::new();
    let mut expected = Vec::new();
    for _ in 0..100 { expected.push(p.add("chapter", "Глава", "Дракон".as_bytes())); }
    p.add("chapter", "Поздняя глава", &[0xff, 0xfe]);
    p.finish();
    let found = searchreplace::search_project(&p.dir, "дракон").unwrap();
    let ids: Vec<&str> = found.as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap()).collect();
    assert_eq!(ids, expected.iter().map(String::as_str).collect::<Vec<_>>());
}

#[test]
fn limit_counts_hits_instead_of_visited_documents() {
    let mut p = Project::new();
    for _ in 0..110 { p.add("chapter", "Глава", "Тихая ночь".as_bytes()); }
    let last = p.add("chapter", "Последняя", "Дракон".as_bytes());
    p.finish();
    let found = searchreplace::search_project(&p.dir, "дракон").unwrap();
    assert_eq!(found.as_array().unwrap().len(), 1);
    assert_eq!(found[0]["id"], last);
}

#[test]
fn nonmatching_documents_do_not_use_the_result_budget() {
    let mut p = Project::new();
    for _ in 0..99 { p.add("chapter", "Глава", "Дракон".as_bytes()); }
    p.add("chapter", "Без совпадения", "Ночь".as_bytes());
    let hundredth = p.add("chapter", "Ещё одно совпадение", "Дракон".as_bytes());
    p.add("chapter", "Не читать", &[0xff]);
    p.finish();
    let found = searchreplace::search_project(&p.dir, "дракон").unwrap();
    assert_eq!(found.as_array().unwrap().len(), 100);
    assert_eq!(found[99]["id"], hundredth);
}

#[test]
fn title_only_hit_can_reach_the_limit_before_later_categories() {
    let mut p = Project::new();
    for _ in 0..99 { p.add("chapter", "Глава", "Дракон".as_bytes()); }
    let card = p.add("character", "Дракон", b"{}");
    p.add("place", "Не читать", &[0xff]);
    p.finish();
    let found = searchreplace::search_project(&p.dir, "дракон").unwrap();
    assert_eq!(found.as_array().unwrap().len(), 100);
    assert_eq!(found[99]["id"], card);
    assert_eq!(found[99]["kind"], "character");
    assert_eq!(found[99]["count"], 0);
    assert_eq!(found[99]["titleMatch"], true);
}

#[test]
fn order_counts_and_snippets_remain_unchanged_across_categories() {
    let mut p = Project::new();
    p.add("chapter", "Первая", "Дракон ".repeat(6).as_bytes());
    p.add("chapter", "Вторая", "Дракон".as_bytes());
    for kind in ["character", "place", "item"] {
        p.add(kind, "Карточка", "{\"short\":\"Дракон\"}".as_bytes());
    }
    p.add("note", "Заметка", "Дракон".as_bytes());
    p.finish();
    let found = searchreplace::search_project(&p.dir, "дракон").unwrap();
    let kinds: Vec<&str> = found.as_array().unwrap().iter().map(|c| c["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, vec!["chapter", "chapter", "character", "place", "item", "note"]);
    assert_eq!(found[0]["count"], 6);
    assert_eq!(found[0]["snippets"].as_array().unwrap().len(), 4);
}

#[test]
fn unreadable_file_before_the_limit_is_still_an_error() {
    let mut p = Project::new();
    p.add("chapter", "Первая", "Дракон".as_bytes());
    p.add("chapter", "Ошибка", &[0xff]);
    p.finish();
    assert!(searchreplace::search_project(&p.dir, "дракон").is_err());
}

#[test]
fn replacement_is_not_limited_to_one_hundred_documents() {
    let mut p = Project::new();
    let mut last = String::new();
    for _ in 0..101 { last = p.add("chapter", "Глава", "Дракон".as_bytes()); }
    p.finish();
    let dry = searchreplace::replace_project(&p.dir, "дракон", "змей", true).unwrap();
    assert_eq!(dry["total"], 101);
    assert_eq!(store::read_chapter(&p.dir, &last).unwrap(), "Дракон");
    let done = searchreplace::replace_project(&p.dir, "дракон", "змей", false).unwrap();
    assert_eq!(done["total"], 101);
    assert_eq!(done["docs"].as_array().unwrap().len(), 101);
    assert_eq!(store::read_chapter(&p.dir, &last).unwrap(), "змей");
}
