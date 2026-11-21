use kabinet_core::style_parser::{resolve_model_path, StyleParser, MODEL_FILE_NAME};
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

fn utf16_slice(s: &str, start: usize, end: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    String::from_utf16(&units[start..end]).unwrap()
}

#[test]
#[ignore = "нужна локальная GSD-модель: KABINET_STYLE_MODEL=... cargo test --test style_parser_lifecycle -- --ignored"]
fn real_gsd_bundled_lifecycle_and_idle_unload() {
    let gsd_src = PathBuf::from(std::env::var("KABINET_STYLE_MODEL").expect("KABINET_STYLE_MODEL"));
    let root = std::env::temp_dir().join(format!("kabinet-lifecycle-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let data_dir = root.join("app-data");
    let res_dir = root.join("resources");
    fs::create_dir_all(&data_dir).unwrap();
    fs::create_dir_all(res_dir.join("style-models")).unwrap();

    // 1. Без файла модели в ресурсах и data_dir status().ready === false.
    let missing_path = resolve_model_path(None, &data_dir, Some(&res_dir));
    assert_eq!(missing_path, res_dir.join("style-models").join(MODEL_FILE_NAME));
    let parser_empty = StyleParser::new(missing_path.clone(), None, None);
    assert_eq!(parser_empty.status()["ready"], json!(false));
    assert!(parser_empty.parse(1, "Он вернулся обратно.").is_err());

    // 2. Размещение Russian-GSD во встроенный resource_dir сразу включает разбор.
    fs::copy(&gsd_src, &missing_path).unwrap();
    let resolved = resolve_model_path(None, &data_dir, Some(&res_dir));
    assert_eq!(resolved, missing_path);

    let parser = Arc::new(StyleParser::new(resolved, None, None));
    let st = parser.status();
    assert_eq!(st["supported"], json!(true));
    assert_eq!(st["ready"], json!(true));
    assert_eq!(st["modelSha256"], json!("ba63e42f79f525cbcb78c8bc98dd126c2960cbada91b964a741285c15504f06a"));

    // 3. Разбор текста и проверка UTF-16 offsets.
    let sample = "Осуществление проверки выполнения требований затянулось.\n\nОн вернулся обратно.";
    let res1 = parser.parse(2, sample).unwrap();
    assert_eq!(res1["cancelled"], json!(false));
    let sents = res1["parse"]["sentences"].as_array().unwrap();
    assert_eq!(sents.len(), 2);
    for s in sents {
        for tok in s["tokens"].as_array().unwrap() {
            let a = tok["start"].as_u64().unwrap() as usize;
            let b = tok["end"].as_u64().unwrap() as usize;
            assert_eq!(utf16_slice(sample, a, b), tok["text"].as_str().unwrap());
        }
    }

    // 4. Большой текст (~40 КБ) и отмена из соседнего потока.
    let mut big = String::new();
    for i in 0..220 {
        if i > 0 { big.push_str("\n\n"); }
        big.push_str("Осуществление проверки выполнения требований затянулось. Он вернулся обратно домой.");
    }
    let big_res = parser.parse(3, &big).unwrap();
    assert_eq!(big_res["cancelled"], json!(false));

    let p_cancel = parser.clone();
    let big_clone = big.clone();
    let handle = thread::spawn(move || p_cancel.parse(4, &big_clone).unwrap());
    thread::sleep(Duration::from_millis(35));
    parser.cancel(4);
    let cancelled = handle.join().unwrap();
    assert_eq!(cancelled["cancelled"], json!(true));

    // 5. Выгрузка при простое и прозрачная перезагрузка.
    assert!(parser.is_loaded());
    thread::sleep(Duration::from_millis(20));
    assert!(parser.unload_if_idle(Duration::from_millis(10)));
    assert!(!parser.is_loaded());
    let reloaded = parser.parse(5, "Дверь была открыта.").unwrap();
    assert_eq!(reloaded["cancelled"], json!(false));
    assert!(parser.is_loaded());

    let _ = fs::remove_dir_all(&root);
}
