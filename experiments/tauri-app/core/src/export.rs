//! Экспорт глав проекта одним файлом: Markdown, текст, HTML, RTF, DOCX. Порт src/export.js, docx.js, rtf.js,
//! export-spacing.js и align.js. Результат совпадает с Electron-версией (проверяется эталонными файлами).
use crate::store::{self, R};
use fancy_regex::{Captures, Regex};
use std::io::Write;
use std::path::Path;
use std::sync::LazyLock;

pub const INDENT: &str = "\u{2003}";

macro_rules! re {
    ($name:ident, $p:expr) => { static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($p).unwrap()); };
}
re!(BLANK, r"^\s*$");
re!(HEADING, r"^(#{1,6})\s+(.*)$");
re!(HR, r"^\s*([-*_])(\s*\1){2,}\s*$");
re!(QUOTE, r"^>\s?(.*)$");
re!(ULI, r"^\s*[-*+]\s+(.*)$");
re!(OLI, r"^\s*(\d+)[.)]\s+(.*)$");
re!(OLI_HTML, r"^\s*\d+[.)]\s+(.*)$");
re!(STRONG, r"(?<!\\)\*\*([^*\n]+?)(?<!\\)\*\*");
re!(EM_STAR, r"(^|[^*A-Za-z0-9_\\])\*([^*\n]+?)(?<!\\)\*(?!\*)");
re!(EM_UND, r"(^|[^A-Za-z0-9_])_([^_\n]+?)_(?![A-Za-z0-9_])");
re!(UNESC_HTML, r"\\(&(?:amp|lt|gt|quot);|[!#$%'()*+,\-./:;=?@\[\\\]^_`{|}~])");
re!(UNESC_TXT, r"\\([!-/:-@\[-`{-~])");
re!(ALIGN_ONE, r"^->\s+(\S.*?)\s+(<-|->)$");
re!(ALIGN_FIRST, r"^->\s");
re!(ALIGN_TAIL, r"\s(<-|->)$");

fn is(re: &Regex, s: &str) -> bool { re.is_match(s).unwrap_or(false) }
fn caps<'a>(re: &Regex, s: &'a str) -> Option<Captures<'a>> { re.captures(s).ok().flatten() }
fn g<'a>(c: &Captures<'a>, i: usize) -> &'a str { c.get(i).map(|m| m.as_str()).unwrap_or("") }

// ---------- export-spacing.js ----------
/// Одна пустая строка Markdown разделяет блоки; каждая лишняя внутренняя пустая строка — пустой абзац (None).
pub fn export_lines(md: &str) -> Vec<Option<String>> {
    let norm = md.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = Vec::new();
    let (mut blanks, mut seen) = (0usize, false);
    for line in norm.split('\n') {
        if is(&BLANK, line) { blanks += 1; continue; }
        if seen && blanks > 0 {
            out.push(Some(String::new()));
            for _ in 1..blanks { out.push(None); }
        }
        out.push(Some(line.to_string()));
        blanks = 0;
        seen = true;
    }
    out
}

// ---------- align.js ----------
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Align { Center, Right }

pub fn split_align(lines: &[String]) -> Option<(Align, Vec<String>)> {
    if lines.is_empty() { return None; }
    let al = |s: &str| if s == "<-" { Align::Center } else { Align::Right };
    if lines.len() == 1 {
        let c = caps(&ALIGN_ONE, &lines[0])?;
        return Some((al(g(&c, 2)), vec![g(&c, 1).to_string()]));
    }
    if !is(&ALIGN_FIRST, &lines[0]) { return None; }
    let last = lines.last().unwrap();
    let tail = caps(&ALIGN_TAIL, last)?;
    let mut out = lines.to_vec();
    out[0] = Regex::new(r"^->\s+").unwrap().replace(&out[0], "").into_owned();
    let n = out.len() - 1;
    out[n] = Regex::new(r"\s+(<-|->)$").unwrap().replace(&out[n], "").into_owned();
    Some((al(g(&tail, 1)), out))
}

fn strip_align(lines: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    let mut block: Vec<String> = Vec::new();
    let flush = |block: &mut Vec<String>, out: &mut Vec<String>| {
        match split_align(block) { Some((_, l)) => out.extend(l), None => out.extend(block.iter().cloned()) }
        block.clear();
    };
    for line in lines {
        if is(&BLANK, &line) { flush(&mut block, &mut out); out.push(line); } else { block.push(line); }
    }
    flush(&mut block, &mut out);
    out
}

