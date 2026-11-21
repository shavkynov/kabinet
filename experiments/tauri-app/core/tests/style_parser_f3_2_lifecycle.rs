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
#[ignore = "нужна локальная GSD-модель: KABINET_STYLE_MODEL=... cargo test --test style_parser_f3_2_lifecycle -- --ignored"]
fn real_gsd_installed_lifecycle_reinstall_and_cancel() {
    let gsd_src = PathBuf::from(std::env::var("KABINET_STYLE_MODEL").expect("KABINET_STYLE_MODEL"));
    let root = std::env::temp_dir().join(format!("kabinet-f32-lifecycle-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let data_dir = root.join("app-data");
    fs::create_dir_all(&data_dir).unwrap();

    // 1. Первый запуск без подключённой модели.
    let model_dest = resolve_model_path(None, &data_dir, None);
    assert_eq!(model_dest, data_dir.join("style-models").join(MODEL_FILE_NAME));
    let parser1 = StyleParser::new(model_dest.clone(), None, None);
    let st0 = parser1.status();
    assert_eq!(st0["supported"], json!(true));
    assert_eq!(st0["ready"], json!(false));
    assert!(parser1.parse(1, "Он вернулся обратно.").is_err());

    // 2. Подключение реальной Russian-GSD через install_model_from (с проверкой SHA-256).
    let st1 = parser1.install_model_from(&gsd_src).unwrap();
    assert_eq!(st1["ready"], json!(true));
    assert_eq!(st1["modelSha256"], json!("ba63e42f79f525cbcb78c8bc98dd126c2960cbada91b964a741285c15504f06a"));
    assert!(model_dest.is_file());

    // 3. Анализ реального русского текста и проверка UTF-16 offsets.
    let sample = "Осуществление проверки выполнения требований затянулось.\n\nОн вернулся обратно.";
    let res1 = parser1.parse(2, sample).unwrap();
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
    drop(parser1);

    // 4. Повторный запуск приложения: новый StyleParser на том же data_dir сразу видит модель.
    let parser2 = Arc::new(StyleParser::new(resolve_model_path(None, &data_dir, None), None, None));
    assert_eq!(parser2.status()["ready"], json!(true));
    let res2 = parser2.parse(3, "Он поднял свою руку.").unwrap();
    assert_eq!(res2["cancelled"], json!(false));

    // 5. Сбой замены битым файлом сохраняет прежнюю модель рабочей, повторная установка валидной проходит чисто.
    let broken = root.join("broken.udpipe");
    fs::write(&broken, b"not-a-valid-gsd-model").unwrap();
    assert!(parser2.install_model_from(&broken).is_err());
    assert_eq!(parser2.status()["ready"], json!(true));
    let st_reinstall = parser2.install_model_from(&gsd_src).unwrap();
    assert_eq!(st_reinstall["ready"], json!(true));
    let res3 = parser2.parse(4, "Отряд осуществлял разведку.").unwrap();
    assert_eq!(res3["cancelled"], json!(false));

    // В каталоге моделей не должно оставаться временных файлов .tmp / .bak.
    let entries: Vec<_> = fs::read_dir(model_dest.parent().unwrap())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(entries, vec![MODEL_FILE_NAME.to_string()]);

    // 6. Большой текст (~40 КБ) и настоящая отмена из соседнего потока.
    let mut big = String::new();
    for i in 0..220 {
        if i > 0 { big.push_str("\n\n"); }
        big.push_str("Осуществление проверки выполнения требований затянулось. Он вернулся обратно домой.");
    }
    let big_res = parser2.parse(5, &big).unwrap();
    assert_eq!(big_res["cancelled"], json!(false));

    let p_cancel = parser2.clone();
    let big_clone = big.clone();
    let handle = thread::spawn(move || p_cancel.parse(6, &big_clone).unwrap());
    thread::sleep(Duration::from_millis(35));
    parser2.cancel(6);
    let cancelled = handle.join().unwrap();
    assert_eq!(cancelled["cancelled"], json!(true));

    let _ = fs::remove_dir_all(&root);
}
