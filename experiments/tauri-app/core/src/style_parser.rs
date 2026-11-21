//! Локальный синтаксический парсер для стилевого анализа.
//! Модель читается с диска (ресурс приложения/переменная окружения), не встраивается в код.
//! Результат — parser-neutral contract из src/style-engine/contract.js: UTF-16 offsets,
//! леммы, UPOS, feats, head/deprel. Модель не входит в репозиторий.

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use udpipe_rs::{Model, Word};

const DEFAULT_MODEL_VERSION: &str = "russian-gsd-ud-2.5-191206";
const DEFAULT_MODEL_SHA256: &str = "ba63e42f79f525cbcb78c8bc98dd126c2960cbada91b964a741285c15504f06a";

/// Имя файла модели во внешнем локальном каталоге.
pub const MODEL_FILE_NAME: &str = "russian-gsd-ud-2.5-191206.udpipe";

/// Где искать модель. Модель не входит в установщик (лицензионный статус CONDITIONAL).
///
/// Порядок: явный путь `KABINET_STYLE_MODEL`; затем `<каталог данных приложения>/style-models/` — внешний локальный
/// ресурс пользователя; затем `<каталог ресурсов>/style-models/` — для сборок, где поставка модели разрешена.
/// Берётся первый существующий файл. Если файла нет нигде, возвращается путь из каталога данных, и сообщение
/// об ошибке покажет, куда его положить. Явный путь не подменяется: ошибка будет именно про него.
pub fn resolve_model_path(explicit: Option<PathBuf>, data_dir: &Path, resource_dir: Option<&Path>) -> PathBuf {
    if let Some(p) = explicit { return p; }
    let user = data_dir.join("style-models").join(MODEL_FILE_NAME);
    if user.is_file() { return user; }
    if let Some(r) = resource_dir {
        let bundled = r.join("style-models").join(MODEL_FILE_NAME);
        if bundled.is_file() { return bundled; }
    }
    user
}

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
    let bytes = text.as_bytes();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'\n' || bytes[i] == b'\r' {
            let sep_start = i;
            let mut j = i;
            while j < bytes.len() && (bytes[j] == b'\n' || bytes[j] == b'\r') { j += 1; }
            if j - i >= 2 {
                if !text[start..sep_start].trim().is_empty() { out.push((start, sep_start)); }
                start = j;
            }
            i = j;
        } else {
            i += 1;
        }
    }
    if start < text.len() && !text[start..].trim().is_empty() { out.push((start, text.len())); }
    if out.is_empty() && !text.trim().is_empty() { out.push((0, text.len())); }
    out
}

