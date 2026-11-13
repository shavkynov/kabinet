//! Импорт текста в проект: .docx, .rtf, .md и .txt превращаются в главы (название + Markdown). Порт src/import.js.
use fancy_regex::Regex;
use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::sync::LazyLock;

pub const MAX_FILE: usize = 30 * 1024 * 1024;
const MAX_XML: u64 = 200 * 1024 * 1024;
const MAX_TITLE: usize = 120;

macro_rules! re {
    ($name:ident, $p:expr) => { static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($p).unwrap()); };
}

fn is_ws(c: char) -> bool { c.is_whitespace() || c == '\u{feff}' }
fn jtrim(s: &str) -> &str { s.trim_matches(is_ws) }
fn m(re: &Regex, s: &str) -> bool { re.is_match(s).unwrap_or(false) }
fn caps<'a>(re: &Regex, s: &'a str) -> Option<fancy_regex::Captures<'a>> { re.captures(s).ok().flatten() }
fn rep(re: &Regex, s: &str, to: &str) -> String { re.replace_all(s, to).into_owned() }
fn rep1(re: &Regex, s: &str, to: &str) -> String { re.replace(s, to).into_owned() }

fn normalize(s: &str) -> String {
    let s = s.strip_prefix('\u{feff}').unwrap_or(s);
    s.replace("\r\n", "\n").replace('\r', "\n").replace(['\u{2028}', '\u{2029}', '\0'], "\n")
}

// ---------- кодировка ----------
pub fn decode_text(buf: &[u8]) -> String {
    if buf.len() >= 2 && buf[0] == 0xff && buf[1] == 0xfe {
        return encoding_rs::UTF_16LE.decode_without_bom_handling(&buf[2..]).0.into_owned();
    }
    if buf.len() >= 2 && buf[0] == 0xfe && buf[1] == 0xff {
        return encoding_rs::UTF_16BE.decode_without_bom_handling(&buf[2..]).0.into_owned();
    }
    match std::str::from_utf8(buf) {
        Ok(s) => s.to_string(),
        Err(_) => encoding_rs::WINDOWS_1251.decode_without_bom_handling(buf).0.into_owned(),
    }
}

// ---------- обычный текст ----------
re!(ESC_INLINE, r"([\\*_`])");
re!(ESC_HASH, r"^#");
re!(ESC_GT, r"^>");
re!(ESC_LIST, r"^([-+])(?=\s)");
re!(ESC_NUM, r"^(\d+)([.)])(?=\s)");
re!(SEP_TEXT, r"^[\s*#~_=\-—–•·]+$");
re!(CHAPTER_LINE, r"(?i)^(?:(?:глава|часть|chapter|part)\s+(?:\d+|[IVXLC]+|(?:перв|втор|трет|четвёрт|четверт|пят|шест|седьм|восьм|девят|десят|одиннадцат|двенадцат)[а-яё]*)(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_])).{0,60}|пролог\.?|эпилог\.?|prologue\.?|epilogue\.?)$");
re!(DIALOG_DASH, r"^[-–]\s+");

fn escape_inline(s: &str) -> String { rep(&ESC_INLINE, s, "\\$1") }
fn escape_start(line: &str) -> String {
    let l = rep1(&ESC_HASH, line, "\\#");
    let l = rep1(&ESC_GT, &l, "\\>");
    let l = rep1(&ESC_LIST, &l, "\\$1");
    rep1(&ESC_NUM, &l, "$1\\$2")
}
fn is_separator_text(t: &str) -> bool { m(&SEP_TEXT, t) && t.chars().filter(|c| !c.is_whitespace()).count() >= 3 }
fn finish_para(rendered: &str, raw: &str) -> String {
    if is_separator_text(raw) { return "---".into(); }
    escape_start(&rep1(&DIALOG_DASH, rendered, "— "))
}

pub fn txt_to_markdown(text: &str) -> String {
    let lines: Vec<String> = normalize(text).split('\n').map(|l| l.trim_end_matches(is_ws).to_string()).collect();
    let mut blocks: Vec<Vec<String>> = Vec::new();
    let mut cur: Vec<String> = Vec::new();
    for l in &lines {
        if !jtrim(l).is_empty() { cur.push(jtrim(l).to_string()); }
        else if !cur.is_empty() { blocks.push(std::mem::take(&mut cur)); }
    }
    if !cur.is_empty() { blocks.push(cur); }
    let multi = blocks.iter().filter(|b| b.len() > 1).count();
    let wrapped = blocks.len() > 1 && multi as f64 / blocks.len() as f64 > 0.6;
    let paras: Vec<String> = if wrapped { blocks.iter().map(|b| b.join(" ")).collect() } else { blocks.into_iter().flatten().collect() };
    paras.iter().map(|p| {
        if p.encode_utf16().count() <= 70 && m(&CHAPTER_LINE, p) { format!("# {}", p.strip_suffix('.').unwrap_or(p)) }
        else { finish_para(&escape_inline(p), p) }
    }).collect::<Vec<_>>().join("\n\n")
}

