//! Интеграционные тесты встроенной офлайн-орфографии на настоящих словарях ru и en.
//! Запускаются при наличии словарей (scripts/prepare-resources.cjs):
//!   KABINET_SPELL_DIR=desktop/src-tauri/resources/dictionaries cargo test --test offline_spell_real -- --include-ignored

use kabinet_core::offline_spell::OfflineSpell;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

fn spell_dir() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("KABINET_SPELL_DIR") {
        let dir = PathBuf::from(p);
        if dir.join("ru.dic").is_file() && dir.join("en.dic").is_file() {
            return Some(dir);
        }
    }
    None
}

#[test]
#[ignore = "нужны скачанные словари: KABINET_SPELL_DIR=... cargo test --test offline_spell_real -- --include-ignored"]
fn real_dicts_check_ru_en_custom_yo_and_60k_benchmark() {
    let dir = spell_dir().expect("KABINET_SPELL_DIR не задан");
    let svc = OfflineSpell::new(dir);
    assert!(svc.has_lang("ru"));
    assert!(svc.has_lang("en"));

    let cancel = AtomicBool::new(false);
    let custom = vec!["Кабинет".to_string(), "Слизерин".to_string(), "Илья".to_string()];

    // 1. Русский текст: ё/е, дефис, карточки, современная и литературная лексика, реальные опечатки и быстрые подсказки.
    let ru = vec![
        "Привет Илья, черный кот шел через зеленый луг, кто-то сказал что Слизерин рядом. Првиет мир!".to_string(),
        "Теченье несло предвиденье, темно-серый экран мессенджере показывал скриншот, круассаны и американо у барной стойки, свежемолотым кофе пахло полголовы закрывши полувеселой улыбкой офлайн.".to_string(),
        "Неверные слова: сегдня карандш ошибкка челвек закрытта.".to_string(),
        "ПРИВЕТ МОСКВА".to_string(),
    ];
    let issues = svc.check_paragraphs(&ru, "ru", &custom, &cancel, &|_, _| {}).unwrap();
    let bad: Vec<&str> = issues.iter().filter_map(|x| x["text"].as_str()).collect();
    assert_eq!(
        bad,
        vec!["Првиет", "сегдня", "карандш", "ошибкка", "челвек", "закрытта"],
        "неожиданные замечания в русском тексте: {:?}",
        bad
    );
    assert_eq!(issues[0]["replacements"][0], serde_json::json!("Привет"));
    assert_eq!(issues[1]["replacements"][0], serde_json::json!("сегодня"));
    assert_eq!(issues[2]["replacements"][0], serde_json::json!("карандаш"));
    assert_eq!(issues[3]["replacements"][0], serde_json::json!("ошибка"));
    assert_eq!(issues[4]["replacements"][0], serde_json::json!("человек"));
    assert_eq!(issues[5]["replacements"][0], serde_json::json!("закрыта"));

    // 2. Английский текст и автоопределение.
    let en = vec!["Hello, don't stop now, this is a helo typo.".to_string()];
    let en_issues = svc.check_paragraphs(&en, "en", &[], &cancel, &|_, _| {}).unwrap();
    let en_bad: Vec<&str> = en_issues.iter().filter_map(|x| x["text"].as_str()).collect();
    assert_eq!(en_bad, vec!["helo"]);

    let mixed = vec!["Илья написал hello и совершил опечатку првиет и helo.".to_string()];
    let auto_issues = svc.check_paragraphs(&mixed, "auto", &custom, &cancel, &|_, _| {}).unwrap();
    let auto_bad: Vec<&str> = auto_issues.iter().filter_map(|x| x["text"].as_str()).collect();
    assert_eq!(auto_bad, vec!["првиет", "helo"]);

    // 3. Глава на 60 000 слов (1500 абзацев по 40 слов).
    let sample = "Он медленно шёл по тёмной улице мимо старых домов и тихо думал о том, что случилось вчера вечером у пристани, когда холодный ветер нёс запах дыма. Потом герой вернулся обратно к старому фонарю. Ветер дул сильнее над рекой и ночной тишиной.";
    let mut big = Vec::with_capacity(1500);
    for i in 0..1500 {
        if i == 750 {
            big.push(format!("{} Првиет тут опечатка.", sample));
        } else {
            big.push(sample.to_string());
        }
    }
    let t0 = Instant::now();
    let big_issues = svc.check_paragraphs(&big, "ru", &custom, &cancel, &|_, _| {}).unwrap();
    let elapsed = t0.elapsed();
    let big_bad: Vec<&str> = big_issues.iter().filter_map(|x| x["text"].as_str()).collect();
    assert_eq!(big_bad, vec!["Првиет"]);
    assert!(elapsed < Duration::from_secs(3), "проверка 60 000 слов заняла {:?} (> 3s)", elapsed);
    println!("offline_spell 60k words elapsed: {:?}", elapsed);

    // 4. Ленивый подбор вариантов для отдельного слова.
    assert!(svc.suggest_word("апельсен", "ru").unwrap().iter().any(|w| w == "апельсин"));
    assert!(svc.suggest_word("здраствуйте", "ru").unwrap().iter().any(|w| w == "здравствуйте"));
    assert!(svc.suggest_word("коллегаг", "ru").unwrap().iter().any(|w| w == "коллегам" || w == "коллега" || w == "коллегах"));

    // 5. Выгрузка словарей по простою.
    assert!(svc.unload_if_idle(Duration::from_secs(0)));
}
