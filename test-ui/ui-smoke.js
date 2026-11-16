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
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
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
    'chapter:read': () => 'Он шёл по тёмной улице. Слизеринцы получили письма.',
    'chapter:readMeta': () => ({}),
    'check:getDictionary': () => ['слизеринцы'],
    'sounds:list': () => ({}),
    'fonts:list': () => [],
    'project:stats': () => ({ chapters: [{ id: 'aaaaaa', words: 8, chars: 50 }], words: 8, chars: 50 }),
    'cards:index': () => [],
    'project:rename': (name) => { project.name = name; return project; },
    'spell:check': (w) => (w === 'Слизеринцы' || w === 'слизеринцы' ? { available: true, ok: false, suggestions: ['слизеринцев', 'слизерины'] } : { available: true, ok: true, suggestions: [] }),
  };
  window.__TAURI__ = {
    core: { invoke: async (cmd, { channel, args } = {}) => { calls.push([channel, args]); const h = handlers[channel]; return h ? h(...(args || [])) : null; } },
    event: { listen: async () => () => {} },
  };
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/index.html`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message + (process.env.STACK ? '\n' + e.stack : '')));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 404/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('response', (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push(`${r.status()} ${r.url()}`); });
  await page.addInitScript(fakeTauri);
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
