'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFile, decodeText, txtToMarkdown, mdPrepare, splitMarkdown } = require('../src/import');
const { buildDocx, zip } = require('../src/docx');

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docx = (body, styles = '') => zip([
  ['word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`],
  ['word/styles.xml', `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}>${styles}</w:styles>`],
]);
const p = (text, ppr = '', rpr = '') => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

test('txt: строка — абзац, диалоговое тире, разделитель, экранирование', () => {
  const md = txtToMarkdown('Первый абзац.\r\n- Привет, - сказал он.\r\n* * *\r\n2. не список\r\nпро *звёздочку* и _подчёркивание_\r\n');
  assert.equal(md, 'Первый абзац.\n\n— Привет, - сказал он.\n\n---\n\n2\\. не список\n\nпро \\*звёздочку\\* и \\_подчёркивание\\_');
});

test('txt: строки, перенесённые вручную внутри абзацев, склеиваются', () => {
  const md = txtToMarkdown('Это один абзац,\nперенесённый вручную.\n\nА это другой,\nтоже в две строки.\n\nТретий,\nопять так.');
  assert.equal(md, 'Это один абзац, перенесённый вручную.\n\nА это другой, тоже в две строки.\n\nТретий, опять так.');
});

test('txt: «Глава 1», «Пролог» становятся заголовками и делят файл на главы', () => {
  const ch = parseFile('роман.txt', Buffer.from('Пролог\nТемно.\nГлава 1\nПервый день.\nГлава 2. Дорога\nВторой день.\n'));
  assert.deepEqual(ch.map((c) => c.title), ['Пролог', 'Глава 1', 'Глава 2. Дорога']);
  assert.deepEqual(ch.map((c) => c.text), ['Темно.', 'Первый день.', 'Второй день.']);
  const single = parseFile('рассказ.txt', Buffer.from('Просто текст.\nЕщё строка.'));
  assert.deepEqual(single, [{ title: 'рассказ', text: 'Просто текст.\n\nЕщё строка.' }]);
});

test('кодировки: UTF-8 с BOM, UTF-16, Windows-1251', () => {
  assert.equal(decodeText(Buffer.from(String.fromCharCode(0xfeff) + 'Привет', 'utf8')), 'Привет');
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Привет', 'utf16le')])), 'Привет');
  const cp1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // «Привет»
  assert.equal(decodeText(cp1251), 'Привет');
});

test('md: главы по заголовкам верхнего уровня, подзаголовки остаются, шапка YAML убирается', () => {
  const md = mdPrepare('---\ntitle: Книга\ntags: [a]\n---\n# Один\n\nТекст 1.\n\n## Подраздел\n\nМного.\n\n# Два\n\nТекст 2.\n');
  const ch = splitMarkdown(md, 'файл');
  assert.deepEqual(ch.map((c) => c.title), ['Один', 'Два']);
  assert.equal(ch[0].text, 'Текст 1.\n\n## Подраздел\n\nМного.');
  assert.equal(ch[1].text, 'Текст 2.');
});

test('md: файл, выгруженный Кабинетом (один # — название книги, ## — главы с номерами)', () => {
  const ch = splitMarkdown('# Книга\n\n## 1. Начало\n\nА.\n\n---\n\n## 2. Конец\n\nБ.\n', 'книга');
  assert.deepEqual(ch.map((c) => c.title), ['Начало', 'Конец']);
  assert.equal(ch[0].text, 'А.\n\n---');
});

test('md: один заголовок вначале — название; без заголовков — имя файла; решётки в коде не заголовки', () => {
  assert.deepEqual(splitMarkdown('# Рассказ\n\nТекст.', 'f'), [{ title: 'Рассказ', text: 'Текст.' }]);
  assert.deepEqual(splitMarkdown('Просто текст.', 'мой файл'), [{ title: 'мой файл', text: 'Просто текст.' }]);
  const ch = splitMarkdown('Текст\n\n```\n# не заголовок\n# и не это\n```\n', 'f');
  assert.equal(ch.length, 1);
});

test('docx, который выгрузил сам Кабинет, читается обратно: главы, курсив, жирный, разделитель, цитата', () => {
  const chapters = [
    { title: '1. Начало', text: 'Один **жирный** и *косой* текст.\n\n— Реплика.\n\n* * *\n\nПосле разделителя.' },
    { title: '2. Конец', text: '> Цитата\n\nФинал.' },
  ];
  const out = parseFile('Книга.docx', buildDocx('Книга', chapters, { lang: 'ru' }));
  assert.deepEqual(out.map((c) => c.title), ['Начало', 'Конец']);
  assert.equal(out[0].text, 'Один **жирный** и *косой* текст.\n\n— Реплика.\n\n---\n\nПосле разделителя.');
  assert.equal(out[1].text, '> Цитата\n\nФинал.');
});

test('docx из Word: русские стили заголовков, красная строка пробелами, оглавление пропускается, спецзнаки экранируются', () => {
  const styles = '<w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="10"><w:name w:val="toc 1"/></w:style>';
  const body = p('Оглавление', '<w:pStyle w:val="10"/>')
    + p('Глава первая', '<w:pStyle w:val="1"/>')
    + p('    Красная строка &amp; &lt;тег&gt; * звезда', '')
    + p('- Реплика через дефис', '')
    + p('***', '')
    + p('Глава вторая', '<w:pStyle w:val="1"/>')
    + p('Курсив и жирный', '', '<w:i/><w:b/>')
    + '<w:p><w:r><w:t>Строка</w:t><w:br/><w:t>после переноса</w:t></w:r></w:p>';
  const ch = parseFile('в.docx', docx(body, styles));
  assert.deepEqual(ch.map((c) => c.title), ['Глава первая', 'Глава вторая']);
  assert.equal(ch[0].text, 'Красная строка & <тег> \\* звезда\n\n— Реплика через дефис\n\n---');
  assert.equal(ch[1].text, '***Курсив и жирный***\n\nСтрока  \nпосле переноса');
});

test('docx: название документа (Title) без глав становится названием, пустые абзацы и вставки удалённого текста пропускаются', () => {
  const styles = '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>';
  const body = p('Моя повесть', '<w:pStyle w:val="Title"/>') + p('Первый абзац.') + '<w:p/>'
    + '<w:p><w:del><w:r><w:delText>удалено</w:delText></w:r></w:del><w:r><w:t>Второй.</w:t></w:r></w:p>';
  assert.deepEqual(parseFile('x.docx', docx(body, styles)), [{ title: 'Моя повесть', text: 'Первый абзац.\n\nВторой.' }]);
});

test('неподходящие файлы: понятные сообщения', () => {
  assert.throws(() => parseFile('a.doc', Buffer.from('x')), /\.docx/);
  assert.throws(() => parseFile('a.pdf', Buffer.from('x')), /не поддерживается/);
  assert.throws(() => parseFile('a.docx', Buffer.from('это не zip, а просто текст, достаточно длинный для проверки')), /не похож/);
  assert.throws(() => parseFile('a.txt', Buffer.from('  \n \n')), /нет текста/);
});

test('импорт в проект: главы встают в конец, названия и текст сохраняются, старые главы целы', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const project = require('../src/project');
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kab-imp-')), 'P');
  const first = project.createProject(dir, 'Книга').chapters[0].id;
  project.writeChapter(dir, first, 'Моя глава.');
  const chapters = parseFile('роман.txt', Buffer.from('Глава 1\nОдин.\nГлава 2\nДва.'));
  const res = project.importChapters(dir, chapters);
  assert.equal(res.ids.length, 2);
  assert.deepEqual(res.project.chapters.map((c) => c.title), ['Глава 1', 'Глава 2', 'Глава 3']); // «Глава N» в программе нумеруются по порядку
  assert.equal(res.project.chapters.length, 3);
  assert.equal(project.readChapter(dir, res.ids[1]), 'Два.');
  assert.equal(project.readChapter(dir, first), 'Моя глава.');
  assert.throws(() => project.importChapters(dir, []), /Нечего/);
});

