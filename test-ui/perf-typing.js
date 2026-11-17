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
    'chapter:read': () => window.__text,
    'chapter:readMeta': () => ({}),
    'check:getDictionary': () => ['слизеринцы'],
    'sounds:list': () => ({}),
    'fonts:list': () => [],
    'project:stats': () => ({ chapters: [{ id: 'aaaaaa', words: 8, chars: 50 }], words: 8, chars: 50 }),
    'cards:index': () => (window.__names || []).map((n, i) => ({ kind: 'character', id: 'c' + i, name: n, names: [n], aliases: [], brief: '', image: '' })),
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
  const rate = Number(process.env.THROTTLE || 1);
  const chars = Number(process.env.CHARS || 50000);
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const names = ['Гарри', 'Гермиона', 'Рон', 'Драко', 'Снейп', 'Дамблдор', 'Хагрид', 'Невилл', 'Луна', 'Джинни', 'Фред', 'Джордж', 'Дафна', 'Астория', 'Паркинсон', 'Слизнорт'];
  const words = 'Он медленно шёл по тёмной улице и думал о том, что произошло вчера вечером, когда она сказала ему всё почти шёпотом. Холодный ветер нёс запах дыма, а вдали кто-то смеялся.'.split(' ');
  let text = '';
  let w = 0;
  while (text.length < chars) { let p = ''; for (let i = 0; i < 40 + (w % 17); i++) { p += (i % 23 === 5 ? names[(w + i) % names.length] : words[(w * 7 + i) % words.length]) + ' '; w++; } text += p.trim() + '\n\n'; }
  await page.addInitScript(({ t, ns }) => { window.__text = t; window.__names = ns; }, { t: text, ns: names });
  await page.addInitScript(fakeTauri);
  await page.addInitScript(() => {
    const orig = window.__TAURI__;
    window.__perf = { long: [] };
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.long.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] });
  });
  if (process.env.FEATURES) await page.addInitScript(() => { localStorage.setItem('kabinet.settings', JSON.stringify({ an: { repeat: true, filler: true, long: true, verb: true, adj: true, adv: true, part: true, pron: true, passive: true, tense: true }, marks: true, links: true, spellOn: true })); });
  await page.goto(base);
  await page.evaluate(() => { document.documentElement.setAttribute('spellcheck', 'true'); });
  await page.waitForSelector('#btnOpen', { state: 'visible', timeout: 20000 });
  const client = await page.context().newCDPSession(page);
  await page.click('#btnOpen');
  await page.waitForSelector('.ProseMirror', { timeout: 5000 });
  await page.getByText('Глава 1').first().click();
  const t0 = Date.now();
  await page.waitForFunction(() => document.querySelectorAll('.ProseMirror p').length > 50, null, { timeout: 60000 });
  console.log('глава открыта за', Date.now() - t0, 'мс; абзацев:', await page.locator('.ProseMirror p').count(), '; знаков', text.length);
  if (rate > 1) await client.send('Emulation.setCPUThrottlingRate', { rate });
  await page.locator('.ProseMirror').first().click({ position: { x: 200, y: 300 } });
  const lat = [];
  for (let i = 0; i < 25; i++) {
    const ms = await page.evaluate(() => new Promise((res) => { const s = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => res(performance.now() - s))); }));
    await page.keyboard.type('а');
    lat.push(Math.round(await page.evaluate(() => performance.now()) * 0)); // заглушка
    const after = await page.evaluate(() => new Promise((res) => { const s = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => res(performance.now() - s))); }));
    lat[i] = Math.round(after);
  }
  lat.sort((a, b) => a - b);
  await page.waitForTimeout(1500);
  const info = await page.evaluate(() => ({ long: window.__perf.long.slice(-30), mem: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null, nodes: document.getElementsByTagName('*').length, spans: document.querySelectorAll('.ProseMirror span, .ProseMirror a, .ProseMirror mark').length }));
  console.log(`замедление CPU ×${rate}: после нажатия до отрисовки, мс: медиана ${lat[12]}, максимум ${lat[24]}; долгие задачи: ${info.long.join(',') || 'нет'}; JS-память ${info.mem} МБ; элементов DOM ${info.nodes}, размеченных ${info.spans}`);
  if (errors.length) console.log('исключения:', errors.slice(0, 3).join(' | '));
  await browser.close();
  server.close();
})().catch((e) => { console.error(e); process.exit(2); });
