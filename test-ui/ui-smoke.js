'use strict';
// Автопроверка интерфейса в настоящем Chromium: окно открывается с подставным мостом (window.kabinet), без Tauri.
// Ловит поломки самого окна: исключения при запуске, меню правой кнопки, диалоги.
//   npm run build && node test-ui/ui-smoke.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..', 'experiments', 'tauri-app', 'dist'); // тот же интерфейс и мост, что в установщике
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+$/, 'index.html'));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { console.log('404 для', p, '| папка окна:', root, fs.existsSync(root) ? fs.readdirSync(root).slice(0, 8).join(',') : 'нет'); res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

// Подставной Tauri: настоящий мост (bridge.js) зовёт invoke('call', {channel, args}); отвечаем заготовками.
function fakeTauri() {
  const project = { name: 'Проба', mode: 'novel', chapters: [{ id: 'aaaaaa', title: 'Глава 1', words: 8 }], characters: [], places: [], items: [], notes: [], trash: [], analysisSkip: {}, goalUnit: 'words' };
  const calls = [];
  window.__calls = calls;
  const handlers = {
    'recents:list': () => [],
    'project:openDialog': () => project,
    'chapter:read': () => 'Он шёл по тёмной улице. Слизеринцы получили письма. Он был зол. Отряд осуществлял разведку.',
    'chapter:readMeta': () => ({}),
    'check:getDictionary': () => ['слизеринцы'],
    'sounds:list': () => ({}),
    'fonts:list': () => [],
    'project:stats': () => ({ chapters: [{ id: 'aaaaaa', words: 8, chars: 50 }], words: 8, chars: 50 }),
    'cards:index': () => [],
    'project:rename': (name) => { project.name = name; return project; },
    'spell:check': (w) => (w === 'Слизеринцы' || w === 'слизеринцы' ? { available: true, ok: false, suggestions: ['слизеринцев', 'слизерины'] } : { available: true, ok: true, suggestions: [] }),
    'style:parse': async (text, id) => {
      await new Promise((resolve) => setTimeout(resolve, Number(window.__styleDelay) || 0));
      if (window.__styleFail) throw new Error('fake style:parse failure');
      if (window.__styleBadResponse) return {};
      return { taskId: id, cancelled: false, ms: 1, parse: { schemaVersion: 1, parser: { name: 'fake', version: '1' }, sentences: [{ start: 0, end: 1, text: 'x', tokens: [] }] } };
    },
    'style:cancel': async () => { if (window.__styleCancelFail) throw new Error('fake style:cancel failure'); return true; },
  };
  window.__TAURI__ = {
    core: { invoke: async (cmd, { channel, args } = {}) => { calls.push([channel, args]); const h = handlers[channel]; return h ? h(...(args || [])) : null; } },
    event: { listen: async () => () => {} },
  };
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/index.html`;
  const browser = await chromium.launch(process.env.KABINET_CHROME ? { executablePath: process.env.KABINET_CHROME } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message + (process.env.STACK ? '\n' + e.stack : '')));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 404/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('response', (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push(`${r.status()} ${r.url()}`); });
  await page.addInitScript(fakeTauri);
  await page.addInitScript(() => { try { localStorage.setItem('kabinet.styleEngineShadow', '1'); } catch { /* нет хранилища */ } });
  await page.goto(base);
  await page.evaluate(() => { document.documentElement.setAttribute('spellcheck', 'true'); });
  await page.waitForSelector('#btnOpen', { state: 'visible', timeout: 20000 }).catch(() => {});
  const checks = [];
  const ok = (cond, label) => { checks.push([cond, label]); };

  ok(await page.locator('#btnNewNovel').count() === 1, 'стартовая страница: кнопка «Роман»');
  ok(errors.length === 0, 'запуск без исключений: ' + errors.join(' | '));

  // открыть проект и проверить редактор
  if (!(await page.locator('#btnOpen').isVisible())) {
    console.log('FAIL кнопка «Открыть» не видна. Исключения: ' + (errors.join(' | ') || 'нет'));
    console.log('Видимый текст: ' + (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 300));
    await browser.close(); server.close(); process.exit(1);
  }
  await page.click('#btnOpen');
  await page.waitForSelector('.ProseMirror', { timeout: 5000 }).catch(() => {});
  ok(await page.locator('.ProseMirror').count() >= 1, 'проект открывается, редактор есть');
  ok((await page.locator('#projectName').textContent()) === 'Проба', 'название проекта в шапке');

  await page.getByText('Глава 1').first().click();
  await page.waitForTimeout(600);

  // правый клик по слову: меню Кабинета (русское), а не системное
  const box = await page.locator('.ProseMirror').first().boundingBox();
  if (box) {
    await page.mouse.click(box.x + 30, box.y + 12, { button: 'right' });
    await page.waitForTimeout(400);
    const menuText = await page.locator('.ctx-menu, #ctxMenu, .menu').first().innerText().catch(() => '');
    ok(/Копировать|Вставить/.test(menuText), 'правый клик: меню Кабинета на русском. Получено: ' + menuText.slice(0, 80).replace(/\n/g, ' / '));
    await page.keyboard.press('Escape');
  }

  // правый клик по слову с ошибкой: варианты от системы, «Добавить в словарь», «Пропустить»
  const hit = await page.evaluate(() => {
    const w = document.createTreeWalker(document.querySelector('.ProseMirror'), NodeFilter.SHOW_TEXT);
    let tn;
    while ((tn = w.nextNode())) if (tn.textContent.includes('Слизеринцы')) break;
    const i = tn.textContent.indexOf('Слизеринцы');
    const r = document.createRange(); r.setStart(tn, i); r.setEnd(tn, i + 10);
    const b = r.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  await page.mouse.click(hit.x, hit.y, { button: 'right' });
  await page.waitForTimeout(700);
  const spellMenu = await page.locator('.ctx-menu, #ctxMenu, .menu').first().innerText().catch(() => '');
  ok(/слизеринцев/.test(spellMenu) && /Добавить «Слизеринцы» в словарь/.test(spellMenu) && /Пропустить/.test(spellMenu), 'слово с ошибкой: варианты, «Добавить в словарь», «Пропустить». Получено: ' + spellMenu.slice(0, 160).replace(/\n/g, ' / '));
  await page.keyboard.press('Escape');

  // теневой режим: новый парсер вызывается, но не создаёт подсветку и не трогает старый анализ
  await page.locator('.ProseMirror').first().click();
  await page.keyboard.type(' ');
  await page.waitForTimeout(1500);
  const shadow = await page.evaluate(() => window.__styleShadow || null);
  ok(!!shadow && shadow.ok === true, 'тень: парсер ответил без ошибки');
  ok(!!shadow && shadow.sentences === 1, 'тень: результат разобран в контракт');
  const shadowMarks = await page.evaluate(() => document.querySelectorAll('.ProseMirror [class*="an-"]').length);
  ok(shadowMarks === 0, 'тень: подсветка не создаётся (старый анализатор не затронут)');

  // Новый запрос сразу убирает старый успешный результат из диагностики.
  await page.evaluate(() => { window.__styleDelay = 1800; });
  await page.keyboard.type(' ');
  await page.waitForTimeout(1050);
  const runningShadow = await page.evaluate(() => window.__styleShadow || null);
  ok(!!runningShadow && runningShadow.status === 'running' && runningShadow.sentences === 0, 'тень: старый результат не выдаётся за новый');
  await page.waitForTimeout(2000);
  const latestShadow = await page.evaluate(() => window.__styleShadow || null);
  ok(!!latestShadow && latestShadow.status === 'ok' && latestShadow.task > shadow.task, 'тень: новый запрос завершился, taskId обновился');

  // Ошибка моста должна дать однозначное состояние ошибки, а затем восстановиться.
  await page.evaluate(() => { window.__styleDelay = 0; window.__styleFail = true; });
  await page.keyboard.type(' ');
  await page.waitForTimeout(1400);
  const failedShadow = await page.evaluate(() => window.__styleShadow || null);
  ok(!!failedShadow && failedShadow.status === 'error' && failedShadow.ok === false && /fake style:parse failure/.test(failedShadow.error || ''), 'тень: ошибка моста видна как error, без старого результата');
  const failedMarks = await page.evaluate(() => document.querySelectorAll('.ProseMirror [class*="an-"]').length);
  ok(failedMarks === 0, 'тень: ошибка моста не создаёт подсветку');
  await page.evaluate(() => { window.__styleFail = false; });
  await page.keyboard.type(' ');
  await page.waitForTimeout(1400);
  const recoveredShadow = await page.evaluate(() => window.__styleShadow || null);
  ok(!!recoveredShadow && recoveredShadow.status === 'ok' && recoveredShadow.task > failedShadow.task, 'тень: после ошибки следующий запрос восстанавливается');
  // Ошибка отмены не должна мешать новому разбору.
  await page.evaluate(() => { window.__styleCancelFail = true; });
  await page.keyboard.type(' ');
  await page.waitForTimeout(1400);
  const cancelFailShadow = await page.evaluate(() => window.__styleShadow || null);
  ok(!!cancelFailShadow && cancelFailShadow.status === 'ok', 'тень: ошибка style:cancel не блокирует новый разбор');
  await page.evaluate(() => { window.__styleCancelFail = false; });

  // Недоступная Rust-команда: явная ошибка, старая подсветка не трогается.
  await page.evaluate(() => { window.__savedStyleParse = window.kabinet.styleParse; window.kabinet.styleParse = undefined; });
  await page.keyboard.type(' ');
  await page.waitForTimeout(1400);
  const unavailableShadow = await page.evaluate(() => window.__styleShadow || null);
  ok(!!unavailableShadow && unavailableShadow.status === 'error' && /недоступна/.test(unavailableShadow.error || ''), 'тень: недоступная команда даёт явную ошибку');
  await page.evaluate(() => { window.kabinet.styleParse = window.__savedStyleParse; });

  // Некорректный ответ моста: ошибка, а не пустой успешный результат.
  await page.evaluate(() => { window.__styleBadResponse = true; });
  await page.keyboard.type(' ');
  await page.waitForTimeout(1400);
  const badResponseShadow = await page.evaluate(() => window.__styleShadow || null);
  ok(!!badResponseShadow && badResponseShadow.status === 'error' && /Некорректный ответ/.test(badResponseShadow.error || ''), 'тень: некорректный ответ не считается успехом');
  await page.evaluate(() => { window.__styleBadResponse = false; });


  // стиль текста: галочка в отдельной панели включает подсветку и сохраняется
  await page.locator('#btnStyle').click({ force: true });
  await page.waitForSelector('#stylePanel', { state: 'visible', timeout: 3000 }).catch(() => {});
  const styleBox = page.locator('#an_chancery');
  ok(await styleBox.isVisible(), 'стиль: галочка «Канцелярит и штампы» видна');
  if (await styleBox.isVisible()) {
    await styleBox.check();
    await page.waitForTimeout(400);
    const styleState = await page.evaluate(() => ({
      saved: (() => { try { return JSON.parse(localStorage.getItem('kabinet.settings') || '{}').an || {}; } catch { return {}; } })(),
      marks: document.querySelectorAll('.ProseMirror .an-chancery').length,
      count: document.querySelector('#anCount_chancery')?.textContent || '',
    }));
    ok(styleState.saved.chancery === true, 'стиль: включение сохраняется в настройках');
    ok(styleState.marks > 0, 'стиль: подсветка появилась в редакторе');
    ok(styleState.count !== '' && styleState.count !== '0', 'стиль: счётчик категории обновился');
  }

  // переименование проекта: диалог и вызов моста
  await page.locator('#projectName').click({ button: 'right' });
  await page.waitForTimeout(200);
  await page.getByText('Переименовать проект…').first().click().catch(() => {});
  await page.waitForTimeout(200);
  const dlgOpen = await page.evaluate(() => !!document.querySelector('#renameProjectDialog[open]'));
  ok(dlgOpen, 'переименование: диалог открылся');
  if (dlgOpen) {
    await page.fill('#renameProjectInput', 'Новое имя');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    ok((await page.locator('#projectName').textContent()) === 'Новое имя', 'переименование: новое название в шапке');
    ok(await page.evaluate(() => window.__calls.some(([n, a]) => n === 'project:rename' && a[0] === 'Новое имя')), 'переименование: вызван project:rename');
  }
  ok(errors.length === 0, 'после работы нет исключений: ' + errors.join(' | '));

  console.log(checks.map(([c, l]) => `${c ? 'ok  ' : 'FAIL'} ${l}`).join('\n'));
  await browser.close();
  server.close();
  process.exit(checks.every(([c]) => c) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