// ---------- Markdown ----------
re!(YAML_HEAD, r"(?s)^---\n(.*?)\n---[ \t]*(?:\n|$)");
re!(YAML_KEY, r"^[A-Za-z0-9_-]+\s*:");

pub fn md_prepare(text: &str) -> String {
    let s = normalize(text);
    if let Some(c) = caps(&YAML_HEAD, &s) {
        if m(&YAML_KEY, c.get(1).unwrap().as_str()) && c.get(1).unwrap().as_str().split('\n').count() <= 40 {
            return s[c.get(0).unwrap().end()..].to_string();
        }
    }
    s
}

// ---------- разбиение на главы ----------
re!(CONTENTS_TITLE, r"(?i)^(содержание|оглавление|contents|table of contents)$");
re!(CT_ESC, r"\\([\\*_`#>\-+.)])");
re!(CT_MARKS, r"[*_`]");
re!(CT_NUM, r"^\d+[.)]\s+");
re!(WS_RUN, r"\s+");
re!(HEADING_LINE, r"^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$");
re!(FENCE, r"^\s*(```|~~~)");

fn clean_title(s: &str, fallback: &str) -> String {
    let t = rep(&CT_ESC, s, "$1");
    let t = rep(&CT_MARKS, &t, "");
    let t = rep1(&CT_NUM, &t, "");
    let t = rep(&WS_RUN, &t, " ");
    let t: String = jtrim(&t).chars().take(MAX_TITLE).collect();
    let t = jtrim(&t).to_string();
    if t.is_empty() { fallback.to_string() } else { t }
}

struct Head { i: usize, level: usize, text: String }

fn heading_of(line: &str) -> Option<(usize, String)> {
    let c = caps(&HEADING_LINE, line)?;
    let text = c.get(2)?.as_str();
    if jtrim(&text.replace('#', "")).is_empty() { return None; }
    Some((c.get(1)?.as_str().len(), text.to_string()))
}

#[derive(Clone, Debug, PartialEq)]
pub struct Chapter { pub title: String, pub text: String }

pub fn split_markdown(md: &str, fallback: &str) -> Vec<Chapter> {
    let norm = normalize(md);
    let lines: Vec<&str> = norm.split('\n').collect();
    let mut heads: Vec<Head> = Vec::new();
    let mut fence = false;
    for (i, line) in lines.iter().enumerate() {
        if m(&FENCE, line) { fence = !fence; continue; }
        if fence { continue; }
        if let Some((level, text)) = heading_of(line) { heads.push(Head { i, level, text }); }
    }
    let body = |from: usize, to: usize| jtrim(&lines[from.min(lines.len())..to.min(lines.len())].join("\n")).to_string();
    let mut chapters: Vec<Chapter> = Vec::new();
    let mut count: BTreeMap<usize, usize> = BTreeMap::new();
    for h in &heads { *count.entry(h.level).or_default() += 1; }
    let level = count.iter().find(|(_, c)| **c >= 2).map(|(l, _)| *l);

    if let Some(level) = level {
        let bounds: Vec<&Head> = heads.iter().filter(|h| h.level == level).collect();
        let preface = lines[..bounds[0].i].iter().any(|l| !jtrim(l).is_empty() && heading_of(l).is_none());
        if preface { chapters.push(Chapter { title: fallback.to_string(), text: body(0, bounds[0].i) }); }
        for (k, h) in bounds.iter().enumerate() {
            let end = if k + 1 < bounds.len() { bounds[k + 1].i } else { lines.len() };
            chapters.push(Chapter { title: clean_title(&h.text, &format!("{} {}", fallback, k + 1)), text: body(h.i + 1, end) });
        }
    } else {
        let first = lines.iter().position(|l| !jtrim(l).is_empty());
        let only = if heads.len() == 1 && Some(heads[0].i) == first { Some(&heads[0]) } else { None };
        let lowest = heads.iter().map(|h| h.level).min().unwrap_or(0);
        let lead = match (first, heads.first()) {
            (Some(f), Some(h0)) if h0.i == f && h0.level == lowest && count.get(&lowest) == Some(&1) => Some(h0),
            _ => None,
        };
        match only.or(lead) {
            Some(h) => chapters.push(Chapter { title: clean_title(&h.text, fallback), text: body(h.i + 1, lines.len()) }),
            None => chapters.push(Chapter { title: clean_title(fallback, "Импорт"), text: body(0, lines.len()) }),
        }
    }
    chapters.retain(|c| !(m(&CONTENTS_TITLE, &c.title) && c.text.split('\n').filter(|l| !jtrim(l).is_empty()).all(|l| l.encode_utf16().count() < 80)));
    let mut idx = 0;
    chapters.retain(|c| { let keep = !c.title.is_empty() || !c.text.is_empty() || idx == 0; idx += 1; keep });
    chapters.retain(|c| !c.title.is_empty());
    chapters
}