test('импорт в новый проект: пустая первая глава занята первым файлом, лишней пустой главы нет', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const project = require('../src/project');
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kab-imp-')), 'P');
  const first = project.createProject(dir, 'Книга').chapters[0].id;
  const res = project.importChapters(dir, [{ title: 'Пролог', text: 'Темно.' }, { title: 'Дорога', text: 'Шли долго.' }]);
  assert.equal(res.project.chapters.length, 2);
  assert.equal(res.ids[0], first);
  assert.deepEqual(res.project.chapters.map((c) => c.title), ['Пролог', 'Дорога']);
  assert.equal(project.readChapter(dir, first), 'Темно.');
});

// ---------- RTF ----------

const { buildRtf } = require('../src/rtf');

// Строка → байты Windows-1251, как в настоящем RTF из Word (русские буквы в файле — один байт, а не юникод).
const cp1251 = (str) => Buffer.from([...str].map((c) => {
  const n = c.charCodeAt(0);
  if (n < 128) return n;
  if (n >= 0x410 && n <= 0x44f) return n - 0x410 + 0xc0;
  return 63;
}));

test('rtf: экспорт Кабинета читается обратно (главы, жирный, курсив, цитата, разделитель, юникод)', () => {
  const chapters = [
    { title: '1. Начало', text: 'Один **жирный** и *косой* текст — {скобки} \\ слэш.\n\n— Реплика.\n\n* * *\n\nПосле разделителя.' },
    { title: '2. Конец', text: '> Цитата\n\n## Подраздел\n\nФинал.' },
  ];
  const rtf = buildRtf('Книга', chapters, {});
  assert.ok(/^[\x00-\x7f]*$/.test(rtf), 'RTF целиком из ASCII');
  const out = parseFile('Книга.rtf', Buffer.from(rtf, 'latin1'));
  assert.deepEqual(out.map((c) => c.title), ['Начало', 'Конец']);
  assert.equal(out[0].text, 'Один **жирный** и *косой* текст — {скобки} \\\\ слэш.\n\n— Реплика.\n\n---\n\nПосле разделителя.'.replace('\\\\', '\\\\'));
  assert.equal(out[1].text, '> Цитата\n\n## Подраздел\n\nФинал.');
});