// ---------- HTML и текст ----------
fn escape_html(s: &str) -> String { s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;") }

fn inline_html(text: &str) -> String {
    let t = escape_html(text);
    let t = STRONG.replace_all(&t, "<strong>${1}</strong>").into_owned();
    let t = EM_STAR.replace_all(&t, "${1}<em>${2}</em>").into_owned();
    let t = EM_UND.replace_all(&t, "${1}<em>${2}</em>").into_owned();
    UNESC_HTML.replace_all(&t, "${1}").into_owned()
}

pub fn md_to_html(md: &str) -> String {
    let lines = export_lines(md);
    let mut out: Vec<String> = Vec::new();
    let mut para: Vec<String> = Vec::new();
    let mut list: Option<&str> = None;
    let mut quote: Vec<String> = Vec::new();

    fn flush_para(para: &mut Vec<String>, out: &mut Vec<String>) {
        if !para.is_empty() {
            match split_align(para) {
                Some((a, ls)) => out.push(format!("<p class=\"{}\" style=\"text-align:{};text-indent:0\">{}</p>",
                    if a == Align::Center { "center" } else { "right" }, if a == Align::Center { "center" } else { "right" },
                    ls.iter().map(|l| inline_html(l)).collect::<Vec<_>>().join("<br>"))),
                None => out.push(format!("<p>{}</p>", para.iter().map(|l| inline_html(l)).collect::<Vec<_>>().join("<br>"))),
            }
        }
        para.clear();
    }
    fn flush_list(list: &mut Option<&str>, out: &mut Vec<String>) {
        if let Some(l) = list.take() { out.push(format!("</{}>", l)); }
    }
    fn flush_quote(quote: &mut Vec<String>, out: &mut Vec<String>) {
        if !quote.is_empty() { out.push(format!("<blockquote><p>{}</p></blockquote>", quote.iter().map(|l| inline_html(l)).collect::<Vec<_>>().join("<br>"))); }
        quote.clear();
    }

    for line in lines {
        let Some(line) = line else {
            flush_para(&mut para, &mut out); flush_list(&mut list, &mut out); flush_quote(&mut quote, &mut out);
            out.push("<p class=\"empty-line\" style=\"margin:0;text-indent:0\"><br></p>".into());
            continue;
        };
        macro_rules! flush_all { () => { flush_para(&mut para, &mut out); flush_list(&mut list, &mut out); flush_quote(&mut quote, &mut out); }; }
        if is(&BLANK, &line) { flush_all!(); }
        else if let Some(m) = caps(&HEADING, &line) {
            flush_all!();
            let n = g(&m, 1).len() + 1;
            out.push(format!("<h{n}>{}</h{n}>", inline_html(g(&m, 2))));
        } else if is(&HR, &line) { flush_all!(); out.push("<hr>".into()); }
        else if let Some(m) = caps(&QUOTE, &line) { flush_para(&mut para, &mut out); flush_list(&mut list, &mut out); quote.push(g(&m, 1).to_string()); }
        else if let Some(m) = caps(&ULI, &line) {
            flush_para(&mut para, &mut out); flush_quote(&mut quote, &mut out);
            if list != Some("ul") { flush_list(&mut list, &mut out); out.push("<ul>".into()); list = Some("ul"); }
            out.push(format!("<li>{}</li>", inline_html(g(&m, 1))));
        } else if let Some(m) = caps(&OLI_HTML, &line) {
            flush_para(&mut para, &mut out); flush_quote(&mut quote, &mut out);
            if list != Some("ol") { flush_list(&mut list, &mut out); out.push("<ol>".into()); list = Some("ol"); }
            out.push(format!("<li>{}</li>", inline_html(g(&m, 1))));
        } else {
            flush_list(&mut list, &mut out); flush_quote(&mut quote, &mut out);
            para.push(line.trim().to_string());
        }
    }
    flush_para(&mut para, &mut out); flush_list(&mut list, &mut out); flush_quote(&mut quote, &mut out);
    out.join("\n")
}

pub fn md_to_text(md: &str, indent: bool) -> String {
    let norm = md.replace("\r\n", "\n").replace('\r', "\n");
    let (mut start, mut skip) = (true, false);
    let first_h = Regex::new(r"^#{1,6}\s+").unwrap();
    let quote_re = Regex::new(r"^>\s?").unwrap();
    let list_re = Regex::new(r"^\s*[-*+]\s+").unwrap();
    let lines: Vec<String> = strip_align(norm.split('\n').map(String::from).collect()).into_iter().map(|line| {
        if is(&BLANK, &line) { start = true; return line; }
        let first = start;
        start = false;
        if is(&HR, &line) { skip = false; return "***".to_string(); }
        let heading = is(&Regex::new(r"^#{1,6}\s").unwrap(), &line);
        let quote = line.starts_with('>');
        let list = is(&list_re, &line);
        let mut text = first_h.replace(&line, "").into_owned();
        text = quote_re.replace(&text, "    ").into_owned();
        text = list_re.replace(&text, "— ").into_owned();
        text = STRONG.replace_all(&text, "${1}").into_owned();
        text = EM_STAR.replace_all(&text, "${1}${2}").into_owned();
        text = EM_UND.replace_all(&text, "${1}${2}").into_owned();
        text = UNESC_TXT.replace_all(&text, "${1}").into_owned();
        if first && !heading && !quote && !list {
            if indent && !skip && text.chars().next().map(|c| !c.is_whitespace()).unwrap_or(false) { text = format!("{}{}", INDENT, text); }
            skip = false;
        } else if first {
            skip = heading || quote;
        }
        text
    }).collect();
    let joined = lines.join("\n");
    let trimmed_start = joined.trim_start_matches(|c| c == ' ' || c == '\t' || c == '\n');
    trimmed_start.trim_end().to_string()
}

// ---------- DOCX / RTF: общий разбор строки на куски ----------
#[derive(Clone, Debug, PartialEq)]
pub struct Run { pub text: String, pub b: bool, pub i: bool }

pub fn runs(text: &str) -> Vec<Run> {
    let s: Vec<char> = text.chars().collect();
    let (mut out, mut b, mut i, mut buf) = (Vec::new(), false, false, String::new());
    let word = |c: Option<&char>| c.map(|c| c.is_ascii_alphanumeric() || *c == '_').unwrap_or(false);
    let push = |buf: &mut String, b: bool, i: bool, out: &mut Vec<Run>| { if !buf.is_empty() { out.push(Run { text: std::mem::take(buf), b, i }); } };
    let mut k = 0;
    while k < s.len() {
        let ch = s[k];
        if ch == '\\' && s.get(k + 1).map(|c| c.is_ascii_punctuation()).unwrap_or(false) { buf.push(s[k + 1]); k += 2; continue; }
        if ch == '*' && s.get(k + 1) == Some(&'*') { push(&mut buf, b, i, &mut out); b = !b; k += 2; continue; }
        let prev = if k > 0 { s.get(k - 1) } else { None };
        if ch == '*' || (ch == '_' && word(prev) != word(s.get(k + 1))) { push(&mut buf, b, i, &mut out); i = !i; k += 1; continue; }
        buf.push(ch);
        k += 1;
    }
    push(&mut buf, b, i, &mut out);
    out
}

// ---------- DOCX ----------
fn xml_esc(s: &str) -> String {
    let mut o = String::new();
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"), '<' => o.push_str("&lt;"), '>' => o.push_str("&gt;"), '"' => o.push_str("&quot;"),
            '\u{0}'..='\u{8}' | '\u{B}' | '\u{C}' | '\u{E}'..='\u{1F}' | '\u{FFFE}' | '\u{FFFF}' => {}
            c => o.push(c),
        }
    }
    o
}

