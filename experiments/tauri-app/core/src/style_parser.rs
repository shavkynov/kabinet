//! Локальный синтаксический парсер для стилевого анализа.
//! Модель читается с диска (ресурс приложения/переменная окружения), не встраивается в код.
//! Результат — parser-neutral contract из src/style-engine/contract.js: UTF-16 offsets,
//! леммы, UPOS, feats, head/deprel. Модель не входит в репозиторий.

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use udpipe_rs::{Model, Word};

const DEFAULT_MODEL_VERSION: &str = "russian-gsd-ud-2.5-191206";
const DEFAULT_MODEL_SHA256: &str = "ba63e42f79f525cbcb78c8bc98dd126c2960cbada91b964a741285c15504f06a";

#[derive(Clone, Debug, Serialize)]
pub struct ParserInfo {
    pub name: String,
    pub version: String,
    #[serde(rename = "modelVersion")]
    pub model_version: String,
    #[serde(rename = "modelSha256")]
    pub model_sha256: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ContractToken {
    pub id: i32,
    pub text: String,
    pub lemma: String,
    pub upos: String,
    pub feats: BTreeMap<String, String>,
    pub head: i32,
    pub deprel: String,
    pub start: usize,
    pub end: usize,
    pub confidence: Option<f32>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ContractSentence {
    pub start: usize,
    pub end: usize,
    pub text: String,
    pub tokens: Vec<ContractToken>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Contract {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    pub parser: ParserInfo,
    pub sentences: Vec<ContractSentence>,
}

#[derive(Clone, Debug)]
struct RawToken {
    id: i32,
    sentence_id: i32,
    form: String,
    lemma: String,
    upos: String,
    feats: String,
    head: i32,
    deprel: String,
}

impl From<&Word> for RawToken {
    fn from(w: &Word) -> Self {
        RawToken {
            id: w.id,
            sentence_id: w.sentence_id,
            form: w.form.clone(),
            lemma: w.lemma.clone(),
            upos: w.upostag.clone(),
            feats: w.feats.clone(),
            head: w.head,
            deprel: w.deprel.clone(),
        }
    }
}

fn parse_feats(raw: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for pair in raw.split('|') {
        if let Some((k, v)) = pair.split_once('=') {
            if !k.is_empty() { out.insert(k.to_string(), v.to_string()); }
        }
    }
    out
}

/// Карта «байтовый offset → UTF-16 offset». Нужна, потому что Rust/JSON считают байты,
/// а ProseMirror — UTF-16 code units. Строится один раз на текст.
fn utf16_map(text: &str) -> Vec<usize> {
    let mut map = vec![0usize; text.len() + 1];
    let mut units = 0usize;
    let mut at = 0usize;
    for ch in text.chars() {
        map[at] = units;
        let len = ch.len_utf8();
        for i in 1..len { map[at + i] = units; }
        units += ch.len_utf16();
        at += len;
        map[at] = units;
    }
    map
}

/// Разбивает текст на абзацы по пустой строке, сохраняя байтовые границы.
fn paragraph_ranges(text: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut start = 0usize;
    let bytes = text.as_bytes();
    let mut i = 0usize;
    while i + 1 < bytes.len() {
        let sep = (bytes[i] == b'\n' && bytes[i + 1] == b'\n')
            || (bytes[i] == b'\r' && i + 3 < bytes.len() && bytes[i + 1] == b'\n' && bytes[i + 2] == b'\r' && bytes[i + 3] == b'\n');
        if sep {
            let end = i;
            if text[start..end].trim().is_empty() == false { out.push((start, end)); }
            i += if bytes[i] == b'\r' { 4 } else { 2 };
            start = i;
        } else {
            i += 1;
        }
    }
    if start < text.len() && !text[start..].trim().is_empty() { out.push((start, text.len())); }
    if out.is_empty() && !text.trim().is_empty() { out.push((0, text.len())); }
    out
}

/// Точное выравнивание форм парсера по исходнику: пропускаем только whitespace,
/// затем требуем посимвольного совпадения. Никакого поиска «следующего вхождения».
fn align_block(source: &str, block_start: usize, block_end: usize, words: &[RawToken]) -> Result<Vec<(usize, usize)>, String> {
    let mut spans = Vec::with_capacity(words.len());
    let mut at = block_start;
    for word in words {
        while at < block_end {
            let ch = source[at..].chars().next().ok_or("Некорректная граница UTF-8.")?;
            if !ch.is_whitespace() { break; }
            at += ch.len_utf8();
        }
        if !source[at..block_end].starts_with(&word.form) {
            let saw = source[at..block_end].chars().take(24).collect::<String>();
            return Err(format!(
                "Токен «{}» не совпадает с исходником в позиции {} (там «{}»). Разбор остановлен, offsets не публикуются.",
                word.form, at, saw
            ));
        }
        let end = at + word.form.len();
        spans.push((at, end));
        at = end;
    }
    let tail = &source[at..block_end];
    if !tail.trim().is_empty() {
        let saw = tail.chars().take(24).collect::<String>();
        return Err(format!("После последнего токена остался неразобранный текст: «{}».", saw));
    }
    Ok(spans)
}

fn build_contract(source: &str, raw_words: &[RawToken], parser: &ParserInfo) -> Result<Contract, String> {
    let map = utf16_map(source);
    let spans = align_block(source, 0, source.len(), raw_words)?;
    let mut sentences = Vec::new();
    let mut i = 0usize;
    while i < raw_words.len() {
        let sid = raw_words[i].sentence_id;
        let mut j = i;
        while j < raw_words.len() && raw_words[j].sentence_id == sid { j += 1; }
        let start = spans[i].0;
        let end = spans[j - 1].1;
        let tokens = (i..j).map(|k| {
            let w = &raw_words[k];
            let (s, e) = spans[k];
            ContractToken {
                id: w.id,
                text: w.form.clone(),
                lemma: w.lemma.clone(),
                upos: w.upos.clone(),
                feats: parse_feats(&w.feats),
                head: w.head,
                deprel: w.deprel.clone(),
                start: map[s],
                end: map[e],
                confidence: None,
            }
        }).collect();
        sentences.push(ContractSentence { start: map[start], end: map[end], text: source[start..end].to_string(), tokens });
        i = j;
    }
    Ok(Contract { schema_version: 1, parser: parser.clone(), sentences })
}

pub struct StyleParser {
    model_path: PathBuf,
    model_version: String,
    model_sha256: String,
    loaded: Mutex<Option<Arc<Mutex<Model>>>>,
    current: Mutex<Option<(u64, Arc<AtomicBool>)>>,
}

impl StyleParser {
    pub fn new(model_path: PathBuf, model_version: Option<String>, model_sha256: Option<String>) -> Self {
        Self {
            model_path,
            model_version: model_version.unwrap_or_else(|| DEFAULT_MODEL_VERSION.to_string()),
            model_sha256: model_sha256.unwrap_or_else(|| DEFAULT_MODEL_SHA256.to_string()),
            loaded: Mutex::new(None),
            current: Mutex::new(None),
        }
    }

    /// Модель загружается один раз; хэш проверяется до Model::load.
    fn model(&self) -> Result<Arc<Mutex<Model>>, String> {
        let mut guard = self.loaded.lock().map_err(|_| "Внутренний замок парсера недоступен.".to_string())?;
        if let Some(model) = guard.as_ref() { return Ok(model.clone()); }
        let bytes = fs::read(&self.model_path).map_err(|e| format!("Модель стилевого анализа не найдена ({}): {}", self.model_path.display(), e))?;
        let actual = format!("{:x}", Sha256::digest(&bytes));
        if !self.model_sha256.is_empty() && actual != self.model_sha256 {
            return Err(format!("Модель стилевого анализа повреждена или не та: SHA-256 {} вместо {}.", actual, self.model_sha256));
        }
        let model = Model::load(&self.model_path).map_err(|e| format!("Не удалось загрузить модель стилевого анализа: {}", e))?;
        let model = Arc::new(Mutex::new(model));
        *guard = Some(model.clone());
        Ok(model)
    }

    pub fn cancel(&self, task_id: u64) {
        if let Ok(current) = self.current.lock() {
            if let Some((id, flag)) = current.as_ref() {
                if *id == task_id { flag.store(true, Ordering::SeqCst); }
            }
        }
    }

    pub fn parse(&self, task_id: u64, text: &str) -> Result<Value, String> {
        let flag = Arc::new(AtomicBool::new(false));
        {
            let mut current = self.current.lock().map_err(|_| "Внутренний замок задач недоступен.".to_string())?;
            if let Some((_, old)) = current.replace((task_id, flag.clone())) { old.store(true, Ordering::SeqCst); }
        }
        let result = self.parse_inner(task_id, text, &flag);
        if let Ok(mut current) = self.current.lock() {
            if current.as_ref().map(|(id, _)| *id) == Some(task_id) { *current = None; }
        }
        result
    }

    fn parse_inner(&self, task_id: u64, text: &str, cancel: &Arc<AtomicBool>) -> Result<Value, String> {
        let model = self.model()?;
        let model = model.lock().map_err(|_| "Модель стилевого анализа занята.".to_string())?;
        let started = std::time::Instant::now();
        let parser = ParserInfo {
            name: "udpipe-rs".to_string(),
            version: "0.2".to_string(),
            model_version: self.model_version.clone(),
            model_sha256: self.model_sha256.clone(),
        };
        let mut all = Vec::new();
        let full_map = utf16_map(text);
        for (start, end) in paragraph_ranges(text) {
            if cancel.load(Ordering::SeqCst) {
                return Ok(json!({ "taskId": task_id, "cancelled": true }));
            }
            let block = &text[start..end];
            let words = model.parse(block).map_err(|e| format!("Ошибка разбора: {}", e))?;
            let raw: Vec<RawToken> = words.iter().map(RawToken::from).collect();
            let mut contract = build_contract(block, &raw, &parser)?;
            // build_contract работает с локальным блоком; сдвигаем offsets на начало абзаца.
            let shift = full_map[start];
            for s in &mut contract.sentences {
                s.start += shift; s.end += shift;
                for t in &mut s.tokens { t.start += shift; t.end += shift; }
            }
            all.extend(contract.sentences);
        }
        if cancel.load(Ordering::SeqCst) { return Ok(json!({ "taskId": task_id, "cancelled": true })); }
        let contract = Contract { schema_version: 1, parser, sentences: all };
        Ok(json!({
            "taskId": task_id,
            "cancelled": false,
            "ms": started.elapsed().as_millis(),
            "parse": contract,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(id: i32, sentence_id: i32, form: &str, head: i32) -> RawToken {
        RawToken { id, sentence_id, form: form.into(), lemma: form.to_lowercase(), upos: "X".into(), feats: String::new(), head, deprel: "dep".into() }
    }

    fn parser() -> ParserInfo {
        ParserInfo { name: "test".into(), version: "0".into(), model_version: "test".into(), model_sha256: "0".into() }
    }

    #[test]
    fn offsets_cyrillic_and_punctuation_are_utf16() {
        let text = "Он пришёл.";
        let words = vec![raw(1, 0, "Он", 2), raw(2, 0, "пришёл", 0), raw(3, 0, ".", 2)];
        let c = build_contract(text, &words, &parser()).unwrap();
        let s = &c.sentences[0];
        assert_eq!((s.start, s.end), (0, 10));
        assert_eq!(s.tokens.iter().map(|t| (t.start, t.end)).collect::<Vec<_>>(), vec![(0, 2), (3, 9), (9, 10)]);
    }

    #[test]
    fn offsets_emoji_are_utf16_surrogate_pairs() {
        let text = "Он 😀 ушёл.";
        let words = vec![raw(1, 0, "Он", 2), raw(2, 0, "😀", 3), raw(3, 0, "ушёл", 2), raw(4, 0, ".", 3)];
        let c = build_contract(text, &words, &parser()).unwrap();
        assert_eq!(c.sentences[0].tokens.iter().map(|t| (t.start, t.end)).collect::<Vec<_>>(), vec![(0, 2), (3, 5), (6, 10), (10, 11)]);
    }

    #[test]
    fn offsets_combining_and_nbsp_and_tabs() {
        let text = "е\u{0301}ж\u{00a0}ушёл\tдомой.";
        let words = vec![raw(1, 0, "е\u{0301}ж", 2), raw(2, 0, "ушёл", 0), raw(3, 0, "домой", 2), raw(4, 0, ".", 2)];
        let c = build_contract(text, &words, &parser()).unwrap();
        assert_eq!(c.sentences[0].tokens.iter().map(|t| (t.start, t.end)).collect::<Vec<_>>(), vec![(0, 3), (4, 8), (9, 14), (14, 15)]);
    }

    #[test]
    fn repeated_tokens_are_not_found_by_later_search() {
        let text = "дом дом.";
        let words = vec![raw(1, 0, "дом", 3), raw(2, 0, "дом", 0), raw(3, 0, ".", 2)];
        let c = build_contract(text, &words, &parser()).unwrap();
        assert_eq!(c.sentences[0].tokens.iter().map(|t| (t.start, t.end)).collect::<Vec<_>>(), vec![(0, 3), (4, 7), (7, 8)]);
    }

    #[test]
    fn mismatch_and_leftover_fail_closed() {
        let text = "Он пришёл.";
        let words = vec![raw(1, 0, "Он", 2), raw(2, 0, "ушёл", 0)];
        assert!(build_contract(text, &words, &parser()).is_err());
        let words = vec![raw(1, 0, "Он", 2)];
        assert!(build_contract(text, &words, &parser()).is_err());
    }

    #[test]
    #[ignore = "нужна локальная GSD-модель: KABINET_STYLE_MODEL=... cargo test -- --ignored"]
    fn cancel_stops_long_parse_between_paragraphs() {
        let path = std::env::var("KABINET_STYLE_MODEL").expect("KABINET_STYLE_MODEL");
        let parser = Arc::new(StyleParser::new(PathBuf::from(path), None, None));
        parser.parse(0, "Он пришёл.").unwrap(); // прогреть модель
        let text = "Он пришёл.\n\n".repeat(1200);
        let p2 = parser.clone();
        let handle = std::thread::spawn(move || p2.parse(11, &text));
        std::thread::sleep(std::time::Duration::from_millis(40));
        parser.cancel(11);
        let value = handle.join().unwrap().unwrap();
        assert_eq!(value["taskId"], json!(11));
        assert_eq!(value["cancelled"], json!(true));
    }

    #[test]
    #[ignore = "нужна локальная GSD-модель: KABINET_STYLE_MODEL=... cargo test -- --ignored"]
    fn real_model_builds_contract_with_utf16_offsets() {
        let path = std::env::var("KABINET_STYLE_MODEL").expect("KABINET_STYLE_MODEL");
        let parser = StyleParser::new(PathBuf::from(path), None, None);
        let text = "Осуществление проверки выполнения требований затянулось. Дом, который стоял у реки, который видел лес, который шумел, продаётся.";
        let value = parser.parse(7, text).unwrap();
        assert_eq!(value["cancelled"], json!(false));
        let sentences = value["parse"]["sentences"].as_array().unwrap();
        assert_eq!(sentences.len(), 2);
        assert_eq!(sentences[0]["text"], "Осуществление проверки выполнения требований затянулось.");
        assert_eq!(sentences[1]["start"], json!("Осуществление проверки выполнения требований затянулось. ".encode_utf16().count()));
        assert!(sentences[1]["tokens"].as_array().unwrap().len() > 3);
        for sentence in sentences {
            let start = sentence["start"].as_u64().unwrap() as usize;
            let end = sentence["end"].as_u64().unwrap() as usize;
            let stext = sentence["text"].as_str().unwrap();
            assert_eq!(text.encode_utf16().skip(start).take(end - start).collect::<Vec<_>>(), stext.encode_utf16().collect::<Vec<_>>());
        }
    }

    #[test]
    fn missing_model_is_reported() {
        let p = StyleParser::new(PathBuf::from("/tmp/kabinet-no-model.udpipe"), None, None);
        let err = p.parse(1, "Он пришёл.").unwrap_err();
        assert!(err.contains("не найдена"), "{}", err);
    }
}
