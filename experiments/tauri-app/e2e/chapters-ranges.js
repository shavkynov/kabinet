'use strict';
// F.3.1-C: смена главы и точность диапазонов подсветки в настоящем окне Tauri (WebKitGTK под Xvfb, tauri-driver).
// Полный цикл: ProseMirror → snapshot → Tauri IPC → Rust → UDPipe → structural analyzer → PM ranges → Decorations.
//   node chapters-ranges.js <gsdmodel|toymodel>
// gsdmodel — настоящая Russian-GSD (KABINET_GSD_MODEL или каталог данных приложения); toymodel — игрушечная (KABINET_TOY_MODEL, /tmp/f2/toy.udpipe).
// Переменные: KABINET_BIN (бинарник; по умолчанию debug), KABINET_E2E_TMP, TAURI_DRIVER.
// Подменяется только момент доставки ответа (обёртка над window.kabinet.styleParse придерживает уже полученный реальный ответ).
const { spawn, execSync } = require('child_process');
const fs = require('fs');

const scenario = process.argv[2] || 'gsdmodel';
if (!['gsdmodel', 'toymodel'].includes(scenario)) { console.error('нужен gsdmodel или toymodel'); process.exit(3); }
const BIN = process.env.KABINET_BIN || '/home/claude/kabinet/experiments/tauri-app/src-tauri/target/debug/kabinet-tauri';
const PROFILE = /\/release\//.test(BIN) ? 'release' : 'debug';
const TMP = process.env.KABINET_E2E_TMP || '/tmp/f2';
const ROOT = `${TMP}/run-cr-${scenario}-${PROFILE}`;
const PROJ = `${ROOT}/proj`;
const XDG = `${ROOT}/xdg`;
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(`${XDG}/ru.kabinet.writer.tauri`, { recursive: true });
fs.mkdirSync(`${ROOT}/home`, { recursive: true });
execSync(`cp -r /home/claude/kabinet/experiments/tauri-app/core/tests/fixtures/stories ${PROJ}`);

// ---- главы проекта ----
const proj = JSON.parse(fs.readFileSync(`${PROJ}/project.json`, 'utf8'));
const [A, B] = proj.chapters.map((c) => c.id);
const extra = { v: 'c00000000v', g: 'c00000000g', u: 'c00000000u' };
proj.chapters.push({ id: extra.v, title: 'Рассказ В' }, { id: extra.g, title: 'Рассказ Г' }, { id: extra.u, title: 'Рассказ Д' });
fs.writeFileSync(`${PROJ}/project.json`, JSON.stringify(proj, null, 2));
const CH = {
  A: ['Осуществление проверки выполнения требований затянулось.',
    'Он шёл по тёмной улице 😀 и думал. Он почувствовал страх. Отряд осуществлял разведку.',
    'Он знал, что дом стоял, что сад шумел, что лес спал. Он имеет значение. Он поднял свою руку. Он вернулся обратно.'].join('\n\n') + '\n',
  B: ['Проведение анализа документов продолжалось долго.',
    'Мы осуществили разбор архива. Она сказала, что ветер стих, что дождь ушёл, что небо ясно. Она вернулась назад.',
    'Они осуществляют контроль качества. Он взял свою сумку.'].join('\n\n') + '\n',
  V: '',
  G: 'Дверь открылась. Она вошла в комнату и села у окна.\n\nЗа окном шёл снег.\n',
  // NBSP, ZWSP, BOM внутри строки, CRLF между абзацами, emoji, комбинирующий знак
  U: 'Осуществление проверки выполнения​ требований затянулось. 😀 Он вернулся обратно.\r\n\r\nОн ﻿почувствовал страх. Отряд осуществлял​разведку 🎉 тихо.\r\n\r\nОн знал, что дом стоял, что сад шумел, что лес спал. Он поднял свою руку.\n',
};
fs.writeFileSync(`${PROJ}/Главы/${A}.md`, CH.A);
fs.writeFileSync(`${PROJ}/Главы/${B}.md`, CH.B);
fs.writeFileSync(`${PROJ}/Главы/${extra.v}.md`, CH.V);
fs.writeFileSync(`${PROJ}/Главы/${extra.g}.md`, CH.G);
fs.writeFileSync(`${PROJ}/Главы/${extra.u}.md`, CH.U);
fs.writeFileSync(`${XDG}/ru.kabinet.writer.tauri/recents.json`, JSON.stringify([{ path: PROJ, name: 'Сборник & рассказы', lastOpened: new Date().toISOString() }]));