// ---------- docx ----------
type R<T> = Result<T, String>;

fn read_zip(buf: &[u8]) -> R<HashMap<String, Vec<u8>>> {
    let err = || "Файл не похож на документ Word (.docx).".to_string();
    let rd16 = |p: usize| -> Option<usize> { buf.get(p..p + 2).map(|b| u16::from_le_bytes([b[0], b[1]]) as usize) };
    let rd32 = |p: usize| -> Option<usize> { buf.get(p..p + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize) };
    if buf.len() < 22 { return Err(err()); }
    let lo = buf.len().saturating_sub(65557);
    let eocd = (lo..=buf.len() - 22).rev().find(|&i| rd32(i) == Some(0x06054b50)).ok_or_else(err)?;
    let count = rd16(eocd + 10).ok_or_else(err)?;
    let mut p = rd32(eocd + 16).ok_or_else(err)?;
    let mut files = HashMap::new();
    for _ in 0..count {
        if p + 46 > buf.len() || rd32(p) != Some(0x02014b50) { break; }
        let method = rd16(p + 10).unwrap_or(99);
        let csize = rd32(p + 20).unwrap_or(0);
        let (nlen, elen, clen) = (rd16(p + 28).unwrap_or(0), rd16(p + 30).unwrap_or(0), rd16(p + 32).unwrap_or(0));
        let local = rd32(p + 42).unwrap_or(usize::MAX);
        let name = String::from_utf8_lossy(buf.get(p + 46..p + 46 + nlen).unwrap_or(&[])).to_string();
        p += 46 + nlen + elen + clen;
        if name != "word/document.xml" && name != "word/styles.xml" { continue; }
        if local.saturating_add(30) > buf.len() || rd32(local) != Some(0x04034b50) { continue; }
        let start = local + 30 + rd16(local + 26).unwrap_or(0) + rd16(local + 28).unwrap_or(0);
        let data = buf.get(start..(start + csize).min(buf.len())).unwrap_or(&[]);
        match method {
            0 => { files.insert(name, data.to_vec()); }
            8 => {
                let mut out = Vec::new();
                let mut dec = flate2::read::DeflateDecoder::new(data).take(MAX_XML + 1);
                dec.read_to_end(&mut out).map_err(|e| format!("Не удалось распаковать документ: {}", e))?;
                if out.len() as u64 > MAX_XML { return Err("Документ слишком велик после распаковки.".into()); }
                files.insert(name, out);
            }
            _ => {}
        }
    }
    Ok(files)
}

re!(XML_HEX, r"(?i)&#x([0-9a-f]+);");
re!(XML_DEC, r"&#(\d+);");