test('rtf: сборник рассказов — «Содержание» главой не считается', () => {
  const rtf = buildRtf('Сборник', [{ title: 'Лиса', text: 'Раз.' }, { title: 'Нора', text: 'Два.' }], { stories: true, toc: { heading: 'Содержание', items: ['Лиса', 'Нора'] } });
  assert.deepEqual(parseFile('с.rtf', Buffer.from(rtf, 'latin1')).map((c) => c.title), ['Лиса', 'Нора']);
});

test('rtf из Word: кодовая страница 1251 через \\\'hh, \\uN с запасным знаком, стили заголовков, таблица шрифтов и список пропускаются', () => {
  const rtf = '{\\rtf1\\ansi\\ansicpg1251\\deff0\\uc1{\\fonttbl{\\f0 Times;}}{\\colortbl;\\red0\\green0\\blue0;}'
    + '{\\stylesheet{\\s1 heading 1;}{\\s2 \\outlinelevel1 Заголовок 2;}}'
    + '{\\*\\generator Word}\\pard\\s1 \\\'c3\\\'eb\\\'e0\\\'e2\\\'e0 \\\'ef\\\'e5\\\'f0\\\'e2\\\'e0\\\'ff\\par'
    + '\\pard \\\'cf\\\'f0\\\'e8\\\'e2\\\'e5\\\'f2, {\\i \\u1084?\\u1080?\\u1088?} \\emdash  {\\b жирный}\\par'
    + '\\pard\\ls1{\\listtext\\bullet\\tab}Пункт\\par'
    + '\\pard\\s1 \\\'c3\\\'eb\\\'e0\\\'e2\\\'e0 \\\'e2\\\'f2\\\'ee\\\'f0\\\'e0\\\'ff\\par\\pard Конец\\par}';
  const ch = parseFile('в.rtf', cp1251(rtf));
  assert.deepEqual(ch.map((c) => c.title), ['Глава первая', 'Глава вторая']);
  assert.equal(ch[0].text, 'Привет, *мир* — **жирный**\n\n- Пункт');
  assert.equal(ch[1].text, 'Конец');
});

test('rtf: не RTF — понятное сообщение', () => {
  assert.throws(() => parseFile('x.rtf', Buffer.from('просто текст')), /RTF/);
});

test('rtf от pandoc: маркер списка внутри абзаца, юникод через \\uN с запасным знаком', () => {
  const rtf = '{\\rtf1\\ansi\\deff0{\\pard \\outlinelevel0 \\b \\u1043 ?\\u1083 ?\\u1072 ?\\u1074 ?\\u1072 ?\\par}'
    + '{\\pard \\u1058 ?\\u1077 ?\\u1082 ?\\u1089 ?\\u1090 ?\\par}{\\pard \\bullet \\tab \\u1087 ?\\u1091 ?\\u1085 ?\\u1082 ?\\u1090 ?\\par}}';
  assert.deepEqual(parseFile('p.rtf', Buffer.from(rtf, 'latin1')), [{ title: 'Глава', text: 'Текст\n\n- пункт' }]);
});
