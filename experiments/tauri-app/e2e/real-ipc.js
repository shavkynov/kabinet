'use strict';
// Реальный Tauri IPC: настоящее окно (WebKitGTK под Xvfb) через tauri-driver. Моста-заглушки нет.
// Linux: apt install libwebkit2gtk-4.1-dev xvfb webkit2gtk-driver; cargo install tauri-driver --locked.
//   node real-ipc.js <nomodel|badmodel|badpath|userdir|toymodel|gsdmodel|edge>
// userdir: файл лежит в <данные приложения>/style-models/ под именем GSD-модели, переменных окружения нет;
//   игрушечная модель не проходит SHA-256, и это доказывает, что файл найден во внешнем каталоге и контрольная сумма проверяется.
// toymodel/edge требуют игрушечную модель: make-toy-model.sh (не GSD, в репозиторий не входит).
// gsdmodel: настоящая Russian-GSD из KABINET_GSD_MODEL (по умолчанию ~/.local/share/ru.kabinet.writer.tauri/style-models/…), кладётся
//   в <данные приложения>/style-models/ без переменных окружения; SHA-256 проверяет само приложение. В репозиторий модель не входит.
// Переменные: KABINET_BIN (путь к установленному бинарнику), KABINET_E2E_TMP (рабочий каталог, по умолчанию /tmp/f2),
// KABINET_TOY_MODEL, KABINET_GSD_MODEL, TAURI_DRIVER.
const { spawn, execSync } = require('child_process');
const fs = require('fs');

const scenario = process.argv[2] || 'nomodel';
const BIN = process.env.KABINET_BIN || '/home/claude/kabinet/experiments/tauri-app/src-tauri/target/debug/kabinet-tauri';
const TMP = process.env.KABINET_E2E_TMP || '/tmp/f2';
const ROOT = `${TMP}/run-${scenario}${process.env.KABINET_BIN ? '-installed' : ''}`;
const PROJ = `${ROOT}/proj`;
const XDG = `${ROOT}/xdg`;
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(`${XDG}/ru.kabinet.writer.tauri`, { recursive: true });
fs.mkdirSync(`${ROOT}/home`, { recursive: true });
execSync(`cp -r /home/claude/kabinet/experiments/tauri-app/core/tests/fixtures/stories ${PROJ}`);
const chap = JSON.parse(fs.readFileSync(`${PROJ}/project.json`, 'utf8')).chapters[0].id;
const CHAPTER = [
  'Осуществление проверки выполнения требований затянулось.',
  'Он шёл по тёмной улице 😀 и думал. Он почувствовал страх. Отряд осуществлял разведку.',
  'Он знал, что дом стоял, что сад шумел, что лес спал. Он имеет значение. Он поднял свою руку. Он вернулся обратно.',
].join('\n\n') + '\n';
fs.writeFileSync(`${PROJ}/Главы/${chap}.md`, CHAPTER);
fs.writeFileSync(`${XDG}/ru.kabinet.writer.tauri/recents.json`, JSON.stringify([{ path: PROJ, name: 'Сборник & рассказы', lastOpened: new Date().toISOString() }]));