fn decode_xml(s: &str) -> String {
    let s = XML_HEX.replace_all(s, |c: &fancy_regex::Captures| u32::from_str_radix(&c[1], 16).ok().and_then(char::from_u32).map(String::from).unwrap_or_default()).into_owned();
    let s = XML_DEC.replace_all(&s, |c: &fancy_regex::Captures| c[1].parse::<u32>().ok().and_then(char::from_u32).map(String::from).unwrap_or_default()).into_owned();
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

re!(ATTR_OUTLINE, r#"<w:outlineLvl\b[^>]*\sw:val="([^"]*)""#);
re!(ATTR_NUMID, r#"<w:numId\b[^>]*\sw:val="([^"]*)""#);
re!(ATTR_PSTYLE, r#"<w:pStyle\b[^>]*\sw:val="([^"]*)""#);
re!(ATTR_NAME, r#"<w:name\b[^>]*\sw:val="([^"]*)""#);
re!(ATTR_BASED, r#"<w:basedOn\b[^>]*\sw:val="([^"]*)""#);
fn attr(re: &Regex, xml: &str) -> Option<String> { caps(re, xml).map(|c| decode_xml(c.get(1).unwrap().as_str())) }

#[derive(Clone, Debug)]
struct Style { name: String, outline: Option<i32>, based_on: Option<String> }

re!(STYLE_BLOCK, r#"(?s)<w:style\b[^>]*\sw:styleId="([^"]+)"[^>]*>(.*?)</w:style>"#);

fn read_styles(xml: &str) -> HashMap<String, Style> {
    let mut map = HashMap::new();
    for c in STYLE_BLOCK.captures_iter(xml).flatten() {
        let body = c.get(2).unwrap().as_str();
        let outline = attr(&ATTR_OUTLINE, body).and_then(|v| v.parse::<i32>().ok());
        map.insert(c.get(1).unwrap().as_str().to_string(), Style { name: attr(&ATTR_NAME, body).unwrap_or_default().to_lowercase(), outline, based_on: attr(&ATTR_BASED, body) });
    }
    map
}

#[derive(Default, Clone, Debug)]
struct Kind { level: Option<usize>, title: bool, toc: bool, quote: bool }

re!(K_HEAD1, r"^(?:heading|заголовок)\s*(\d)$");
re!(K_HEAD2, r"^heading(\d)$");
re!(K_TITLE, r"^(title|название|заголовок)$");
re!(K_TOC, r"^(?:toc|оглавление)\s*\d|^(?:toc|contents)\b|^оглавление");
re!(K_TOC_ID, r"(?i)^toc\d");
re!(K_QUOTE, r"quote|цитата");

fn style_kind(styles: &HashMap<String, Style>, id: Option<&str>, depth: usize) -> Kind {
    let Some(id) = id else { return Kind::default() };
    let st = styles.get(id);
    let name = st.map(|s| s.name.clone()).unwrap_or_else(|| id.to_lowercase());
    if let Some(c) = caps(&K_HEAD1, &name).or_else(|| caps(&K_HEAD2, &name)) {
        return Kind { level: Some(c[1].parse::<usize>().unwrap_or(1).min(6)), ..Default::default() };
    }
    if m(&K_TITLE, &name) { return Kind { title: true, ..Default::default() }; }
    if m(&K_TOC, &name) || m(&K_TOC_ID, id) { return Kind { toc: true, ..Default::default() }; }
    if m(&K_QUOTE, &name) { return Kind { quote: true, ..Default::default() }; }
    if let Some(st) = st {
        if let Some(o) = st.outline { if o <= 5 { return Kind { level: Some((o + 1).max(0) as usize), ..Default::default() }; } }
        if let Some(b) = &st.based_on { if depth < 5 { return style_kind(styles, Some(b), depth + 1); } }
    }
    Kind::default()
}

#[derive(Clone, Debug)]
struct Seg { text: String, b: bool, i: bool }

struct Para { segs: Vec<Seg>, kind: Kind, outline: Option<i32>, list: bool }

fn flag(rpr: &str, tag: &str) -> bool {
    let re = Regex::new(&format!(r#"<w:{}(?:\s+w:val="([^"]*)")?\s*/>"#, tag)).unwrap();
    match caps(&re, rpr) {
        Some(c) => { let v = c.get(1).map(|x| x.as_str()).unwrap_or(""); !matches!(v.to_lowercase().as_str(), "0" | "false" | "off") }
        None => false,
    }
}

re!(RUN, r"(?s)<w:r(?:\s[^>]*[^/>])?>(.*?)</w:r>");
re!(RPR, r"(?s)<w:rPr>(.*?)</w:rPr>");
re!(TOKEN, r"(?s)<w:t(?:\s[^>]*)?>(.*?)</w:t>|<w:tab\s*/>|<w:br\b([^>]*)/>|<w:noBreakHyphen\s*/>");
re!(BR_PAGE, r#"w:type="(page|column)""#);

fn paragraph_runs(inner: &str) -> Vec<Seg> {
    let mut segs: Vec<Seg> = Vec::new();
    for rm in RUN.captures_iter(inner).flatten() {
        let run = rm.get(1).unwrap().as_str();
        let rpr = caps(&RPR, run).map(|c| c.get(1).unwrap().as_str().to_string()).unwrap_or_default();
        if flag(&rpr, "vanish") { continue; }
        let (b, i) = (flag(&rpr, "b"), flag(&rpr, "i"));
        let stripped = RPR.replace(run, "").into_owned();
        let mut text = String::new();
        for tm in TOKEN.captures_iter(&stripped).flatten() {
            let whole = tm.get(0).unwrap().as_str();
            if let Some(g1) = tm.get(1) { text.push_str(&decode_xml(g1.as_str())); }
            else if whole.starts_with("<w:tab") { text.push('\t'); }
            else if whole.starts_with("<w:noBreak") { text.push('-'); }
            else if !m(&BR_PAGE, tm.get(2).map(|x| x.as_str()).unwrap_or("")) { text.push('\n'); }
        }
        if text.is_empty() { continue; }
        match segs.last_mut() {
            Some(l) if l.b == b && l.i == i => l.text.push_str(&text),
            _ => segs.push(Seg { text, b, i }),
        }
    }
    segs
}

fn render_runs(segs: &[Seg]) -> String {
    let mut out = String::new();
    for s in segs {
        let t = &s.text;
        let lead_len = t.len() - t.trim_start_matches(|c: char| c.is_whitespace()).len();
        let rest = &t[lead_len..];
        let core_raw = rest.trim_end_matches(|c: char| c.is_whitespace());
        let (lead, trail) = (&t[..lead_len], &rest[core_raw.len()..]);
        let core = escape_inline(core_raw).replace('\n', "  \n");
        if jtrim(&core).is_empty() { out.push_str(&t.replace('\n', "  \n")); continue; }
        let mark = format!("{}{}", if s.b { "**" } else { "" }, if s.i { "*" } else { "" });
        let rev = format!("{}{}", if s.i { "*" } else { "" }, if s.b { "**" } else { "" });
        out.push_str(&format!("{}{}{}{}{}", lead, mark, core, rev, trail));
    }
    out
}

re!(BULLET, r"^[•·▪●◦■]\s");
re!(BULLET_STRIP, r"^[•·▪●◦■]\s*");

fn paras_to_markdown(paras: &[Para]) -> String {
    struct Block { level: Option<usize>, title: bool, md: String }
    let mut blocks: Vec<Block> = Vec::new();
    for pa in paras {
        if pa.kind.toc { continue; }
        let joined: String = pa.segs.iter().map(|s| s.text.as_str()).collect();
        let raw = jtrim(&joined.replace('\t', " ").replace('\n', " ")).to_string();
        if raw.is_empty() { continue; }
        let level = pa.kind.level.or(match pa.outline { Some(o) if o <= 5 => Some((o + 1).max(0) as usize), _ => None }).filter(|l| *l > 0);
        if is_separator_text(&raw) { blocks.push(Block { level: None, title: false, md: "---".into() }); continue; }
        if let Some(l) = level { blocks.push(Block { level: Some(l), title: false, md: format!("{} {}", "#".repeat(l), raw) }); continue; }
        if pa.kind.title { blocks.push(Block { level: None, title: true, md: format!("# {}", raw) }); continue; }
        let segs: Vec<Seg> = pa.segs.iter().map(|x| Seg { text: x.text.replace('\t', " "), b: x.b, i: if pa.kind.quote { false } else { x.i } }).collect();
        let text = render_runs(&segs).trim_matches(|c: char| c.is_whitespace()).to_string();
        if pa.kind.quote { blocks.push(Block { level: None, title: false, md: format!("> {}", text.replace('\n', "\n> ")) }); continue; }
        if pa.list { blocks.push(Block { level: None, title: false, md: format!("- {}", text) }); continue; }
        if m(&BULLET, &raw) { blocks.push(Block { level: None, title: false, md: format!("- {}", rep1(&BULLET_STRIP, &text, "")) }); continue; }
        blocks.push(Block { level: None, title: false, md: finish_para(&text, &raw) });
    }
    let has_heads = blocks.iter().any(|b| b.level.is_some());
    blocks.iter().filter(|b| !(b.title && has_heads)).map(|b| b.md.as_str()).collect::<Vec<_>>().join("\n\n")
}

re!(MC_FALLBACK, r"(?s)<mc:Fallback>.*?</mc:Fallback>");
re!(TXBX, r"(?s)<w:txbxContent>.*?</w:txbxContent>");
re!(PARA_BLOCK, r"(?s)<w:p\b[^>]*?(?:/>|>(.*?)</w:p>)");
re!(PPR, r"(?s)<w:pPr>(.*?)</w:pPr>");

pub fn docx_to_markdown(buf: &[u8]) -> R<String> {
    let files = read_zip(buf)?;
    let doc = files.get("word/document.xml").ok_or("В файле нет текста документа Word.")?;
    let styles = read_styles(&files.get("word/styles.xml").map(|b| String::from_utf8_lossy(b).to_string()).unwrap_or_default());
    let xml = String::from_utf8_lossy(doc).to_string();
    let xml = rep(&MC_FALLBACK, &xml, "");
    let xml = rep(&TXBX, &xml, "");
    let mut paras = Vec::new();
    for pm in PARA_BLOCK.captures_iter(&xml).flatten() {
        let Some(inner) = pm.get(1) else { continue };
        let inner = inner.as_str();
        let ppr = caps(&PPR, inner).map(|c| c.get(1).unwrap().as_str().to_string()).unwrap_or_default();
        let num_id = attr(&ATTR_NUMID, &ppr);
        paras.push(Para {
            segs: paragraph_runs(&PPR.replace(inner, "")),
            kind: style_kind(&styles, attr(&ATTR_PSTYLE, &ppr).as_deref(), 0),
            outline: attr(&ATTR_OUTLINE, &ppr).and_then(|v| v.parse().ok()),
            list: ppr.contains("<w:numPr>") && num_id.map(|n| !n.is_empty() && n != "0").unwrap_or(false),
        });
    }
    Ok(paras_to_markdown(&paras))
}

// ---------- rtf ----------
const RTF_SKIP: [&str; 42] = ["fonttbl", "colortbl", "info", "pict", "header", "headerl", "headerr", "headerf", "footer", "footerl", "footerr", "footerf",
    "footnote", "themedata", "datastore", "listtable", "listoverridetable", "rsidtbl", "generator", "filetbl", "revtbl", "latentstyles",
    "colorschememapping", "xmlnstbl", "pgptbl", "object", "shp", "listtext", "pntext", "pn", "bkmkstart", "bkmkend", "fldinst",
    "", "", "", "", "", "", "", "", ""];

fn rtf_char(word: &str) -> Option<&'static str> {
    Some(match word {
        "emdash" => "—", "endash" => "–", "bullet" => "•", "lquote" => "‘", "rquote" => "’", "ldblquote" => "“", "rdblquote" => "”",
        "emspace" | "enspace" | "qmspace" => " ",
        _ => return None,
    })
}

fn rtf_codepage(n: i32) -> Option<&'static str> {
    Some(match n { 1250 => "windows-1250", 1251 => "windows-1251", 1252 => "windows-1252", 1253 => "windows-1253", 1254 => "windows-1254", 1257 => "windows-1257", 10000 => "macintosh", 65001 => "utf-8", _ => return None })
}

#[derive(Clone)]
struct RSt { b: bool, i: bool, hidden: bool, skip: bool, sheet: bool, uc: i32 }

struct RtfCur { segs: Vec<Seg>, style: Option<i32>, outline: Option<i32>, list: bool }
impl RtfCur { fn new() -> Self { RtfCur { segs: vec![], style: None, outline: None, list: false } } }

fn rtf_paragraphs(src: &[char]) -> Vec<Para> {
    let mut sheet: HashMap<i32, (String, Option<i32>)> = HashMap::new();
    let mut paras: Vec<RtfCur> = Vec::new();
    let mut stack: Vec<RSt> = Vec::new();
    let mut st = RSt { b: false, i: false, hidden: false, skip: false, sheet: false, uc: 1 };
    let mut cp = "windows-1252";
    let mut cur = RtfCur::new();
    let mut bytes: Vec<u8> = Vec::new();
    let mut skip_chars: i32 = 0;
    let mut first = false;
    let mut sheet_num: Option<i32> = None;
    let mut sheet_name = String::new();
    let mut sheet_outline: Option<i32> = None;
    let mut high: Option<u16> = None;
    let skip_set: std::collections::HashSet<&str> = RTF_SKIP.iter().copied().filter(|s| !s.is_empty()).collect();

    macro_rules! add {
        ($text:expr) => {{
            let text: String = $text;
            if st.sheet {
                match text.find(';') {
                    None => sheet_name.push_str(&text),
                    Some(k) => {
                        sheet_name.push_str(&text[..k]);
                        // take() и читает, и обнуляет оба поля: так сбрасываем состояние таблицы после каждого поля
                        // и не оставляем присваиваний, которые компилятор считает мёртвыми (в конце разбора).
                        let (num, outline) = (sheet_num.take(), sheet_outline.take());
                        if let Some(n) = num { sheet.insert(n, (sheet_name.trim().to_lowercase(), outline)); }
                        sheet_name.clear();
                    }
                }
            } else if !(st.skip || st.hidden || text.is_empty()) {
                match cur.segs.last_mut() {
                    Some(l) if l.b == st.b && l.i == st.i => l.text.push_str(&text),
                    _ => cur.segs.push(Seg { text, b: st.b, i: st.i }),
                }
            }
        }};
    }
    macro_rules! flush_bytes {
        () => {{
            if !bytes.is_empty() {
                let enc = encoding_rs::Encoding::for_label(cp.as_bytes()).unwrap_or(encoding_rs::WINDOWS_1252);
                let t = enc.decode_without_bom_handling(&bytes).0.into_owned();
                bytes.clear();
                add!(t);
            }
        }};
    }
    macro_rules! end_para {
        () => {{
            if !(st.skip || st.sheet) { paras.push(std::mem::replace(&mut cur, RtfCur::new())); }
        }};
    }
    let is_alpha = |c: char| c.is_ascii_alphabetic();

    let mut i = 0;
    while i < src.len() {
        let ch = src[i];
        let was_first = first;
        if ch == '{' {
            flush_bytes!();
            stack.push(st.clone());
            first = true;
            i += 1;
        } else if ch == '}' {
            flush_bytes!();
            if let Some(s) = stack.pop() { st = s; }
            first = false;
            i += 1;
        } else if ch == '\\' {
            first = false;
            let Some(&nx) = src.get(i + 1) else { break };
            if is_alpha(nx) {
                flush_bytes!();
                let mut j = i + 1;
                while j < src.len() && is_alpha(src[j]) { j += 1; }
                let word: String = src[i + 1..j].iter().collect();
                let mut param: Option<i32> = None;
                let mut has_param = false;
                let mut k = j;
                if src.get(k) == Some(&'-') || src.get(k).map(|c| c.is_ascii_digit()).unwrap_or(false) {
                    has_param = true;
                    let mut mm = k + if src[k] == '-' { 1 } else { 0 };
                    while mm < src.len() && src[mm].is_ascii_digit() { mm += 1; }
                    param = src[k..mm].iter().collect::<String>().parse().ok();
                    k = mm;
                }
                if src.get(k) == Some(&' ') { k += 1; }
                i = k;
                if was_first && skip_set.contains(word.as_str()) { st.skip = true; }
                let p0 = param.unwrap_or(0);
                match word.as_str() {
                    "stylesheet" => st.sheet = true,
                    "ansicpg" => { if let Some(c) = param.and_then(rtf_codepage) { cp = c; } }
                    "uc" => st.uc = if has_param { p0 } else { 1 },
                    "u" => {
                        let unit = (if p0 < 0 { p0 + 65536 } else { p0 }) as u32 as u16;
                        if (0xD800..=0xDBFF).contains(&unit) { high = Some(unit); }
                        else if (0xDC00..=0xDFFF).contains(&unit) {
                            if let Some(h) = high.take() {
                                let c = char::decode_utf16([h, unit]).next().and_then(|r| r.ok()).unwrap_or('\u{FFFD}');
                                add!(c.to_string());
                            } else { add!("\u{FFFD}".to_string()); }
                        } else {
                            add!(char::from_u32(unit as u32).unwrap_or('\u{FFFD}').to_string());
                        }
                        skip_chars = st.uc;
                    }
                    "par" | "cell" | "row" => end_para!(),
                    "line" => add!("\n".to_string()),
                    "tab" => add!("\t".to_string()),
                    "pard" => { cur.style = None; cur.outline = None; cur.list = false; }
                    "plain" => { st.b = false; st.i = false; }
                    "b" => st.b = !has_param || param != Some(0),
                    "i" => st.i = !has_param || param != Some(0),
                    "v" => st.hidden = !has_param || param != Some(0),
                    "s" => { if st.sheet { sheet_num = param; } else { cur.style = param; } }
                    "outlinelevel" => { if st.sheet { sheet_outline = param; } else { cur.outline = param; } }
                    "ls" => { if !st.sheet && p0 > 0 { cur.list = true; } }
                    w => { if let Some(c) = rtf_char(w) { add!(c.to_string()); } }
                }
            } else {
                i += 2;
                if nx == '\'' {
                    let hex: String = src[i.min(src.len())..(i + 2).min(src.len())].iter().take_while(|c| c.is_ascii_hexdigit()).collect();
                    let byte = u8::from_str_radix(&hex, 16).ok();
                    i += 2;
                    if skip_chars > 0 { skip_chars -= 1; }
                    else if let Some(b) = byte { bytes.push(b); }
                } else {
                    flush_bytes!();
                    if nx == '*' { if was_first { st.skip = true; } }
                    else if nx == '~' { add!("\u{a0}".to_string()); }
                    else if nx == '_' { add!("-".to_string()); }
                    else if nx == '\n' || nx == '\r' { end_para!(); }
                    else if nx == '{' || nx == '}' || nx == '\\' {
                        if skip_chars > 0 { skip_chars -= 1; } else { add!(nx.to_string()); }
                    }
                }
            }
        } else if ch == '\r' || ch == '\n' {
            i += 1;
        } else {
            first = false;
            if skip_chars > 0 { skip_chars -= 1; }
            else if (ch as u32) >= 0x80 { bytes.push(ch as u32 as u8); }
            else { flush_bytes!(); add!(ch.to_string()); }
            i += 1;
        }
    }
    flush_bytes!();
    if !cur.segs.is_empty() { paras.push(cur); }
    let styles: HashMap<String, Style> = sheet.iter().map(|(n, (name, o))| (n.to_string(), Style { name: name.clone(), outline: *o, based_on: None })).collect();
    paras.into_iter().map(|p| Para {
        segs: p.segs,
        kind: match p.style { None => Kind::default(), Some(s) => style_kind(&styles, Some(&s.to_string()), 0) },
        outline: p.outline,
        list: p.list,
    }).collect()
}

re!(RTF_HEAD, r"^\s*\{\\rtf");

pub fn rtf_to_markdown(buf: &[u8]) -> R<String> {
    let src: Vec<char> = buf.iter().map(|&b| b as char).collect();
    let head: String = src.iter().take(64).collect();
    if !m(&RTF_HEAD, &head) { return Err("Файл не похож на документ RTF.".into()); }
    Ok(paras_to_markdown(&rtf_paragraphs(&src)))
}

// ---------- вход ----------
pub fn parse_file(name: &str, buf: &[u8]) -> R<Vec<Chapter>> {
    if buf.len() > MAX_FILE { return Err("Файл слишком большой для импорта (больше 30 МБ).".into()); }
    let ext = name.rsplit_once('.').filter(|(_, e)| !e.contains(['\\', '/'])).map(|(_, e)| e.to_lowercase()).unwrap_or_default();
    let base = match name.rsplit_once('.') { Some((b, e)) if !e.contains(['\\', '/']) => jtrim(b).to_string(), _ => jtrim(name).to_string() };
    let base = if base.is_empty() { "Импорт".to_string() } else { base };
    let md = match ext.as_str() {
        "docx" => docx_to_markdown(buf)?,
        "rtf" => rtf_to_markdown(buf)?,
        "md" | "markdown" => md_prepare(&decode_text(buf)),
        "txt" | "text" => txt_to_markdown(&decode_text(buf)),
        "doc" => return Err("Старый формат .doc не поддерживается: сохраните файл в Word как .docx.".into()),
        _ => return Err("Формат файла не поддерживается. Подойдут .docx, .rtf, .md и .txt.".into()),
    };
    if jtrim(&md).is_empty() { return Err("В файле нет текста.".into()); }
    let chapters = split_markdown(&md, &base);
    if chapters.is_empty() { return Err("В файле нет текста.".into()); }
    Ok(chapters)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::path::Path;

    #[test]
    fn matches_electron_import_on_every_sample() {
        let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/import");
        let golden: Value = serde_json::from_str(&std::fs::read_to_string(base.join("golden.json")).unwrap()).unwrap();
        let mut checked = 0;
        for (name, want) in golden.as_object().unwrap() {
            let bytes = std::fs::read(base.join("in").join(name)).unwrap();
            let got = parse_file(name, &bytes);
            match (got, want.get("ok"), want.get("err")) {
                (Ok(chs), Some(ok), _) => {
                    let ok = ok.as_array().unwrap();
                    assert_eq!(chs.len(), ok.len(), "{}: число глав", name);
                    for (c, w) in chs.iter().zip(ok) {
                        assert_eq!(c.title, w["title"].as_str().unwrap(), "{}: название", name);
                        assert_eq!(c.text, w["text"].as_str().unwrap(), "{}: текст «{}»", name, c.title);
                    }
                }
                (Err(e), _, Some(err)) => assert_eq!(&e, err.as_str().unwrap(), "{}", name),
                (got, _, _) => panic!("{}: результат не совпал: {:?}", name, got.map(|c| c.len())),
            }
            checked += 1;
        }
        assert!(checked >= 20);
    }

    #[test]
    fn export_then_import_roundtrip_keeps_text() {
        let md = "Первая **жирная** строка.\n\nВторая.";
        let chs = split_markdown(&format!("## Глава 1\n\n{}\n\n## Глава 2\n\nКонец", md), "файл");
        assert_eq!(chs.len(), 2);
        assert_eq!(chs[0].text, md);
    }

    #[test]
    fn size_limit_and_helpers() {
        assert!(parse_file("a.txt", &vec![b'a'; MAX_FILE + 1]).unwrap_err().contains("30 МБ"));
        assert_eq!(decode_text(&[0xef, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]), "привет");
        assert!(txt_to_markdown("- пункт\n# решётка").contains("\\# решётка"));
    }
}