/// Точное выравнивание форм парсера по исходнику: между токенами допускаем только whitespace,
/// затем требуем посимвольного совпадения. Никакого поиска «следующего вхождения».
///
/// UDPipe не считает пробелами U+0085, U+2028, U+2029, U+000B (перенос строки из Word) и U+000C
/// и оставляет их внутри формы токена, а `char::is_whitespace` их пропускает. Поэтому началом
/// токена может быть любая граница символа внутри непрерывной пробельной серии перед ним
/// (берётся первое совпадение), а ведущие и замыкающие пробельные символы формы в span не входят.
/// Токен из одних пробельных символов сохраняет свой точный span, чтобы не сбить `head`/`id`.
fn align_block(source: &str, block_start: usize, block_end: usize, words: &[RawToken]) -> Result<Vec<(usize, usize)>, String> {
    let mut spans = Vec::with_capacity(words.len());
    let mut at = block_start;
    for word in words {
        let mut run_end = at;
        while run_end < block_end {
            let ch = source[run_end..].chars().next().ok_or("Некорректная граница UTF-8.")?;
            if !ch.is_whitespace() { break; }
            run_end += ch.len_utf8();
        }
        let mut found = None;
        let mut p = at;
        loop {
            if source[p..block_end].starts_with(&word.form) { found = Some(p); break; }
            if p >= run_end { break; }
            p += source[p..].chars().next().ok_or("Некорректная граница UTF-8.")?.len_utf8();
        }
        let Some(p) = found else {
            let saw = source[run_end..block_end].chars().take(24).collect::<String>();
            return Err(format!(
                "Токен «{}» не совпадает с исходником в позиции {} (там «{}»). Разбор остановлен, offsets не публикуются.",
                word.form, run_end, saw
            ));
        };
        let form_end = p + word.form.len();
        let trimmed = word.form.trim_matches(char::is_whitespace);
        let (start, end) = if trimmed.is_empty() {
            (p, form_end)
        } else {
            let lead = word.form.len() - word.form.trim_start_matches(char::is_whitespace).len();
            (p + lead, p + lead + trimmed.len())
        };
        spans.push((start, end));
        at = form_end;
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
                // Подстрока исходника: инвариант text === source.slice(start, end) выполняется по построению.
                text: source[s..e].to_string(),
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

const MAX_CANCELLED_IDS: usize = 256;

struct TaskState {
    current: Option<(u64, Arc<AtomicBool>)>,
    cancelled: VecDeque<u64>,
}

pub struct StyleParser {
    model_path: PathBuf,
    model_version: String,
    model_sha256: String,
    loaded: Mutex<Option<Arc<Mutex<Model>>>>,
    tasks: Mutex<TaskState>,
}

impl StyleParser {
    pub fn new(model_path: PathBuf, model_version: Option<String>, model_sha256: Option<String>) -> Self {
        Self {
            model_path,
            model_version: model_version.unwrap_or_else(|| DEFAULT_MODEL_VERSION.to_string()),
            model_sha256: model_sha256.unwrap_or_else(|| DEFAULT_MODEL_SHA256.to_string()),
            loaded: Mutex::new(None),
            tasks: Mutex::new(TaskState { current: None, cancelled: VecDeque::new() }),
        }
    }

    /// Модель загружается один раз; хэш проверяется до Model::load.
    fn model(&self) -> Result<Arc<Mutex<Model>>, String> {
        let mut guard = self.loaded.lock().map_err(|_| "Внутренний замок парсера недоступен.".to_string())?;
        if let Some(model) = guard.as_ref() { return Ok(model.clone()); }
        let bytes = fs::read(&self.model_path).map_err(|e| format!("Модель стилевого анализа не найдена ({}): {}. Положите файл {} в этот каталог или задайте путь в KABINET_STYLE_MODEL.", self.model_path.display(), e, MODEL_FILE_NAME))?;
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
        if let Ok(mut tasks) = self.tasks.lock() {
            if let Some((id, flag)) = tasks.current.as_ref() {
                if *id == task_id {
                    flag.store(true, Ordering::SeqCst);
                    return;
                }
            }
            // Отмена могла прийти до того, как поток spawn_blocking зарегистрировал задачу.
            if !tasks.cancelled.contains(&task_id) {
                if tasks.cancelled.len() >= MAX_CANCELLED_IDS { tasks.cancelled.pop_front(); }
                tasks.cancelled.push_back(task_id);
            }
        }
    }

    pub fn parse(&self, task_id: u64, text: &str) -> Result<Value, String> {
        let flag = Arc::new(AtomicBool::new(false));
        {
            let mut tasks = self.tasks.lock().map_err(|_| "Внутренний замок задач недоступен.".to_string())?;
            if let Some(pos) = tasks.cancelled.iter().position(|&id| id == task_id) {
                tasks.cancelled.remove(pos);
                return Ok(json!({ "taskId": task_id, "cancelled": true }));
            }
            if let Some((_, old)) = tasks.current.replace((task_id, flag.clone())) { old.store(true, Ordering::SeqCst); }
        }
        let result = self.parse_inner(task_id, text, &flag);
        if let Ok(mut tasks) = self.tasks.lock() {
            if tasks.current.as_ref().map(|(id, _)| *id) == Some(task_id) { tasks.current = None; }
        }
        result
    }

    fn parse_inner(&self, task_id: u64, text: &str, cancel: &Arc<AtomicBool>) -> Result<Value, String> {
        if cancel.load(Ordering::SeqCst) {
            return Ok(json!({ "taskId": task_id, "cancelled": true }));
        }
        let model = self.model()?;
        let model = model.lock().map_err(|_| "Модель стилевого анализа занята.".to_string())?;
        if cancel.load(Ordering::SeqCst) {
            return Ok(json!({ "taskId": task_id, "cancelled": true }));
        }
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
    fn quotes_dash_ellipsis_have_exact_utf16_ranges() {
        let text = "Он сказал: «Привет!» — и ушёл…";
        let words = vec![
            raw(1, 0, "Он", 2), raw(2, 0, "сказал", 0), raw(3, 0, ":", 2),
            raw(4, 0, "«", 5), raw(5, 0, "Привет", 6), raw(6, 0, "!", 5),
            raw(7, 0, "»", 8), raw(8, 0, "—", 9), raw(9, 0, "и", 10),
            raw(10, 0, "ушёл", 9), raw(11, 0, "…", 10),
        ];
        let c = build_contract(text, &words, &parser()).unwrap();
        assert_eq!(c.sentences[0].tokens.iter().map(|t| (t.start, t.end)).collect::<Vec<_>>(), vec![(0, 2), (3, 9), (9, 10), (11, 12), (12, 18), (18, 19), (19, 20), (21, 22), (23, 24), (25, 29), (29, 30)]);
    }

    #[test]
    fn multiple_spaces_between_sentences_keep_offsets() {
        let text = "Он  пришёл.  Потом   ушёл.";
        let words = vec![
            raw(1, 0, "Он", 2), raw(2, 0, "пришёл", 0), raw(3, 0, ".", 2),
            raw(1, 1, "Потом", 2), raw(2, 1, "ушёл", 0), raw(3, 1, ".", 2),
        ];
        let c = build_contract(text, &words, &parser()).unwrap();
        assert_eq!(c.sentences.len(), 2);
        assert_eq!(c.sentences[0].tokens.iter().map(|t| (t.start, t.end)).collect::<Vec<_>>(), vec![(0, 2), (4, 10), (10, 11)]);
        assert_eq!(c.sentences[1].tokens.iter().map(|t| (t.start, t.end)).collect::<Vec<_>>(), vec![(13, 18), (21, 25), (25, 26)]);
    }

    #[test]
    fn abbreviations_and_repeated_forms_keep_exact_ranges() {
        let text = "Он жил в 5 г. до н. э. Потом ушёл.";
        let words = vec![
            raw(1, 0, "Он", 2), raw(2, 0, "жил", 0), raw(3, 0, "в", 2),
            raw(4, 0, "5", 2), raw(5, 0, "г", 4), raw(6, 0, ".", 5),
            raw(7, 0, "до", 8), raw(8, 0, "н", 7), raw(9, 0, ".", 8),
            raw(10, 0, "э", 7), raw(11, 0, ".", 10),
            raw(1, 1, "Потом", 2), raw(2, 1, "ушёл", 0), raw(3, 1, ".", 2),
        ];
        let c = build_contract(text, &words, &parser()).unwrap();
        assert_eq!(c.sentences.len(), 2);
        assert_eq!(c.sentences[0].tokens.iter().map(|t| (t.start, t.end)).collect::<Vec<_>>(), vec![(0, 2), (3, 6), (7, 8), (9, 10), (11, 12), (12, 13), (14, 16), (17, 18), (18, 19), (20, 21), (21, 22)]);
        assert_eq!(c.sentences[1].tokens.iter().map(|t| (t.start, t.end)).collect::<Vec<_>>(), vec![(23, 28), (29, 33), (33, 34)]);
    }

    #[test]
    fn blank_lines_split_paragraphs() {
        let text = "Первый.\n\n\nВторой.";
        let r = paragraph_ranges(text);
        assert_eq!(r.len(), 2);
        assert_eq!(&text[r[0].0..r[0].1], "Первый.");
        assert_eq!(&text[r[1].0..r[1].1], "Второй.");
    }

    #[test]
    fn repeated_tokens_are_not_found_by_later_search() {
        let text = "дом дом.";
        let words = vec![raw(1, 0, "дом", 3), raw(2, 0, "дом", 0), raw(3, 0, ".", 2)];
        let c = build_contract(text, &words, &parser()).unwrap();
        assert_eq!(c.sentences[0].tokens.iter().map(|t| (t.start, t.end)).collect::<Vec<_>>(), vec![(0, 3), (4, 7), (7, 8)]);
    }

    fn utf16_slice(text: &str, start: usize, end: usize) -> String {
        String::from_utf16(&text.encode_utf16().skip(start).take(end - start).collect::<Vec<u16>>()).unwrap()
    }

    /// UDPipe оставляет эти символы внутри формы токена, а Rust считает их пробелами.
    const NON_SPACE_SEPARATORS: [char; 5] = ['\u{85}', '\u{2028}', '\u{2029}', '\u{b}', '\u{c}'];

    #[test]
    fn separator_inside_token_form_is_aligned_and_trimmed() {
        for sep in NON_SPACE_SEPARATORS {
            let text = format!("Он пришёл.{sep}Потом ушёл.");
            let form = format!("{sep}Потом");
            let words = vec![
                raw(1, 0, "Он", 2), raw(2, 0, "пришёл", 0), raw(3, 0, ".", 2),
                raw(1, 1, &form, 2), raw(2, 1, "ушёл", 0), raw(3, 1, ".", 2),
            ];
            let c = build_contract(&text, &words, &parser()).unwrap_or_else(|e| panic!("U+{:04X}: {}", sep as u32, e));
            let s2 = &c.sentences[1];
            assert_eq!(s2.tokens[0].text, "Потом", "U+{:04X}", sep as u32);
            assert_eq!((s2.tokens[0].start, s2.tokens[0].end), (11, 16), "U+{:04X}", sep as u32);
            assert_eq!((s2.start, s2.end), (11, 22), "U+{:04X}", sep as u32);
            for t in c.sentences.iter().flat_map(|s| s.tokens.iter()) {
                assert_eq!(utf16_slice(&text, t.start, t.end), t.text, "U+{:04X}", sep as u32);
            }
        }
    }

    #[test]
    fn leading_double_and_whitespace_only_separator_tokens_keep_exact_ranges() {
        let sep = '\u{b}';
        // ведущий
        let text = format!("{sep}Он пришёл.");
        let words = vec![raw(1, 0, &format!("{sep}Он"), 2), raw(2, 0, "пришёл", 0), raw(3, 0, ".", 2)];
        let c = build_contract(&text, &words, &parser()).unwrap();
        assert_eq!((c.sentences[0].tokens[0].start, c.sentences[0].tokens[0].end), (1, 3));
        assert_eq!(c.sentences[0].tokens[0].text, "Он");
        // двойной
        let text = format!("Он пришёл.{sep}{sep}Потом ушёл.");
        let words = vec![
            raw(1, 0, "Он", 2), raw(2, 0, "пришёл", 0), raw(3, 0, ".", 2),
            raw(1, 1, &format!("{sep}{sep}Потом"), 2), raw(2, 1, "ушёл", 0), raw(3, 1, ".", 2),
        ];
        let c = build_contract(&text, &words, &parser()).unwrap();
        assert_eq!((c.sentences[1].tokens[0].start, c.sentences[1].tokens[0].end), (12, 17));
        // токен только из такого символа: span точный, текст — сам символ
        let text = format!("Он пришёл.{sep}");
        let words = vec![raw(1, 0, "Он", 2), raw(2, 0, "пришёл", 0), raw(3, 0, ".", 2), raw(4, 0, &sep.to_string(), 2)];
        let c = build_contract(&text, &words, &parser()).unwrap();
        let last = c.sentences[0].tokens.last().unwrap();
        assert_eq!((last.start, last.end, last.text.as_str()), (10, 11, "\u{b}"));
    }

    #[test]
    fn separator_does_not_allow_skipping_a_different_token() {
        // Пробельная серия допускает только совпадение формы, а не пропуск чужого текста.
        let text = "Он\u{2028}пришёл.";
        let words = vec![raw(1, 0, "Он", 2), raw(2, 0, "ушёл", 0)];
        assert!(build_contract(text, &words, &parser()).is_err());
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
    #[ignore = "нужна локальная GSD-модель: KABINET_STYLE_MODEL=... cargo test -- --ignored"]
    fn real_model_survives_non_space_separators() {
        let path = std::env::var("KABINET_STYLE_MODEL").expect("KABINET_STYLE_MODEL");
        let parser = StyleParser::new(PathBuf::from(path), None, std::env::var("KABINET_STYLE_MODEL_SHA256").ok());
        for sep in NON_SPACE_SEPARATORS {
            for text in [
                format!("Он пришёл.{sep}Потом ушёл."),
                format!("{sep}Он пришёл домой."),
                format!("Он пришёл домой.{sep}"),
                format!("Он пришёл.{sep}{sep}Потом ушёл."),
            ] {
                let value = parser.parse(1, &text).unwrap_or_else(|e| panic!("U+{:04X} в «{}»: {}", sep as u32, text.escape_unicode(), e));
                assert_eq!(value["cancelled"], json!(false));
                for sentence in value["parse"]["sentences"].as_array().unwrap() {
                    for token in sentence["tokens"].as_array().unwrap() {
                        let (s, e) = (token["start"].as_u64().unwrap() as usize, token["end"].as_u64().unwrap() as usize);
                        assert_eq!(utf16_slice(&text, s, e), token["text"].as_str().unwrap());
                    }
                }
            }
        }
    }

    #[test]
    fn model_path_prefers_explicit_then_user_dir_then_resources() {
        let tmp = std::env::temp_dir().join(format!("kabinet-model-path-{}", std::process::id()));
        let (data, res) = (tmp.join("data"), tmp.join("res"));
        for d in [&data, &res] { std::fs::create_dir_all(d.join("style-models")).unwrap(); }
        let user = data.join("style-models").join(MODEL_FILE_NAME);
        let bundled = res.join("style-models").join(MODEL_FILE_NAME);
        // ничего нет: путь пользователя, чтобы ошибка сказала, куда положить файл
        assert_eq!(resolve_model_path(None, &data, Some(&res)), user);
        std::fs::write(&bundled, b"x").unwrap();
        assert_eq!(resolve_model_path(None, &data, Some(&res)), bundled);
        std::fs::write(&user, b"x").unwrap();
        assert_eq!(resolve_model_path(None, &data, Some(&res)), user);
        // явный путь не подменяется, даже если его нет
        let explicit = tmp.join("nope.udpipe");
        assert_eq!(resolve_model_path(Some(explicit.clone()), &data, Some(&res)), explicit);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn missing_model_message_says_where_to_put_it() {
        let p = StyleParser::new(PathBuf::from("/tmp/kabinet-no-model-x/m.udpipe"), None, None);
        let err = p.parse(1, "Он пришёл.").unwrap_err();
        assert!(err.contains("не найдена") && err.contains(MODEL_FILE_NAME) && err.contains("KABINET_STYLE_MODEL"), "{}", err);
    }

    #[test]
    fn cancel_before_parse_registration_returns_cancelled() {
        let p = StyleParser::new(PathBuf::from("/tmp/kabinet-no-model-cancel.udpipe"), None, None);
        p.cancel(42);
        let res = p.parse(42, "Он пришёл.").unwrap();
        assert_eq!(res["taskId"], json!(42));
        assert_eq!(res["cancelled"], json!(true));
        // Повторный запуск другой задачи не должен быть отменён.
        let err = p.parse(43, "Он пришёл.").unwrap_err();
        assert!(err.contains("не найдена"), "{}", err);
    }

    #[test]
    #[ignore = "нужна локальная GSD-модель: KABINET_STYLE_MODEL=... cargo test -- --ignored"]
    fn real_model_handles_crlf_bom_and_paragraph_boundaries() {
        let path = std::env::var("KABINET_STYLE_MODEL").expect("KABINET_STYLE_MODEL");
        let parser = StyleParser::new(PathBuf::from(path), None, std::env::var("KABINET_STYLE_MODEL_SHA256").ok());
        let cases = [
            "\u{FEFF}Он пришёл домой. Потом ушёл.",
            "Он \u{FEFF}пришёл домой.",
            "Первый абзац.\r\n\r\nВторой\u{00a0}абзац\u{200b} с 😀.",
            "Строка один.\r\nСтрока два.",
            "Первый.\u{2028}Второй.\u{2029}Третий.",
        ];
        for text in cases {
            let value = parser.parse(1, text).unwrap_or_else(|e| panic!("«{}»: {}", text.escape_unicode(), e));
            assert_eq!(value["cancelled"], json!(false));
            for sentence in value["parse"]["sentences"].as_array().unwrap() {
                let (ss, se) = (sentence["start"].as_u64().unwrap() as usize, sentence["end"].as_u64().unwrap() as usize);
                assert_eq!(utf16_slice(text, ss, se), sentence["text"].as_str().unwrap());
                for token in sentence["tokens"].as_array().unwrap() {
                    let (s, e) = (token["start"].as_u64().unwrap() as usize, token["end"].as_u64().unwrap() as usize);
                    assert_eq!(utf16_slice(text, s, e), token["text"].as_str().unwrap());
                }
            }
        }
    }

    #[test]
    fn missing_model_is_reported() {
        let p = StyleParser::new(PathBuf::from("/tmp/kabinet-no-model.udpipe"), None, None);
        let err = p.parse(1, "Он пришёл.").unwrap_err();
        assert!(err.contains("не найдена"), "{}", err);
    }
}