const env = { ...process.env, DISPLAY: ':99', HOME: `${ROOT}/home`, XDG_DATA_HOME: XDG, XDG_CONFIG_HOME: `${ROOT}/home/.config`, XDG_CACHE_HOME: `${ROOT}/home/.cache`, WEBKIT_DISABLE_COMPOSITING_MODE: '1' };
delete env.KABINET_STYLE_MODEL; delete env.KABINET_STYLE_MODEL_SHA256; delete env.KABINET_STYLE_MODEL_VERSION;
if (scenario === 'gsdmodel') {
  const src = process.env.KABINET_GSD_MODEL || `${process.env.HOME}/.local/share/ru.kabinet.writer.tauri/style-models/russian-gsd-ud-2.5-191206.udpipe`;
  if (!fs.existsSync(src)) { console.error(`gsdmodel: нет файла модели ${src}`); process.exit(3); }
  fs.mkdirSync(`${XDG}/ru.kabinet.writer.tauri/style-models`, { recursive: true });
  fs.copyFileSync(src, `${XDG}/ru.kabinet.writer.tauri/style-models/russian-gsd-ud-2.5-191206.udpipe`);
} else {
  env.KABINET_STYLE_MODEL = process.env.KABINET_TOY_MODEL || `${TMP}/toy.udpipe`; env.KABINET_STYLE_MODEL_SHA256 = ''; env.KABINET_STYLE_MODEL_VERSION = 'toy-synthetic';
}

