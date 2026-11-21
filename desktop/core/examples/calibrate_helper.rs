use kabinet_core::offline_spell::OfflineSpell;
use kabinet_core::style_parser::{StyleParser, MODEL_FILE_NAME};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::Instant;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InputDoc {
    id: String,
    paragraphs: Vec<String>,
    #[serde(default)]
    custom_words: Vec<String>,
}

struct CliArgs {
    model_path: PathBuf,
    custom_model: bool,
    dicts_dir: PathBuf,
    lang: String,
    do_parse: bool,
    do_spell: bool,
}

fn default_repo_root() -> PathBuf {
    // Обычно запускается из корня репозитория или через cargo --manifest-path desktop/core/Cargo.toml.
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if cwd.join("desktop/src-tauri/resources").is_dir() {
        return cwd;
    }
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .and_then(|p| p.parent())
        .map(Path::to_path_buf)
        .unwrap_or(cwd)
}

fn parse_args() -> Result<CliArgs, String> {
    let root = default_repo_root();
    let mut model_path = root
        .join("desktop/src-tauri/resources/style-models")
        .join(MODEL_FILE_NAME);
    let mut custom_model = false;
    let mut dicts_dir = root.join("desktop/src-tauri/resources/dictionaries");
    let mut lang = "ru".to_string();
    let mut do_parse = true;
    let mut do_spell = true;

    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--model" => {
                i += 1;
                let v = args.get(i).ok_or("--model требует путь к файлу .udpipe")?;
                model_path = PathBuf::from(v);
                custom_model = true;
            }
            "--dicts" => {
                i += 1;
                let v = args.get(i).ok_or("--dicts требует путь к каталогу словарей")?;
                dicts_dir = PathBuf::from(v);
            }
            "--lang" => {
                i += 1;
                let v = args.get(i).ok_or("--lang требует значение ru|en|auto")?;
                if !matches!(v.as_str(), "ru" | "en" | "auto") {
                    return Err(format!("Неизвестный язык --lang: {}", v));
                }
                lang = v.clone();
            }
            "--no-parse" => do_parse = false,
            "--no-spell" => do_spell = false,
            other => return Err(format!("Неизвестный аргумент: {}", other)),
        }
        i += 1;
    }

    Ok(CliArgs {
        model_path,
        custom_model,
        dicts_dir,
        lang,
        do_parse,
        do_spell,
    })
}

fn build_joined_and_starts(paragraphs: &[String]) -> (String, Vec<Option<usize>>) {
    let total_bytes: usize = paragraphs.iter().map(|p| p.len() + 2).sum();
    let mut joined = String::with_capacity(total_bytes);
    let mut starts = Vec::with_capacity(paragraphs.len());
    let mut u16_pos = 0usize;

    for para in paragraphs {
        if para.trim().is_empty() {
            starts.push(None);
            continue;
        }
        if !joined.is_empty() {
            joined.push_str("\n\n");
            u16_pos += 2;
        }
        starts.push(Some(u16_pos));
        joined.push_str(para);
        u16_pos += para.encode_utf16().count();
    }

    (joined, starts)
}

fn main() {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("calibrate_helper: {}", e);
            std::process::exit(2);
        }
    };

    let parser = if args.do_parse {
        let sha_override = if args.custom_model {
            Some(String::new())
        } else {
            None
        };
        let p = StyleParser::new(args.model_path.clone(), None, sha_override);
        // Проверяем/прогреваем один раз до обработки потока.
        if let Err(e) = p.parse(0, "Прогрев.") {
            eprintln!("calibrate_helper: не удалось загрузить модель {}: {}", args.model_path.display(), e);
            std::process::exit(1);
        }
        Some(p)
    } else {
        None
    };

    let spell = if args.do_spell {
        let s = OfflineSpell::new(args.dicts_dir.clone());
        if !s.has_lang(&args.lang) {
            eprintln!(
                "calibrate_helper: словари для --lang {} не найдены в {}",
                args.lang,
                args.dicts_dir.display()
            );
            std::process::exit(1);
        }
        Some(s)
    } else {
        None
    };

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());
    let cancel = AtomicBool::new(false);
    let mut task_id = 1u64;

    for (line_no, line_res) in stdin.lock().lines().enumerate() {
        let line = match line_res {
            Ok(l) => l,
            Err(e) => {
                eprintln!("calibrate_helper: ошибка чтения stdin (строка {}): {}", line_no + 1, e);
                std::process::exit(1);
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let doc: InputDoc = match serde_json::from_str(&line) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("calibrate_helper: некорректный JSON (строка {}): {}", line_no + 1, e);
                std::process::exit(1);
            }
        };

        let (joined, para_starts) = build_joined_and_starts(&doc.paragraphs);
        let chars = joined.encode_utf16().count();

        let (parse_ms, parse_val) = if let Some(ref p) = parser {
            if joined.is_empty() {
                (
                    0u128,
                    json!({ "schemaVersion": 1, "parser": { "name": "udpipe-rs" }, "sentences": [] }),
                )
            } else {
                let t0 = Instant::now();
                let res = p.parse(task_id, &joined).unwrap_or_else(|e| {
                    eprintln!("calibrate_helper: ошибка parse для {}: {}", doc.id, e);
                    std::process::exit(1);
                });
                task_id += 1;
                let elapsed = t0.elapsed().as_millis();
                let parse = res.get("parse").cloned().unwrap_or(Value::Null);
                (elapsed, parse)
            }
        } else {
            (0u128, Value::Null)
        };

        let (spell_ms, spell_val) = if let Some(ref s) = spell {
            let t0 = Instant::now();
            let issues = s
                .check_paragraphs(&doc.paragraphs, &args.lang, &doc.custom_words, &cancel, &|_, _| {})
                .unwrap_or_else(|e| {
                    eprintln!("calibrate_helper: ошибка spell для {}: {}", doc.id, e);
                    std::process::exit(1);
                });
            (t0.elapsed().as_millis(), Value::Array(issues))
        } else {
            (0u128, Value::Null)
        };

        let row = json!({
            "id": doc.id,
            "chars": chars,
            "parseMs": parse_ms,
            "spellMs": spell_ms,
            "paraStarts": para_starts,
            "parse": parse_val,
            "spell": spell_val,
        });

        if let Err(e) = serde_json::to_writer(&mut out, &row) {
            eprintln!("calibrate_helper: ошибка JSON stdout: {}", e);
            std::process::exit(1);
        }
        if let Err(e) = writeln!(out) {
            eprintln!("calibrate_helper: ошибка записи stdout: {}", e);
            std::process::exit(1);
        }
        let _ = out.flush();
    }
}