fn run_xml(r: &Run) -> String {
    let pr = format!("{}{}", if r.b { "<w:b/>" } else { "" }, if r.i { "<w:i/>" } else { "" });
    format!("<w:r>{}<w:t xml:space=\"preserve\">{}</w:t></w:r>", if pr.is_empty() { String::new() } else { format!("<w:rPr>{}</w:rPr>", pr) }, xml_esc(&r.text))
}

#[derive(Default, Clone, Copy)]
struct ParaOpts { page_break: bool, center: bool, align: Option<Align> }

fn docx_para(style: Option<&str>, lines: &[String], o: ParaOpts) -> String {
    let mut inner = String::new();
    for (idx, ln) in lines.iter().enumerate() {
        if idx > 0 { inner.push_str("<w:r><w:br/></w:r>"); }
        for r in runs(ln) { inner.push_str(&run_xml(&r)); }
    }
    let jc = if o.center { Some("center") } else { o.align.map(|a| if a == Align::Right { "right" } else { "center" }) };
    let ppr = format!("{}{}{}{}",
        style.map(|s| format!("<w:pStyle w:val=\"{}\"/>", s)).unwrap_or_default(),
        if o.page_break { "<w:pageBreakBefore/>" } else { "" },
        if o.align.is_some() { "<w:ind w:firstLine=\"0\"/>" } else { "" },
        jc.map(|j| format!("<w:jc w:val=\"{}\"/>", j)).unwrap_or_default());
    format!("<w:p>{}{}</w:p>", if ppr.is_empty() { String::new() } else { format!("<w:pPr>{}</w:pPr>", ppr) }, inner)
}

