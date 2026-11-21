//! Золотой корпус падежных форм: эталон — JS-реализация (src/declension.js), а Rust-порт
//! (src/declension.rs) должен давать для тех же карточек те же формы. Корпус детерминированно
//! генерируется командой `node scripts/gen-declension-golden.js` из корня репозитория и лежит
//! в tests/fixtures/declension-golden.json. Если этот тест упал, порт отстал от JS: сначала
//! перегенерируйте корпус и сравните, какая сторона изменилась.

use kabinet_core::declension::name_forms;
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

#[test]
fn declension_matches_js_golden_corpus() {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/declension-golden.json");
    let raw = fs::read_to_string(&fixture)
        .unwrap_or_else(|e| panic!("не читается {}: {e}", fixture.display()));
    let doc: Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("битый JSON {}: {e}", fixture.display()));
    let cases = doc["cases"].as_array().expect("в корпусе нет массива cases");
    let declared: usize = doc["variants"]
        .as_u64()
        .expect("в корпусе нет числа variants") as usize;

    let mut compared = 0usize;
    let mut failures: Vec<String> = Vec::new();
    for case in cases {
        let kind = case["kind"].as_str().expect("у карточки нет kind");
        let title = case["title"].as_str().expect("у карточки нет title");
        let aliases: Vec<String> = case["aliases"]
            .as_array()
            .expect("у карточки нет aliases")
            .iter()
            .map(|a| a.as_str().expect("псевдоним должен быть строкой").to_string())
            .collect();
        let expected_list: Vec<String> = case["forms"]
            .as_array()
            .expect("у карточки нет forms")
            .iter()
            .map(|f| f.as_str().expect("форма должна быть строкой").to_string())
            .collect();
        let expected: BTreeSet<String> = expected_list.iter().cloned().collect();
        assert_eq!(expected.len(), expected_list.len(), "повтор форм в корпусе: {kind} «{title}»");

        // Предметы в project.js cardIndex склоняются как места, поэтому в Rust-порт они
        // передаются с видом "place": у порта есть только "character" и "place".
        let decl_kind = if kind == "item" { "place" } else { kind };
        let got_list = name_forms(title, &aliases, decl_kind);
        let got: BTreeSet<String> = got_list.iter().cloned().collect();
        assert_eq!(got.len(), got_list.len(), "повтор форм у порта: {kind} «{title}»");

        compared += expected.len();
        if got != expected {
            let missing: Vec<&String> = expected.difference(&got).collect();
            let extra: Vec<&String> = got.difference(&expected).collect();
            failures.push(format!("{kind} «{title}»: нет {missing:?}; лишние {extra:?}"));
        }
    }

    assert!(
        failures.is_empty(),
        "расхождение JS и Rust на {} карточках:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert!(compared >= 8000, "сравнено {compared} вариантов, ожидается не менее 8000");
    assert_eq!(compared, declared, "сравнено {compared} вариантов, а в корпусе variants={declared}");
    assert!(cases.len() >= 250, "в корпусе {} карточек, ожидается не менее 250", cases.len());
}