const env = { ...process.env, DISPLAY: ':99', HOME: `${ROOT}/home`, XDG_DATA_HOME: XDG, XDG_CONFIG_HOME: `${ROOT}/home/.config`, XDG_CACHE_HOME: `${ROOT}/home/.cache`, WEBKIT_DISABLE_COMPOSITING_MODE: '1' };
delete env.KABINET_STYLE_MODEL; delete env.KABINET_STYLE_MODEL_SHA256; delete env.KABINET_STYLE_MODEL_VERSION;
if (scenario === 'badmodel') { fs.writeFileSync(`${TMP}/bad.udpipe`, Buffer.alloc(1024, 7)); env.KABINET_STYLE_MODEL = `${TMP}/bad.udpipe`; }
if (scenario === 'userdir') {
  const dir = `${XDG}/ru.kabinet.writer.tauri/style-models`;
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(process.env.KABINET_TOY_MODEL || `${TMP}/toy.udpipe`, `${dir}/russian-gsd-ud-2.5-191206.udpipe`);
}
if (scenario === 'gsdmodel') {
  const src = process.env.KABINET_GSD_MODEL || `${process.env.HOME}/.local/share/ru.kabinet.writer.tauri/style-models/russian-gsd-ud-2.5-191206.udpipe`;
  if (!fs.existsSync(src)) { console.error(`gsdmodel: нет файла модели ${src}`); process.exit(3); }
  const dir = `${XDG}/ru.kabinet.writer.tauri/style-models`;
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(src, `${dir}/russian-gsd-ud-2.5-191206.udpipe`);
}
const withModel = scenario === 'toymodel' || scenario === 'gsdmodel';
if (scenario === 'badpath') env.KABINET_STYLE_MODEL = `${TMP}/does-not-exist.udpipe`;
if (scenario === 'toymodel' || scenario === 'edge') { env.KABINET_STYLE_MODEL = process.env.KABINET_TOY_MODEL || `${TMP}/toy.udpipe`; env.KABINET_STYLE_MODEL_SHA256 = ''; env.KABINET_STYLE_MODEL_VERSION = 'toy-synthetic'; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = []; const results = [];
const ok = (cond, label, extra) => { results.push([!!cond, label]); console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${extra !== undefined ? ' :: ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 300) : ''}`); };
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
  const async_ = (script, args = []) => wd('POST', `/session/${sid}/execute/async`, { script, args });
  const wait = async (fn, ms = 15000) => { const t = Date.now(); for (;;) { const v = await sync(`return (${fn})()`); if (v) return v; if (Date.now() - t > ms) return false; await sleep(250); } };
  const key = (v) => wd('POST', `/session/${sid}/actions`, { actions: [{ type: 'key', id: 'k', actions: [{ type: 'keyDown', value: v }, { type: 'keyUp', value: v }] }] });
  const marks = () => sync(`const o = {}; for (const e of document.querySelectorAll('.ProseMirror .an')) { for (const c of e.classList) { if (/^an-/.test(c)) o[c] = (o[c] || 0) + 1; } } return o;`);
  const shadowFinal = async (ms = 25000) => { const t = Date.now(); let st = null; for (;;) { st = await sync(`return window.__styleShadow || null`); if (st && st.status && !['pending', 'running'].includes(st.status)) return st; if (Date.now() - t > ms) return st; await sleep(250); } };

  // 0. настоящий мост и Tauri
  await wait('() => !!window.kabinet && !!document.querySelector("#recentList")', 30000);
  const env0 = await sync(`return { tauri: !!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke), fake: typeof window.__calls !== 'undefined', parse: String(window.kabinet.styleParse), ua: navigator.userAgent }`);
  ok(env0.tauri, 'window.__TAURI__.core.invoke есть (настоящий Tauri)', env0.ua);
  ok(!env0.fake, 'подставного window.__calls нет');
  ok(/style:parse/.test(env0.parse), 'styleParse идёт в канал style:parse');

  // 1. проект через интерфейс
  await sync(`document.querySelector('#recentList .recent-main').click()`);
  ok(await wait('() => { const e = document.querySelector(".ProseMirror"); return !!e && e.offsetParent !== null; }', 15000), 'проект открыт через интерфейс');
  await sleep(800);
  await sync(`const el = [...document.querySelectorAll('li, .chapter, .item, div, span')].filter((e) => e.children.length === 0 && e.textContent.trim() === 'Рассказ А')[0]; if (el) el.click(); return !!el;`);
  await wait('() => /Осуществление проверки/.test(document.querySelector(".ProseMirror").innerText)', 8000);
  const chapter = await sync(`return document.querySelector('.ProseMirror').innerText`);
  ok(/Осуществление проверки/.test(chapter) && /😀/.test(chapter), 'глава (с emoji) загружена через chapter:read', chapter.slice(0, 40));

  // 2. категории включены, тень выключена: базовая линия старого анализатора
  await sync(`for (const c of ['chancery','weak','tell','chain','remark','redund','which','own']) { const b = document.getElementById('an_' + c); if (b && !b.checked) b.click(); } return true;`);
  await sleep(1500);
  const base = await marks();
  const baseTotal = Object.values(base).reduce((a, b) => a + b, 0);
  console.log('baseline (старый анализатор, тень выкл):', JSON.stringify(base));
  ok(baseTotal > 0, 'базовая линия: старый анализатор подсвечивает текст в настоящем окне', baseTotal);

  // 3. включить тень и сделать реальный ввод
  await sync(`window.kabinetStyleShadow.enable(); return true;`);
  const pmId = Object.values(await wd('POST', `/session/${sid}/element`, { using: 'css selector', value: '.ProseMirror' }))[0];
  await wd('POST', `/session/${sid}/element/${pmId}/click`, {});
  await key('\uE010'); await key(' ');
  await sleep(300);
  const st = await shadowFinal();
  fs.writeFileSync(`${ROOT}/shadow.json`, JSON.stringify(st, null, 2));
  console.log('shadow ->', JSON.stringify({ status: st && st.status, ok: st && st.ok, error: st && st.error, sentences: st && st.sentences, tokens: st && st.tokens, findings: st && st.findingsCount, accepted: st && st.acceptedRanges, rejected: st && st.rejectedFindings, analysisMs: st && st.analysisMs, diag: st && (st.diagnostics || []).map((d) => d.code) }));
  await sleep(300);
  const afterShadow = await marks();
  const afterTotal = Object.values(afterShadow).reduce((a, b) => a + b, 0);
  console.log('marks после тени:', JSON.stringify(afterShadow));

  if (withModel) {
    ok(st && st.status === 'ok' && st.ok === true, 'успех: status=ok через реальный IPC', st && (st.status + ' ' + (st.error || '')));
    ok(st && st.sentences >= 4 && st.tokens >= 20, 'успех: контракт содержит предложения и токены', st && [st.sentences, st.tokens]);
    ok(st && (st.diagnostics || []).every((d) => !['fragment-mismatch', 'invalid-finding', 'invalid-prosemirror-range', 'leaf-boundary'].includes(d.code)), 'успех: адаптер не отклонил ни одного finding из-за смещения offsets', st && (st.diagnostics || []).map((d) => d.code));
    ok(st && st.ruleErrors && st.ruleErrors.length === 0, 'успех: правила без ошибок', st && st.ruleErrors);
    ok(st && st.acceptedRanges === afterTotal, 'успех: число принятых ranges равно числу подсветок в редакторе', [st && st.acceptedRanges, afterTotal]);
  } else if (scenario !== 'edge') {
    const want = (scenario === 'badmodel' || scenario === 'userdir') ? /SHA-256/ : /не найдена/;
    ok(st && st.status === 'error' && st.ok === false && want.test(st.error || ''), 'ошибка модели видна как status=error с понятным сообщением', st && st.error);
    ok(afterTotal === baseTotal, 'откат: при ошибке парсера подсветка старого анализатора сохранена', [baseTotal, afterTotal]);
  }

  // 4. редактор жив
  const before = await sync(`return document.querySelector('.ProseMirror').innerText`);
  await key('я'); await sleep(400);
  const typed = await sync(`return document.querySelector('.ProseMirror').innerText`);
  ok(typed.length === before.length + 1 && /я/.test(typed), 'редактор принимает ввод после результата/ошибки');

  await sync(`window.kabinetStyleShadow.disable(); return true;`); // тень не должна вытеснять прямые задачи
  await sleep(300);
  // 5. прямой IPC
  const direct = await async_(`const done = arguments[arguments.length - 1]; const out = {};
    const t = async (k, f) => { try { out[k] = { ok: await f() }; } catch (e) { out[k] = { err: String(e && e.message || e) }; } };
    (async () => {
      await t('cancel', () => window.kabinet.styleCancel(1));
      await t('parseNoTask', () => window.__TAURI__.core.invoke('call', { channel: 'style:parse', args: ['x'] }));
      await t('cancelNoTask', () => window.__TAURI__.core.invoke('call', { channel: 'style:cancel', args: [] }));
      await t('parseBadTask', () => window.kabinet.styleParse('x', 'abc'));
      await t('parseNul', () => window.kabinet.styleParse('a\\u0000b', 2));
      done(out);
    })();`);
  console.log('direct ->', JSON.stringify(direct).slice(0, 600));
  ok(direct.cancel && direct.cancel.ok === true, 'style:cancel отвечает true');
  ok(direct.parseNoTask && /номер задачи/.test(direct.parseNoTask.err || ''), 'style:parse без taskId: понятная ошибка');
  ok(direct.cancelNoTask && /номер задачи/.test(direct.cancelNoTask.err || ''), 'style:cancel без taskId: понятная ошибка');
  ok(direct.parseBadTask && /номер задачи/.test(direct.parseBadTask.err || ''), 'style:parse с нечисловым taskId: ошибка');

  let deepData = null;
  if (withModel) {
    const deep = await async_(`const done = arguments[arguments.length - 1]; const out = {};
      (async () => {
        const text = ${JSON.stringify(CHAPTER.trim().replace(/\n\n/g, '\n\n'))};
        const t0 = performance.now();
        const a = await window.kabinet.styleParse(text, 101); out.cold = Math.round(performance.now() - t0); out.coldRust = a.ms;
        const t1 = performance.now();
        const b = await window.kabinet.styleParse(text, 102); out.warm = Math.round(performance.now() - t1); out.warmRust = b.ms;
        // offsets в UTF-16 на тексте с emoji
        let bad = 0, n = 0;
        for (const s of b.parse.sentences) { for (const k of s.tokens) { n += 1; if (text.slice(k.start, k.end) !== k.text) bad += 1; } if (text.slice(s.start, s.end) !== s.text) bad += 1; }
        out.tokens = n; out.badOffsets = bad; out.parser = b.parse.parser; out.cancelledFlag = b.cancelled; out.schema = b.parse.schemaVersion;
        // длинный текст + отмена
        // Длина «долгого» запроса подбирается по скорости ЭТОЙ модели и сборки: разбор обязан идти заведомо дольше головы старта (60 мс),
        // иначе проверка отмены зависит от скорости машины, а не от приложения. Проверки отмены при этом не ослаблены.
        const mk = (n) => 'Он пришёл домой.\\n\\n'.repeat(n);
        const tc = performance.now(); await window.kabinet.styleParse(mk(200), 150); const per = Math.max((performance.now() - tc) / 200, 0.001);
        const N = Math.min(300000, Math.max(1500, Math.ceil(3000 / per)));
        out.longParas = N; out.perParaMs = Math.round(per * 1000) / 1000;
        const long = mk(N);
        const pl = window.kabinet.styleParse(long, 201);
        await new Promise((r) => setTimeout(r, 60));
        const c = await window.kabinet.styleCancel(201);
        const rl = await pl; out.cancel = { ack: c, cancelled: rl.cancelled, taskId: rl.taskId };
        const after = await window.kabinet.styleParse('Он пришёл.', 202); out.afterCancel = { cancelled: after.cancelled, sentences: after.parse.sentences.length };
        // новый запрос отменяет прежний (одна задача одновременно)
        const p1 = window.kabinet.styleParse(long, 301);
        await new Promise((r) => setTimeout(r, 60));
        const p2 = window.kabinet.styleParse('Он пришёл.', 302);
        const [r1, r2] = await Promise.all([p1, p2]);
        out.replace = { first: r1.cancelled, second: r2.cancelled, secondSentences: r2.parse && r2.parse.sentences.length };
        done(out);
      })().catch((e) => done({ fatal: String(e && e.message || e) }));`);
    deepData = deep;
    console.log('deep ->', JSON.stringify(deep));
    fs.writeFileSync(`${ROOT}/deep.json`, JSON.stringify(deep, null, 2));
    ok(!deep.fatal, 'прямые вызовы style:parse без исключений', deep.fatal);
    ok(deep.badOffsets === 0 && deep.tokens > 20, 'offsets Rust = UTF-16 в реальном WebKit (emoji, кириллица): text.slice(start,end) === token.text', [deep.tokens, deep.badOffsets]);
    ok(deep.schema === 1 && deep.parser && deep.parser.modelVersion === (scenario === 'gsdmodel' ? 'russian-gsd-ud-2.5-191206' : 'toy-synthetic') && (scenario !== 'gsdmodel' || deep.parser.modelSha256 === 'ba63e42f79f525cbcb78c8bc98dd126c2960cbada91b964a741285c15504f06a'), 'parser/modelVersion (и SHA-256 для GSD) в ответе', deep.parser);
    ok(deep.cancel && deep.cancel.cancelled === true && deep.cancel.ack === true, 'style:cancel останавливает длинный разбор через IPC', deep.cancel);
    ok(deep.afterCancel && deep.afterCancel.cancelled === false && deep.afterCancel.sentences === 1, 'после отмены следующий разбор работает', deep.afterCancel);
    ok(deep.replace && deep.replace.first === true && deep.replace.second === false, 'новый запрос вытесняет предыдущий (cancelled у первого)', deep.replace);
  }

  if (withModel) {
    // 6. Вытеснение запросов тени в настоящем приложении (F.3.1-B2). Реальный IPC; подменяется только момент доставки ответа первого запроса.
    const STYLE_CATS = ['chancery', 'weak', 'tell', 'chain', 'remark', 'redund', 'which', 'own'];
    const total = (m) => Object.values(m).reduce((a, b) => a + b, 0);
    const counters = () => sync(`const o = {}; for (const c of ${JSON.stringify(STYLE_CATS)}) { const el = document.getElementById('anCount_' + c); const nav = document.querySelector('[data-an-nav="' + c + '"][data-dir="1"]'); o[c] = { n: el ? parseInt(el.textContent, 10) || 0 : null, navDisabled: nav ? nav.disabled : null }; } return o;`);
    const shadowNow = () => sync(`const s = window.__styleShadow || null; return s && { task: s.task, epoch: s.epoch, at: s.at, status: s.status, ok: s.ok, accepted: s.acceptedRanges, findings: s.findingsCount, cancelled: s.cancelled };`);
    const refocus = async () => { await wd('POST', `/session/${sid}/element/${pmId}/click`, {}); await key(''); };
    await sync(`window.kabinetStyleShadow.enable(); return true;`);
    await refocus();
    await shadowFinal();

    // A. Ответ старого запроса приходит ПОСЛЕ завершения нового: он не должен перезаписать ни состояние, ни подсветку.
    await sync(`const orig = window.kabinet.styleParse; window.__origParse = orig; window.__spLog = []; let n = 0;
      window.kabinet.styleParse = function (text, id) { const k = ++n; window.__spLog.push({ k, id }); const p = orig.call(window.kabinet, text, id);
        return k === 1 ? p.then((r) => new Promise((res) => setTimeout(() => { window.__spLog.push({ k, late: true }); res(r); }, 4000))) : p; }; return true;`);
    await key(' ');
    ok(await wait('() => window.__spLog.some((e) => e.k === 1 && !e.late)', 8000), 'A: первый запрос тени ушёл в IPC (ответ придержан 4 с)');
    await key('а'); await sleep(200);
    const stA = await shadowFinal();
    const log2 = await sync(`return window.__spLog`);
    ok(log2.some((e) => e.k === 2), 'A: второй запрос ушёл, пока ответ первого ещё не доставлен', log2);
    const nowA = await shadowNow(); const marksA = await marks(); const cntA = await counters();
    ok(nowA && nowA.status === 'ok' && nowA.ok === true && nowA.task === stA.task, 'A: итоговое состояние — успех второго запроса', nowA);
    ok(await wait('() => window.__spLog.some((e) => e.k === 1 && e.late)', 8000), 'A: поздний ответ первого запроса доставлен в приложение');
    await sleep(600);
    const nowA2 = await shadowNow(); const marksA2 = await marks(); const cntA2 = await counters();
    ok(nowA2 && nowA2.task === nowA.task && nowA2.at === nowA.at && nowA2.status === 'ok', 'A: поздний ответ не перезаписал состояние тени (task/at не изменились)', [nowA, nowA2]);
    ok(JSON.stringify(marksA2) === JSON.stringify(marksA) && total(marksA2) === nowA2.accepted, 'A: подсветка в редакторе не изменилась и равна числу принятых ranges (старых Decorations нет)', [marksA, marksA2, nowA2.accepted]);
    ok(JSON.stringify(cntA2) === JSON.stringify(cntA), 'A: счётчики не изменились после позднего ответа', [cntA, cntA2]);
    const sumCnt = Object.values(cntA2).reduce((a, c) => a + (c.n || 0), 0);
    ok(sumCnt === nowA2.accepted && Object.values(cntA2).every((c) => c.navDisabled === !(c.n > 0)), 'A: счётчики и доступность «‹ ›» соответствуют последнему запросу', [cntA2, nowA2.accepted]);
    const navCat = STYLE_CATS.find((c) => cntA2[c].n > 0);
    if (navCat) {
      await sync(`const b = document.getElementById('btnStyle'); if (b && document.getElementById('stylePanel').hidden) b.click(); return true;`);
      await sleep(300);
      const sel0 = await sync(`return editor ? editor.state.selection.from : -1`).catch(() => -1);
      await sync(`document.querySelector('[data-an-nav="${navCat}"][data-dir="1"]').click(); return true;`);
      await sleep(400);
      const sb = await sync(`return document.body.innerText`);
      const sel1 = await sync(`return editor ? editor.state.selection.from : -1`).catch(() => -1);
      ok(new RegExp(`\\d+ из ${cntA2[navCat].n}\\b`).test(sb), `A: навигация «›» (${navCat}) показывает «k из ${cntA2[navCat].n}» по последнему запросу`, [sel0, sel1]);
    }

    // C. Устаревший ответ не возвращает подсветку, снятую при отключении категорий (старые Decorations не воскресают).
    await sync(`window.__spLog.length = 0; window.kabinet.styleParse = window.__origParse; const orig = window.__origParse; let n = 0;
      window.kabinet.styleParse = function (text, id) { const k = ++n; window.__spLog.push({ k, id }); const p = orig.call(window.kabinet, text, id);
        return k === 1 ? p.then((r) => new Promise((res) => setTimeout(() => { window.__spLog.push({ k, late: true }); res(r); }, 3500))) : p; }; return true;`);
    await refocus(); await key('б');
    ok(await wait('() => window.__spLog.some((e) => e.k === 1 && !e.late)', 8000), 'C: запрос тени в полёте (ответ придержан)');
    await sync(`for (const c of ['chancery','weak','tell','chain','remark','redund','which','own']) { const b = document.getElementById('an_' + c); if (b && b.checked) b.click(); } return true;`);
    await sleep(600);
    const marksC1 = await marks(); const nowC1 = await shadowNow();
    ok(total(marksC1) === 0 && nowC1 && nowC1.status === 'unavailable', 'C: после отключения категорий подсветка снята, состояние unavailable', [marksC1, nowC1]);
    ok(await wait('() => window.__spLog.some((e) => e.k === 1 && e.late)', 8000), 'C: поздний ответ доставлен в приложение');
    await sleep(600);
    const marksC2 = await marks(); const nowC2 = await shadowNow();
    ok(total(marksC2) === 0 && nowC2 && nowC2.status === 'unavailable' && nowC2.task === nowC1.task, 'C: поздний ответ не вернул подсветку и не изменил состояние', [marksC2, nowC2]);
    await sync(`window.kabinet.styleParse = window.__origParse; for (const c of ['chancery','weak','tell','chain','remark','redund','which','own']) { const b = document.getElementById('an_' + c); if (b && !b.checked) b.click(); } return true;`);
    await refocus(); await key('в');
    const stC = await shadowFinal();
    ok(stC && stC.status === 'ok' && stC.ok === true, 'C: после отмены и возврата категорий следующий запрос тени успешен (отмена ничего не блокирует)', stC && [stC.status, stC.error]);
    ok(total(await marks()) === stC.acceptedRanges, 'C: подсветка равна ranges последнего запроса', [await marks(), stC.acceptedRanges]);

    // B. Настоящее вытеснение в Rust: долгий разбор занят, приходит запрос тени — долгий прерывается, тень завершается успехом.
    await sync(`window.kabinet.styleParse = window.__origParse; return true;`);
    await async_(`const done = arguments[arguments.length - 1]; window.__longB = window.kabinet.styleParse('Он пришёл домой.\\n\\n'.repeat(${Math.max((deepData && deepData.longParas) || 1500, 3000)}), 9001).then((r) => ({ cancelled: r.cancelled, ms: r.ms }), (e) => ({ err: String(e && e.message || e) })); done(true);`);
    await sleep(100);
    await refocus(); await key('г');
    const stB = await shadowFinal();
    const longB = await async_(`const done = arguments[arguments.length - 1]; window.__longB.then(done);`);
    ok(longB && longB.cancelled === true, 'B: долгий разбор вытеснен запросом тени (cancelled=true) в реальном Rust', longB);
    ok(stB && stB.status === 'ok' && stB.ok === true && total(await marks()) === stB.acceptedRanges, 'B: запрос тени, вытеснивший долгий, завершён успехом; подсветка = ranges', stB && [stB.status, stB.error, stB.acceptedRanges]);
    const after = await async_(`const done = arguments[arguments.length - 1]; window.kabinet.styleParse('Он пришёл.', 9002).then((r) => done({ cancelled: r.cancelled, sentences: r.parse.sentences.length }), (e) => done({ err: String(e) }));`);
    ok(after && after.cancelled === false && after.sentences === 1, 'B: после вытеснения следующий прямой разбор работает', after);
    await sync(`window.kabinetStyleShadow.disable(); return true;`);
  }

  if (scenario === 'edge') {
    const cases = {
      zwsp: 'Он пришёл\u200Bдомой.', softHyphen: 'Он при\u00ADшёл домой.', bom: '\uFEFFОн пришёл домой.', nbsp: 'Он\u00A0пришёл домой.', nnbsp: 'Он\u202Fпришёл домой.',
      tab: 'Он\tпришёл домой.', ls: 'Он пришёл.\u2028Потом ушёл.', cr: 'Он пришёл.\r\nПотом ушёл.', combining: 'Он пришёл\u0301 домой.', thinsp: 'В 1\u2009000 домах.',
      numNbsp: 'Это стоит 2\u00A0000 рублей.', emDash: 'Он — пришёл.', quotes: 'Он сказал: «Привет!» и „ушёл“.', ellipsis: 'Он ушёл…', zwj: 'Он\u200Dпришёл.', lrm: 'Он\u200Eпришёл.',
      controlChar: 'Он\u0001пришёл.', fff: 'Он пришёл\uFFFD.', onlyWs: '   \n\n  ', hardBreak: 'Он пришёл.\nПотом ушёл.', tripleNl: 'Он пришёл.\n\n\n\nПотом ушёл.', latinCyr: 'Он пришёл to the дом.', digits: 'В 1999 г. он жил в д. 5.', url: 'Сайт https://example.com/a?b=1 открыт.', emoji: 'Он 👨‍👩‍👧 пришёл.', long1: ('слово '.repeat(5000)) + '.'
    };
    const res = await async_(`const done = arguments[arguments.length - 1]; const cases = ${JSON.stringify(cases)}; const out = {}; let id = 1000;
      (async () => { for (const [k, text] of Object.entries(cases)) { try { const r = await window.kabinet.styleParse(text, ++id); let bad = 0, n = 0; if (r.cancelled) { out[k] = { ok: false, cancelled: true }; continue; } if (r.parse) for (const sn of r.parse.sentences) for (const t of sn.tokens) { n += 1; if (text.slice(t.start, t.end) !== t.text) bad += 1; } out[k] = { ok: !r.cancelled, cancelled: !!r.cancelled, tokens: n, bad }; } catch (e) { out[k] = { err: String(e && e.message || e).slice(0, 160) }; } } done(out); })();`);
    fs.writeFileSync(`${ROOT}/edge.json`, JSON.stringify(res, null, 2));
    for (const [k, v] of Object.entries(res)) ok(v.ok && v.bad === 0, `edge ${k}`, v);
  }
  await wd('DELETE', `/session/${sid}`);
  const bad = results.filter((r) => !r[0]);
  console.log(`\n${scenario}: ${results.length - bad.length}/${results.length} ok`);
  process.exitCode = bad.length ? 1 : 0;
})().catch((e) => { console.error('E2E error:', e.stack || e); process.exitCode = 2; }).finally(() => { for (const p of procs.reverse()) { try { p.kill('SIGTERM'); } catch {} } setTimeout(() => process.exit(process.exitCode || 0), 500); });