fn md_to_body(md: &str) -> String {
    let mut out = String::new();
    let mut buf: Vec<String> = Vec::new();
    let mut kind = ' ';
    fn flush(buf: &mut Vec<String>, kind: &mut char, out: &mut String) {
        if !buf.is_empty() {
            let al = if *kind == 'p' { split_align(buf) } else { None };
            match al {
                Some((a, ls)) => out.push_str(&docx_para(None, &ls, ParaOpts { align: Some(a), ..Default::default() })),
                None => out.push_str(&docx_para(if *kind == 'q' { Some("Quote") } else { None }, buf, ParaOpts::default())),
            }
        }
        buf.clear();
        *kind = ' ';
    }
    for line in export_lines(md) {
        let Some(line) = line else { flush(&mut buf, &mut kind, &mut out); out.push_str(&docx_para(None, &[], ParaOpts::default())); continue };
        if is(&BLANK, &line) { flush(&mut buf, &mut kind, &mut out); }
        else if let Some(m) = caps(&HEADING, &line) { flush(&mut buf, &mut kind, &mut out); out.push_str(&docx_para(Some("Heading2"), &[g(&m, 2).to_string()], Default::default())); }
        else if is(&HR, &line) { flush(&mut buf, &mut kind, &mut out); out.push_str(&docx_para(Some("Separator"), &["\\* \\* \\*".to_string()], Default::default())); }
        else if let Some(m) = caps(&QUOTE, &line) { if kind != 'q' { flush(&mut buf, &mut kind, &mut out); } kind = 'q'; buf.push(g(&m, 1).to_string()); }
        else if let Some(m) = caps(&ULI, &line) { flush(&mut buf, &mut kind, &mut out); out.push_str(&docx_para(Some("ListItem"), &[format!("— {}", g(&m, 1))], Default::default())); }
        else if let Some(m) = caps(&OLI, &line) { flush(&mut buf, &mut kind, &mut out); out.push_str(&docx_para(Some("ListItem"), &[format!("{}. {}", g(&m, 1), g(&m, 2))], Default::default())); }
        else { if kind != 'p' { flush(&mut buf, &mut kind, &mut out); } kind = 'p'; buf.push(line.trim().to_string()); }
    }
    flush(&mut buf, &mut kind, &mut out);
    out
}

fn styles(lang: &str) -> String {
    format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman" w:eastAsia="Times New Roman"/><w:sz w:val="28"/><w:szCs w:val="28"/><w:lang w:val="{lang}"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="360" w:lineRule="auto"/><w:jc w:val="both"/><w:ind w:firstLine="709"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="4200" w:after="0"/><w:jc w:val="center"/><w:ind w:firstLine="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="0" w:after="360"/><w:jc w:val="left"/><w:ind w:firstLine="0"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="160"/><w:jc w:val="left"/><w:ind w:firstLine="0"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="709" w:firstLine="0"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListItem"><w:name w:val="List Item"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="709" w:firstLine="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Separator"><w:name w:val="Separator"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="240"/><w:jc w:val="center"/><w:ind w:firstLine="0"/></w:pPr></w:style>
</w:styles>"#)
}