const STYLE_CATS = ['chancery', 'weak', 'tell', 'chain', 'remark', 'redund', 'which', 'own'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = []; const results = [];
const ok = (cond, label, extra2) => { results.push([!!cond, label]); console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${extra2 !== undefined ? ' :: ' + (typeof extra2 === 'string' ? extra2 : JSON.stringify(extra2)).slice(0, 380) : ''}`); };
const skipped = [];
// Предусловие данных: на настоящей GSD обязательно (иначе FAIL); игрушечная модель может не дать findings — тогда SKIP, не засчитывается как успех.
const needData = (cond, label, extra2) => { if (cond || scenario === 'gsdmodel') ok(cond, label, extra2); else { skipped.push(label); console.log(`SKIP ${label} :: нет данных у игрушечной модели`); } };
async function wd(method, p, body) {
  const r = await fetch(`http://127.0.0.1:4444${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (j.value && typeof j.value === 'object' && typeof j.value.error === 'string' && typeof j.value.stacktrace === 'string') throw new Error(`${j.value.error}: ${j.value.message}`);
  return j.value;
}

(async () => {
  procs.push(spawn('Xvfb', [':99', '-screen', '0', '1400x900x24'], { stdio: 'ignore' }));
  await sleep(1200);
  const drv = spawn(process.env.TAURI_DRIVER || 'tauri-driver', ['--port', '4444', '--native-port', '4445', '--native-driver', '/usr/bin/WebKitWebDriver'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  drv.stdout.on('data', (d) => fs.appendFileSync(`${ROOT}/driver.log`, d)); drv.stderr.on('data', (d) => fs.appendFileSync(`${ROOT}/driver.log`, d));
  procs.push(drv); await sleep(1500);

  const sid = (await wd('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: BIN } } } })).sessionId;
  const sync = (script, args = []) => wd('POST', `/session/${sid}/execute/sync`, { script, args });
  const wait = async (fn, ms = 15000) => { const t = Date.now(); for (;;) { const v = await sync(`return (${fn})()`); if (v) return v; if (Date.now() - t > ms) return false; await sleep(200); } };
  const keyseq = (vals) => wd('POST', `/session/${sid}/actions`, { actions: [{ type: 'key', id: 'k', actions: vals.flatMap((v) => [{ type: 'keyDown', value: v }, { type: 'keyUp', value: v }]) }] });
  const key = (v) => keyseq([v]);
  const END = ''; const HOME = ''; const DEL = ''; const BKSP = ''; const CTRL = '';
  const total = (o) => Object.values(o).reduce((a, b) => a + b.length, 0);

  const stateNow = () => sync(`const s = window.__styleShadow; if (!s) return null; const o = { task: s.task, at: s.at, status: s.status, ok: s.ok, error: s.error, accepted: s.acceptedRanges, findingsCount: s.findingsCount, sentences: s.sentences, reason: s.reason, rejected: s.rejectedFindings, diag: (s.diagnostics || []).map((d) => d.code), f: {} };
    for (const c of ${JSON.stringify(STYLE_CATS)}) o.f[c] = (s[c] || []).map((x) => ({ start: x.start, end: x.end, fragment: x.fragment })); return o;`);
  const settle = async (ms = 30000) => { const t = Date.now(); for (;;) { const s = await stateNow(); if (s && !['pending', 'running'].includes(s.status)) return s; if (Date.now() - t > ms) return s; await sleep(200); } };
  const inspect = () => sync(`return window.kabinetStyleShadow.inspect()`);
  const counters = () => sync(`const o = {}; for (const c of ${JSON.stringify(STYLE_CATS)}) { const el = document.getElementById('anCount_' + c); const nav = document.querySelector('[data-an-nav="' + c + '"][data-dir="1"]'); o[c] = { n: el ? parseInt(el.textContent, 10) || 0 : 0, navDisabled: nav ? nav.disabled : null }; } return o;`);
  const domMarks = () => sync(`const o = []; for (const e of document.querySelectorAll('.ProseMirror .an')) { const cls = [...e.classList].find((c) => /^an-/.test(c)); o.push({ cls, text: e.textContent }); } return o;`);
  const openChap = async (title) => {
    const hit = await sync(`const el = [...document.querySelectorAll('li, .chapter, .item, div, span')].filter((e) => e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(title)})[0]; if (el) el.click(); return !!el;`);
    if (!hit) throw new Error(`нет главы «${title}» в списке`);
  };
  const flat = (st) => STYLE_CATS.flatMap((c) => (st.f[c] || []).map((x) => ({ ...x, cat: c })));
  const fragsOf = (st) => new Set(flat(st).map((x) => x.fragment));

  // Инварианты «состояние тени и подсветка относятся к ТЕКУЩЕМУ документу и точны».
  async function invariants(label, st, { expectOk = true } = {}) {
    const ins = await inspect(); const cnt = await counters();
    const probs = [];
    if (expectOk && !(st && st.status === 'ok' && st.ok)) probs.push(`status=${st && st.status} ${st && st.error}`);
    const allFindings = flat(st || { f: {} });
    // offsets findings = UTF-16 offsets снимка текущего документа
    for (const f of allFindings) if (ins.text.slice(f.start, f.end) !== f.fragment) probs.push(`offset ${f.cat}:${f.start}-${f.end} «${f.fragment}» ≠ «${ins.text.slice(f.start, f.end)}»`);
    for (const cat of STYLE_CATS) {
      const rs = ins.ranges[cat];
      for (let i = 0; i < rs.length; i += 1) {
        if (/\n/.test(rs[i].text)) probs.push(`range ${cat} пересекает абзацы «${rs[i].text}»`);
        if (i && !(rs[i].from >= rs[i - 1].to)) probs.push(`пересечение/дубль ${cat}: ${JSON.stringify(rs[i - 1])} ${JSON.stringify(rs[i])}`);
        const src = (st.f[cat] || []).filter((f) => rs[i].text.includes(f.fragment));
        if (!src.length) probs.push(`range ${cat} «${rs[i].text}» не соответствует ни одному finding`);
      }
      for (const f of st.f[cat] || []) if (!rs.some((r) => r.text.includes(f.fragment))) probs.push(`finding ${cat} «${f.fragment}» не подсвечен`);
    }
    // DOM-подсветка = ranges (decorations ровно по ranges, без остатков)
    const dom = await domMarks();
    const domByCls = {};
    for (const m of dom) domByCls[m.cls] = (domByCls[m.cls] || 0) + 1;
    const rangesTotal = total(ins.ranges);
    if (expectOk && st.accepted !== rangesTotal) probs.push(`accepted=${st.accepted}, ranges=${rangesTotal}`);
    const sumCnt = Object.values(cnt).reduce((a, c) => a + c.n, 0);
    if (expectOk && sumCnt !== rangesTotal) probs.push(`счётчики=${sumCnt}, ranges=${rangesTotal}`);
    for (const c of STYLE_CATS) if (cnt[c].navDisabled !== null && cnt[c].navDisabled !== !(cnt[c].n > 0)) probs.push(`«‹ ›» ${c}: disabled=${cnt[c].navDisabled}, n=${cnt[c].n}`);
    ok(probs.length === 0, `${label}: инварианты (offsets, ranges, дубли, счётчики, навигация)`, probs.length ? probs.slice(0, 4) : { findings: allFindings.length, ranges: rangesTotal, counters: sumCnt });
    return { ins, cnt, dom };
  }

  // ---- 0. окно, проект ----
  await wait('() => !!window.kabinet && !!document.querySelector("#recentList")', 30000);
  ok(await sync(`return !!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) && typeof window.__calls === 'undefined'`), 'настоящий Tauri IPC, без подставного моста');
  await sync(`document.querySelector('#recentList .recent-main').click()`);
  ok(await wait('() => { const e = document.querySelector(".ProseMirror"); return !!e && e.offsetParent !== null; }', 15000), 'проект открыт');
  await sleep(800);
  await sync(`for (const c of ${JSON.stringify(STYLE_CATS)}) { const b = document.getElementById('an_' + c); if (b && !b.checked) b.click(); } return true;`);
  await sync(`const b = document.getElementById('btnStyle'); if (b && document.getElementById('stylePanel').hidden) b.click(); return true;`);
  await openChap('Рассказ А'); await sleep(600);
  ok(/Осуществление проверки/.test(await sync(`return document.querySelector('.ProseMirror').innerText`)), 'глава А загружена');
  await sync(`window.kabinetStyleShadow.enable(); return true;`);
  const pmId = Object.values(await wd('POST', `/session/${sid}/element`, { using: 'css selector', value: '.ProseMirror' }))[0];
  const focusEnd = async () => { await wd('POST', `/session/${sid}/element/${pmId}/click`, {}); await key(END); };

  // ---- 1. базовая линия: глава А ----
  await focusEnd(); await key(' '); await sleep(200);
  const stA = await settle();
  ok(stA && stA.status === 'ok', `А: анализ готов (${stA && stA.status}), findings=${stA && stA.findingsCount}`, stA && stA.error);
  await invariants('А', stA);
  const fragA = fragsOf(stA);
  const fragsAOnly = [...fragA];
  const marksAll = (ins) => STYLE_CATS.flatMap((c) => ins.ranges[c].map((r) => r.text));
  fs.writeFileSync(`${ROOT}/state-A.json`, JSON.stringify(stA, null, 2));

  // ---- 2. А завершена, переход на Б: состояние обязано быть пересчитано под Б (а не остаться от А) ----
  let tSw = Date.now();
  await openChap('Рассказ Б'); await sleep(250);
  let st = await settle();
  ok(st && st.at >= tSw, 'А→Б (без запроса в полёте): тень пересчитана для новой главы, а не осталась от А', st && [st.at - tSw, st.status]);
  let r = await invariants('Б после А', st);
  const fragB = fragsOf(st);
  ok(!marksAll(r.ins).some((t) => fragsAOnly.includes(t) && !fragB.has(t)), 'Б: подсветка глав А не осталась', marksAll(r.ins));
  ok(r.ins.text.startsWith('Проведение анализа') && !/Отряд/.test(r.ins.text), 'Б: активен именно текст главы Б');

  // ---- 3. А→Б при запросе А в полёте (ответ придержан), поздний ответ не должен попасть в Б ----
  await openChap('Рассказ А'); await sleep(250); await settle();
  await sync(`const orig = window.kabinet.styleParse; window.__origParse = orig; window.__spLog = []; window.__delayNext = 0; let n = 0;
    window.kabinet.styleParse = function (text, id) { const k = ++n; const d = window.__delayNext; window.__delayNext = 0; window.__spLog.push({ k, id, delay: d, head: text.slice(0, 12) }); const p = orig.call(window.kabinet, text, id);
      return d ? p.then((res) => new Promise((done) => setTimeout(() => { window.__spLog.push({ k, late: true, head: text.slice(0, 12) }); done(res); }, d))) : p; }; return true;`);
  await sync(`window.__delayNext = 4500; return true;`);
  await focusEnd(); await key('ы'); // правка А запускает запрос, ответ придержан
  ok(await wait('() => window.__spLog.some((e) => e.delay && !e.late)', 8000), 'А: запрос ушёл в IPC, ответ придержан на 4,5 с');
  const stFlightA = await stateNow();
  tSw = Date.now();
  await openChap('Рассказ Б'); await sleep(300);
  let ins = await inspect();
  ok(ins.text.startsWith('Проведение анализа'), 'переход на Б выполнен, пока запрос А в полёте');
  ok(!marksAll(ins).some((t) => fragsAOnly.includes(t) && !fragB.has(t)), 'сразу после перехода подсветка А убрана', marksAll(ins));
  ok(await wait('() => window.__spLog.some((e) => e.late)', 9000), 'поздний ответ А доставлен в приложение');
  await sleep(300);
  const stAfterLate = await settle();
  const marksBeforeFinal = await inspect();
  ok(stAfterLate && stAfterLate.at >= tSw, 'после позднего ответа тень относится к Б (пересчитана после перехода)', stAfterLate && [stAfterLate.at - tSw, stAfterLate.status]);
  r = await invariants('Б после позднего ответа А', stAfterLate);
  ok(!marksAll(marksBeforeFinal).some((t) => fragsAOnly.includes(t) && !fragB.has(t)), 'поздний ответ А не вернул подсветку А в Б', marksAll(marksBeforeFinal));

  // ---- 4. обратный переход Б→А ----
  tSw = Date.now();
  await sync(`window.kabinet.styleParse = window.__origParse; return true;`);
  await openChap('Рассказ А'); await sleep(250);
  st = await settle();
  ok(st && st.at >= tSw, 'Б→А: тень пересчитана для А', st && [st.at - tSw, st.status]);
  r = await invariants('А после Б', st);
  ok(/Отряд/.test(r.ins.text) && !/Проведение анализа/.test(r.ins.text), 'А: активен текст главы А');
  ok(!marksAll(r.ins).some((t) => fragB.has(t) && !fragsOf(st).has(t)), 'А: подсветка Б не осталась');

  // ---- 5. быстрые переключения ----
  for (const finalTitle of ['Рассказ Б', 'Рассказ А']) {
    tSw = Date.now();
    for (const t of ['Рассказ А', 'Рассказ Б', 'Рассказ А', 'Рассказ Б', 'Рассказ А', 'Рассказ Б', finalTitle]) { await openChap(t); await sleep(70); }
    await sleep(400);
    st = await settle(40000);
    r = await invariants(`быстрые переключения → ${finalTitle}`, st);
    const wantStart = finalTitle === 'Рассказ А' ? 'Осуществление проверки' : 'Проведение анализа';
    ok(r.ins.text.startsWith(wantStart) && st.at >= tSw, `быстрые переключения: активна «${finalTitle}», тень пересчитана после последнего перехода`, [r.ins.text.slice(0, 20), st.at - tSw]);
  }

  // ---- 6. пустая глава и глава без замечаний ----
  tSw = Date.now();
  await openChap('Рассказ В'); await sleep(300);
  st = await settle();
  r = await invariants('пустая глава В', st, { expectOk: false });
  ok(st && st.status === 'empty' && st.at >= tSw && marksAll(r.ins).length === 0 && r.dom.length === 0, 'пустая глава: status=empty, подсветки и счётчиков нет', st && [st.status, r.dom.length]);
  tSw = Date.now();
  await openChap('Рассказ Г'); await sleep(300);
  st = await settle();
  r = await invariants('глава без замечаний Г', st);
  ok(st && st.status === 'ok' && st.accepted === 0 && st.at >= tSw && marksAll(r.ins).length === 0, 'глава без замечаний: status=ok, 0 ranges, подсветки нет', st && [st.status, st.accepted]);
  await openChap('Рассказ А'); await sleep(300); st = await settle();
  r = await invariants('А после пустой и чистой', st);
  ok(total(r.ins.ranges) > 0, 'А после пустой и чистой глав: замечания снова есть', total(r.ins.ranges));

  // ---- 7. диапазоны на настоящих результатах: NBSP, ZWSP, BOM, CRLF, emoji ----
  await openChap('Рассказ Д'); await sleep(400); st = await settle();
  r = await invariants('глава Д (NBSP, ZWSP, BOM, CRLF, emoji)', st);
  ok(/ /.test(r.ins.text) && /​/.test(r.ins.text) && /😀/.test(r.ins.text), 'Д: в снимке сохранены NBSP, ZWSP, emoji', JSON.stringify(r.ins.text.slice(0, 60)));
  ok(/Отряд осуществлял/.test(r.ins.text) || /осуществлял/.test(r.ins.text), 'Д: абзац после CRLF разобран');
  const idxAfterEmoji = flat(st).filter((f) => f.start > r.ins.text.indexOf('😀'));
  needData(idxAfterEmoji.length > 0 && idxAfterEmoji.every((f) => r.ins.text.slice(f.start, f.end) === f.fragment), 'Д: findings после emoji/NBSP/ZWSP не смещены', idxAfterEmoji.length);
  fs.writeFileSync(`${ROOT}/state-U.json`, JSON.stringify({ st, ranges: r.ins.ranges, text: r.ins.text }, null, 2));

  // ---- 8. правки: до диапазона, внутри, удаление, вставка перед ----
  await openChap('Рассказ А'); await sleep(400); await settle();
  const selectIn = (cls, mode) => sync(`const el = document.querySelector('.ProseMirror .${cls}'); if (!el) return false; const tn = el.firstChild; document.querySelector('.ProseMirror').focus(); const r = document.createRange();
    if (${JSON.stringify(mode)} === 'start') { r.setStart(tn, 0); r.collapse(true); } else if (${JSON.stringify(mode)} === 'inside') { r.setStart(tn, Math.min(3, tn.length - 1)); r.collapse(true); } else { r.selectNodeContents(tn); }
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); return el.textContent;`);
  const editCase = async (label, prep, act) => {
    const before = await inspect();
    const target = await prep();
    if (target === false) { needData(false, `${label}: нет целевой подсветки`); return; }
    const t0 = Date.now();
    await act();
    await sleep(150);
    const mid = await inspect();
    // сразу после правки (до новой тени) устаревших engine-ranges быть не должно: каждый range обязан лежать в тексте текущего документа
    const sane = Object.values(mid.ranges).flat().every((x) => mid.text.includes(x.text) || x.text.length === 0);
    ok(sane, `${label}: сразу после правки подсветка согласована с текущим текстом`);
    const s2 = await settle();
    ok(s2 && s2.at >= t0, `${label}: тень пересчитана после правки`, s2 && [s2.at - t0, s2.status]);
    const rr = await invariants(label, s2);
    return { before, after: rr.ins, st: s2, target };
  };
  // до диапазона: курсор в начало документа, печать
  await editCase('правка ДО диапазона (начало документа)', async () => { await wd('POST', `/session/${sid}/element/${pmId}/click`, {}); await keyseq([CTRL, HOME]); return true; }, async () => { await keyseq(['Ы', ' ']); });
  await editCase('правка ВНУТРИ диапазона', () => selectIn('an-chancery', 'inside'), async () => { await key('х'); });
  const delCase = await editCase('УДАЛЕНИЕ найденного фрагмента', () => selectIn('an-chancery', 'all'), async () => { await key(DEL); });
  if (delCase) ok(!delCase.after.text.includes(delCase.target), 'удалённый фрагмент исчез из текста и подсветки', delCase.target);
  const insCase = await editCase('ВСТАВКА перед найденным фрагментом', () => selectIn('an-weak', 'start').then((v) => (v === false ? selectIn('an-chancery', 'start') : v)), async () => { await keyseq(['о', 'ч', 'е', 'н', 'ь', ' ']); });
  if (insCase) ok(insCase.after.text.includes('очень '), 'вставка видна в тексте, подсветка пересчитана');

  // ---- 9. правка во время анализа: быстрая серия ввода, результат только по последнему тексту ----
  await focusEnd();
  const t1 = Date.now();
  for (const ch of ['а', 'б', 'в', 'г', 'д']) { await key(ch); await sleep(120); }
  st = await settle();
  r = await invariants('серия правок во время анализа', st);
  ok(st && st.at >= t1 && /абвгд/.test(r.ins.text), 'после серии правок результат относится к последнему тексту', [st && st.at - t1, /абвгд/.test(r.ins.text)]);

  await wd('DELETE', `/session/${sid}`);
  const bad = results.filter((x) => !x[0]);
  console.log(`\nchapters-ranges ${scenario} (${PROFILE}): ${results.length - bad.length}/${results.length} ok${skipped.length ? `, пропущено без данных: ${skipped.length}` : ''}`);
  process.exitCode = bad.length ? 1 : 0;
})().catch((e) => { console.error('E2E error:', e.stack || e); process.exitCode = 2; }).finally(() => { for (const p of procs.reverse()) { try { p.kill('SIGTERM'); } catch {} } setTimeout(() => process.exit(process.exitCode || 0), 500); });
