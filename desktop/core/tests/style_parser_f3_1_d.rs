use kabinet_core::style_parser::StyleParser;
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

fn big_russian_chapter(paragraphs: usize) -> String {
    let base = [
        "Осуществление проверки выполнения требований затянулось. Он шёл по тёмной улице и думал о том, что произошло вчера.",
        "Проведение анализа документов продолжалось долго. Мы осуществили разбор архива, но ответ оказался неполным.",
        "Он знал, что дом стоял, что сад шумел, что лес спал. Она сказала, что ветер стих, что дождь ушёл.",
        "Он поднял свою руку и вернулся обратно. Отряд осуществлял разведку тихо, потому что ночь была тёмной.",
    ];
    let mut out = String::new();
    for i in 0..paragraphs {
        if i > 0 { out.push_str("\n\n"); }
        out.push_str(base[i % base.len()]);
    }
    out
}

#[test]
fn cancel_before_parse_and_new_task_works() {
    let p = StyleParser::new(PathBuf::from("/tmp/kabinet-no-model-race.udpipe"), None, None);
    p.cancel(77);
    let r = p.parse(77, "Он пришёл.").unwrap();
    assert_eq!(r["cancelled"], json!(true));
    assert_eq!(r["taskId"], json!(77));
    let err = p.parse(78, "Он пришёл.").unwrap_err();
    assert!(err.contains("не найдена"));
}

#[test]
#[ignore = "нужна локальная GSD-модель: KABINET_STYLE_MODEL=... cargo test --test style_parser_f3_1_d -- --ignored"]
fn real_model_mid_parse_cancel_and_rapid_switch() {
    let path = std::env::var("KABINET_STYLE_MODEL").expect("KABINET_STYLE_MODEL");
    let parser = Arc::new(StyleParser::new(
        PathBuf::from(path),
        None,
        std::env::var("KABINET_STYLE_MODEL_SHA256").ok(),
    ));
    // Прогрев модели, чтобы измерять именно парсинг, а не загрузку файла.
    let warmup = parser.parse(1, "Он пришёл домой.").unwrap();
    assert_eq!(warmup["cancelled"], json!(false));

    let big = big_russian_chapter(200);
    let t_full = Instant::now();
    let full = parser.parse(2, &big).unwrap();
    assert_eq!(full["cancelled"], json!(false));
    let full_ms = t_full.elapsed().as_millis();

    // Настоящая отмена во время активного разбора UDPipe.
    let p1 = parser.clone();
    let b1 = big.clone();
    let t_cancel = Instant::now();
    let handle = thread::spawn(move || p1.parse(100, &b1).unwrap());
    thread::sleep(Duration::from_millis(40));
    parser.cancel(100);
    let cancelled_res = handle.join().unwrap();
    let cancel_ms = t_cancel.elapsed().as_millis();
    assert_eq!(cancelled_res["cancelled"], json!(true), "ожидалась отмена задачи 100");
    assert_eq!(cancelled_res["taskId"], json!(100));
    println!("F31D_MID_CANCEL full_ms={} cancel_ms={} chars={}", full_ms, cancel_ms, big.chars().count());

    // Серия быстрых переключений: только последняя задача должна завершиться.
    let mut handles = Vec::new();
    for id in 101u64..=106u64 {
        let p = parser.clone();
        let txt = if id == 106 {
            "Короткая финальная глава. Он вернулся обратно.".to_string()
        } else {
            big.clone()
        };
        handles.push((id, thread::spawn(move || p.parse(id, &txt).unwrap())));
        thread::sleep(Duration::from_millis(20));
    }
    let mut completed_final = false;
    for (id, h) in handles {
        let res = h.join().unwrap();
        if id == 106 {
            assert_eq!(res["cancelled"], json!(false), "финальная задача 106 должна завершиться");
            completed_final = true;
        } else {
            assert_eq!(res["cancelled"], json!(true), "вытесненная задача {} должна быть отменена", id);
        }
    }
    assert!(completed_final);
}

#[test]
#[ignore = "нужна локальная GSD-модель: KABINET_STYLE_MODEL=... cargo test --test style_parser_f3_1_d -- --ignored"]
fn real_model_large_documents_metrics() {
    let path = std::env::var("KABINET_STYLE_MODEL").expect("KABINET_STYLE_MODEL");
    let parser = StyleParser::new(
        PathBuf::from(path),
        None,
        std::env::var("KABINET_STYLE_MODEL_SHA256").ok(),
    );
    let _ = parser.parse(1, "Прогрев модели.").unwrap();

    for (tag, paras) in [("7kb", 35usize), ("25kb", 125usize), ("60kb", 300usize)] {
        let text = big_russian_chapter(paras);
        let t0 = Instant::now();
        let res = parser.parse(10, &text).unwrap();
        let wall_ms = t0.elapsed().as_millis();
        assert_eq!(res["cancelled"], json!(false));
        let sents = res["parse"]["sentences"].as_array().unwrap().len();
        let tokens: usize = res["parse"]["sentences"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["tokens"].as_array().unwrap().len())
            .sum();
        println!(
            "F31D_LARGE tag={} bytes={} chars={} sentences={} tokens={} rust_ms={} wall_ms={}",
            tag,
            text.len(),
            text.chars().count(),
            sents,
            tokens,
            res["ms"],
            wall_ms
        );
        if std::env::var("KABINET_DUMP_LARGE").ok().as_deref() == Some("1") {
            let dump = serde_json::to_string(&json!({ "text": text, "parse": res["parse"] })).unwrap();
            std::fs::write(format!("/tmp/kabinet-f31d-{}.json", tag), dump).unwrap();
        }
    }
}