fn zip(files: &[(&str, String)]) -> Vec<u8> {
    let (mut out, mut central) = (Vec::<u8>::new(), Vec::<u8>::new());
    let date: u16 = 0x5821;
    for (name, content) in files {
        let raw = content.as_bytes();
        let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(raw).unwrap();
        let data = enc.finish().unwrap();
        let mut crc = flate2::Crc::new();
        crc.update(raw);
        let crc = crc.sum();
        let offset = out.len() as u32;
        let nb = name.as_bytes();
        out.extend_from_slice(&0x04034b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&0x0800u16.to_le_bytes());
        out.extend_from_slice(&8u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&date.to_le_bytes());
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(raw.len() as u32).to_le_bytes());
        out.extend_from_slice(&(nb.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(nb);
        out.extend_from_slice(&data);
        central.extend_from_slice(&0x02014b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&0x0800u16.to_le_bytes());
        central.extend_from_slice(&8u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&date.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(raw.len() as u32).to_le_bytes());
        central.extend_from_slice(&(nb.len() as u16).to_le_bytes());
        central.extend_from_slice(&[0u8; 8]); // extra, comment, disk, int attrs
        central.extend_from_slice(&0u32.to_le_bytes()); // external attrs
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(nb);
    }
    let cen_off = out.len() as u32;
    let n = files.len() as u16;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x06054b50u32.to_le_bytes());
    out.extend_from_slice(&[0u8; 4]);
    out.extend_from_slice(&n.to_le_bytes());
    out.extend_from_slice(&n.to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&cen_off.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

pub struct Chapter { pub title: String, pub text: String }
pub struct Toc { pub heading: String, pub items: Vec<String> }

fn build_docx(book: &str, chapters: &[Chapter], stories: bool, lang: &str, toc: Option<&Toc>) -> Vec<u8> {
    let mut body = vec![docx_para(Some("Title"), &[book.to_string()], Default::default())];
    if let Some(t) = toc {
        body.push(docx_para(Some("Heading1"), &[t.heading.clone()], ParaOpts { page_break: true, center: true, ..Default::default() }));
        for it in &t.items { body.push(docx_para(Some("ListItem"), &[it.clone()], Default::default())); }
    }
    for c in chapters {
        body.push(docx_para(Some("Heading1"), &[c.title.clone()], ParaOpts { page_break: true, center: stories, ..Default::default() }));
        body.push(md_to_body(&c.text));
    }
    let doc = format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>{}<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1134\" w:right=\"1134\" w:bottom=\"1134\" w:left=\"1701\" w:header=\"709\" w:footer=\"709\" w:gutter=\"0\"/></w:sectPr></w:body></w:document>", body.join(""));
    zip(&[
        ("[Content_Types].xml", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/><Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/></Types>".into()),
        ("_rels/.rels", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>".into()),
        ("word/_rels/document.xml.rels", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/></Relationships>".into()),
        ("word/styles.xml", styles(if lang == "en" { "en-US" } else { "ru-RU" })),
        ("word/document.xml", doc),
    ])
}

// ---------- RTF ----------
fn rtf_esc(text: &str) -> String {
    let mut out = String::new();
    for u in text.encode_utf16() {
        let c = u as u32;
        match c {
            0x5c | 0x7b | 0x7d => { out.push('\\'); out.push(char::from_u32(c).unwrap()); }
            9 => out.push_str("\\tab "),
            0..=31 => {}
            32..=127 => out.push(char::from_u32(c).unwrap()),
            _ => out.push_str(&format!("\\u{}?", if c > 32767 { c as i32 - 65536 } else { c as i32 })),
        }
    }
    out
}

fn rtf_inline(line: &str) -> String {
    runs(line).iter().map(|r| {
        let t = rtf_esc(&r.text);
        if !r.b && !r.i { t } else { format!("{{{}{} {}}}", if r.b { "\\b" } else { "" }, if r.i { "\\i" } else { "" }, t) }
    }).collect()
}

fn rtf_para(props: &str, content: &str) -> String { format!("{{\\pard{} {}\\par}}\n", props, content) }

const BODY: &str = "\\qj\\fi709\\sl360\\slmult1\\sa0";
const H1: &str = "\\s1\\outlinelevel0\\keepn\\sb0\\sa360\\fi0\\sl0\\slmult0\\b\\fs36";
const H2: &str = "\\s2\\outlinelevel1\\keepn\\sb240\\sa160\\fi0\\sl0\\slmult0\\b\\fs32";

fn md_to_rtf(md: &str) -> String {
    let mut out = String::new();
    let mut buf: Vec<String> = Vec::new();
    let mut kind = ' ';
    fn flush(buf: &mut Vec<String>, kind: &mut char, out: &mut String) {
        if !buf.is_empty() {
            let text = buf.iter().map(|l| rtf_inline(l)).collect::<Vec<_>>().join("\\line ");
            let al = if *kind == 'p' { split_align(buf) } else { None };
            if let Some((a, ls)) = al {
                out.push_str(&rtf_para(&format!("{}\\fi0\\sl360\\slmult1\\sa0", if a == Align::Right { "\\qr" } else { "\\qc" }), &ls.iter().map(|l| rtf_inline(l)).collect::<Vec<_>>().join("\\line ")));
            } else if *kind == 'q' { out.push_str(&rtf_para("\\s4\\li709\\fi0\\sl360\\slmult1\\i", &text)); }
            else { out.push_str(&rtf_para(BODY, &text)); }
        }
        buf.clear();
        *kind = ' ';
    }
    for line in export_lines(md) {
        let Some(line) = line else { flush(&mut buf, &mut kind, &mut out); out.push_str(&rtf_para(BODY, "")); continue };
        if is(&BLANK, &line) { flush(&mut buf, &mut kind, &mut out); }
        else if let Some(m) = caps(&HEADING, &line) { flush(&mut buf, &mut kind, &mut out); out.push_str(&rtf_para(H2, &rtf_esc(g(&m, 2)))); }
        else if is(&HR, &line) { flush(&mut buf, &mut kind, &mut out); out.push_str(&rtf_para("\\qc\\sb240\\sa240\\fi0", "* * *")); }
        else if let Some(m) = caps(&QUOTE, &line) { if kind != 'q' { flush(&mut buf, &mut kind, &mut out); } kind = 'q'; buf.push(g(&m, 1).to_string()); }
        else if let Some(m) = caps(&ULI, &line) { flush(&mut buf, &mut kind, &mut out); out.push_str(&rtf_para("\\li709\\fi0\\sl360\\slmult1", &format!("\\u8212? {}", rtf_inline(g(&m, 1))))); }
        else if let Some(m) = caps(&OLI, &line) { flush(&mut buf, &mut kind, &mut out); out.push_str(&rtf_para("\\li709\\fi0\\sl360\\slmult1", &format!("{}. {}", g(&m, 1), rtf_inline(g(&m, 2))))); }
        else { if kind != 'p' { flush(&mut buf, &mut kind, &mut out); } kind = 'p'; buf.push(line.trim().to_string()); }
    }
    flush(&mut buf, &mut kind, &mut out);
    out
}

fn build_rtf(book: &str, chapters: &[Chapter], stories: bool, toc: Option<&Toc>) -> String {
    let head = "{\\rtf1\\ansi\\ansicpg1251\\deff0\\uc1\n{\\fonttbl{\\f0\\froman\\fcharset204 Times New Roman;}}\n{\\stylesheet{\\s1 heading 1;}{\\s2 heading 2;}{\\s3 Title;}{\\s4 Quote;}}\n\\paperw11906\\paperh16838\\margl1134\\margr1134\\margt1134\\margb1134\\f0\\fs28\n";
    let mut body = vec![rtf_para("\\s3\\qc\\sb4200\\sa0\\fi0\\b\\fs52", &rtf_esc(book))];
    if let Some(t) = toc {
        body.push(rtf_para(&format!("{}\\pagebb\\qc", H1), &rtf_esc(&t.heading)));
        for it in &t.items { body.push(rtf_para("\\li709\\fi0\\sl360\\slmult1", &rtf_esc(it))); }
    }
    for c in chapters {
        body.push(rtf_para(&format!("{}\\pagebb{}", H1, if stories { "\\qc" } else { "" }), &rtf_esc(&c.title)));
        body.push(md_to_rtf(&c.text));
    }
    format!("{}{}}}\n", head, body.join(""))
}

// ---------- сборка ----------
const CSS: &str = "\n  @page { margin: 22mm 20mm; }\n  body { font-family: Georgia, \"Times New Roman\", serif; font-size: 12pt; line-height: 1.55; color: #111; }\n  h1.book { font-size: 26pt; text-align: center; margin: 30vh 0 0; page-break-after: always; }\n  section.chapter { page-break-before: always; }\n  section.chapter:first-of-type { page-break-before: auto; }\n  h2.title { font-size: 18pt; margin: 0 0 1.2em; }\n  body.stories h2.title { text-align: center; font-size: 20pt; margin: 2.5em 0 1.6em; }\n  nav.toc { page-break-after: always; }\n  nav.toc h2 { text-align: center; font-size: 18pt; margin: 0 0 1em; }\n  nav.toc ol { list-style: none; padding: 0; line-height: 1.9; text-align: center; }\n  p { margin: 0 0 .7em; text-align: justify; }\n  blockquote { margin: 0 0 .7em 1.2em; padding-left: .8em; border-left: 2px solid #999; color: #444; }\n  hr { border: none; text-align: center; margin: 1.2em 0; }\n  hr::after { content: \"* * *\"; }\n";
const INDENT_CSS: &str = "\n  p { margin: 0; text-indent: 1.5em; }\n  h2 + p, h3 + p, blockquote + p { text-indent: 0; }\n";

/// format: md | txt | html | rtf | docx. Возвращает байты файла.
/// Страница для печати в PDF: та же вёрстка, что у HTML, плюс поля A4 и автоматическое открытие окна печати.
pub fn print_page(html: &str) -> String {
    const HEAD: &str = "<style>@page{size:A4;margin:20mm}@media print{.noprint{display:none}}</style>";
    const NOTE: &str = "<p class=\"noprint\" style=\"font:14px sans-serif;background:#fff6d6;padding:10px 14px;margin:0 0 16px\">В окне печати выберите «Сохранить как PDF». Если оно не открылось, нажмите Ctrl+P (на Mac — ⌘P).</p>";
    const SCRIPT: &str = "<script>addEventListener('load',function(){setTimeout(function(){print()},400)})</script>";
    html.replacen("</head>", &format!("{}</head>", HEAD), 1).replacen("<body", &format!("<body data-print=\"1\""), 1).replacen("</body>", &format!("{}</body>", SCRIPT), 1).replacen("<h1 class=\"book\">", &format!("{}<h1 class=\"book\">", NOTE), 1)
}

pub fn build_export(dir: &Path, format: &str, lang: &str, indent: bool, chapter_numbers: bool) -> R<Vec<u8>> {
    let view = store::open_project(dir)?;
    let stories = view["mode"].as_str() == Some("stories");
    let name = view["name"].as_str().unwrap_or("").to_string();
    let mut chapters = Vec::new();
    for (i, c) in view["chapters"].as_array().cloned().unwrap_or_default().iter().enumerate() {
        let title = c["title"].as_str().unwrap_or("");
        let id = c["id"].as_str().unwrap_or("");
        chapters.push(Chapter {
            title: if stories || !chapter_numbers { title.to_string() } else { format!("{}. {}", i + 1, title) },
            text: store::read_chapter(dir, id)?.trim().to_string(),
        });
    }
    let toc_heading = if lang == "en" { "Contents" } else { "Содержание" };
    let toc = if stories && chapters.len() > 1 { Some(Toc { heading: toc_heading.into(), items: chapters.iter().map(|c| c.title.clone()).collect() }) } else { None };
    let nbsp = |s: String| s.replace('\u{a0}', " ");
    Ok(match format {
        "docx" => build_docx(&name, &chapters, stories, lang, toc.as_ref()),
        "rtf" => build_rtf(&name, &chapters, stories, toc.as_ref()).into_bytes(),
        "md" => {
            let contents = toc.as_ref().map(|t| format!("## {}\n\n{}\n\n---\n\n", t.heading, t.items.iter().map(|x| format!("- {}", x)).collect::<Vec<_>>().join("\n"))).unwrap_or_default();
            nbsp(format!("# {}\n\n{}{}\n", name, contents, chapters.iter().map(|c| format!("## {}\n\n{}", c.title, c.text)).collect::<Vec<_>>().join("\n\n---\n\n"))).into_bytes()
        }
        "txt" => {
            let contents = toc.as_ref().map(|t| format!("{}\n\n{}\n\n\n", t.heading, t.items.join("\n"))).unwrap_or_default();
            nbsp(format!("{}\n\n\n{}{}\n", name, contents, chapters.iter().map(|c| format!("{}\n\n{}", c.title, md_to_text(&c.text, indent))).collect::<Vec<_>>().join("\n\n\n"))).into_bytes()
        }
        "html" => {
            let body = chapters.iter().map(|c| format!("<section class=\"chapter\"><h2 class=\"title\">{}</h2>\n{}</section>", escape_html(&c.title), md_to_html(&c.text))).collect::<Vec<_>>().join("\n");
            let nav = toc.as_ref().map(|t| format!("<nav class=\"toc\"><h2>{}</h2><ol>{}</ol></nav>\n", escape_html(&t.heading), t.items.iter().map(|x| format!("<li>{}</li>", escape_html(x))).collect::<String>())).unwrap_or_default();
            format!("<!doctype html>\n<html lang=\"{}\"><head><meta charset=\"utf-8\"><title>{}</title><style>{}{}</style></head><body{}>\n<h1 class=\"book\">{}</h1>\n{}{}\n</body></html>\n",
                if lang == "en" { "en" } else { "ru" }, escape_html(&name), CSS, if indent { INDENT_CSS } else { "" },
                if stories { " class=\"stories\"" } else { "" }, escape_html(&name), nav, body).into_bytes()
        }
        _ => return Err("Неизвестный формат экспорта.".into()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::tmpdir;
    use std::fs;
    use std::io::Read;

    fn copy_dir(from: &Path, to: &Path) {
        fs::create_dir_all(to).unwrap();
        for e in fs::read_dir(from).unwrap().flatten() {
            let t = to.join(e.file_name());
            if e.path().is_dir() { copy_dir(&e.path(), &t); } else { fs::copy(e.path(), t).unwrap(); }
        }
    }

    fn unzip_part(buf: &[u8], want: &str) -> String {
        let eocd = buf.windows(4).rposition(|w| w == [0x50, 0x4b, 5, 6]).unwrap();
        let rd32 = |p: usize| u32::from_le_bytes(buf[p..p + 4].try_into().unwrap()) as usize;
        let rd16 = |p: usize| u16::from_le_bytes(buf[p..p + 2].try_into().unwrap()) as usize;
        let n = rd16(eocd + 10);
        let mut cen = rd32(eocd + 16);
        for _ in 0..n {
            let (nl, el, cl, loc, cs) = (rd16(cen + 28), rd16(cen + 30), rd16(cen + 32), rd32(cen + 42), rd32(cen + 20));
            let name = String::from_utf8_lossy(&buf[cen + 46..cen + 46 + nl]).to_string();
            cen += 46 + nl + el + cl;
            if name == want {
                let start = loc + 30 + rd16(loc + 26) + rd16(loc + 28);
                let mut out = String::new();
                flate2::read::DeflateDecoder::new(&buf[start..start + cs]).read_to_string(&mut out).unwrap();
                return out;
            }
        }
        panic!("нет части {}", want);
    }

    #[test]
    fn matches_electron_output_byte_for_byte() {
        let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests");
        for name in ["novel", "stories"] {
            let dir = tmpdir(name).join("p");
            copy_dir(&base.join("fixtures").join(name), &dir);
            for (tag, lang, indent, num) in [("ru-n", "ru", false, false), ("ru-i-num", "ru", true, true), ("en-n", "en", false, false)] {
                for f in ["md", "txt", "html", "rtf"] {
                    let want = fs::read_to_string(base.join("golden").join(name).join(format!("{}-{}", f, tag))).unwrap();
                    let got = String::from_utf8(build_export(&dir, f, lang, indent, num).unwrap()).unwrap();
                    assert_eq!(got, want, "{} {} {}", name, f, tag);
                }
                let docx = build_export(&dir, "docx", lang, indent, num).unwrap();
                for part in ["document", "styles"] {
                    let want = fs::read_to_string(base.join("golden").join(name).join(format!("docx-{}-{}.xml", tag, part))).unwrap();
                    assert_eq!(unzip_part(&docx, &format!("word/{}.xml", part)), want, "{} docx {} {}", name, part, tag);
                }
            }
        }
    }

    #[test]
    fn small_pieces() {
        assert_eq!(export_lines("a\n\n\n\nb").len(), 5);
        assert_eq!(runs("a **b** _c_ \\*d"), vec![
            Run { text: "a ".into(), b: false, i: false }, Run { text: "b".into(), b: true, i: false },
            Run { text: " ".into(), b: false, i: false }, Run { text: "c".into(), b: false, i: true }, Run { text: " *d".into(), b: false, i: false }]);
        assert_eq!(rtf_esc("я{}\\"), "\\u1103?\\{\\}\\\\");
        let (a, l) = split_align(&["-> привет <-".to_string()]).unwrap();
        assert_eq!((a, l), (Align::Center, vec!["привет".to_string()]));
        assert!(build_export(Path::new("/нет"), "pdf", "ru", false, false).is_err());
        let page = print_page("<html><head></head><body class=\"x\"><h1 class=\"book\">К</h1></body></html>");
        assert!(page.contains("@page{size:A4") && page.contains("print()") && page.contains("Сохранить как PDF") && page.contains("<body data-print"));
    }
}

#[cfg(test)]
mod zip_check {
    #[test]
    fn writes_docx_for_external_check() {
        if let Ok(out) = std::env::var("KABINET_DOCX_OUT") {
            let dir = crate::testutil::tmpdir("zc").join("p");
            let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/novel");
            std::fs::create_dir_all(dir.join("Главы")).unwrap();
            for e in std::fs::read_dir(base.join("Главы")).unwrap().flatten() { std::fs::copy(e.path(), dir.join("Главы").join(e.file_name())).unwrap(); }
            std::fs::copy(base.join("project.json"), dir.join("project.json")).unwrap();
            std::fs::write(out, super::build_export(&dir, "docx", "ru", false, false).unwrap()).unwrap();
        }
    }
}
