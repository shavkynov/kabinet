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
    'chapter:read': () => 'Он шёл по тёмной улице. Слизеринцы получили письма. Он был зол. Отряд осуществлял разведку. Он знал, что дом стоял, что сад шумел, что лес спал. Он имеет значение. Он поднял свою руку. Он вернулся обратно. «Я не пойду», — сказал он, — сказал он. Он почувствовал страх.',
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
      if (window.__styleChain) {
        const phrase = 'Отряд осуществлял разведку';
        const base = text.indexOf(phrase);
        if (base >= 0) {
          const words = ['Отряд', 'осуществлял', 'разведку'];
          const lemmas = ['проверка', 'осуществление', 'выполнение'];
          let at = base;
          const tokens = words.map((word, i) => {
            const start = text.indexOf(word, at);
            at = start + word.length;
            return { id: i + 1, text: word, lemma: lemmas[i], upos: 'NOUN', feats: { Case: 'Gen' }, head: i === 0 ? 0 : i, deprel: i === 0 ? 'root' : 'nmod', start, end: start + word.length, confidence: null };
          });
          return { taskId: id, cancelled: false, ms: 1, parse: { schemaVersion: 1, parser: { name: 'fake-chain', version: '1' }, sentences: [{ start: base, end: base + phrase.length, text: phrase, tokens }] } };
        }
      }
      if (window.__styleTell) {
        const phrase = 'Он почувствовал страх.';
        const base = text.indexOf(phrase);
        if (base >= 0) {
          const rows = [
            ['Он', 'он', 'PRON', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 2, 'nsubj'],
            ['почувствовал', 'почувствовать', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
            ['страх', 'страх', 'NOUN', { Case: 'Acc', Gender: 'Masc', Number: 'Sing' }, 2, 'obj'],
            ['.', '.', 'PUNCT', {}, 2, 'punct'],
          ];
          let at = base;
          const tokens = rows.map(([word, lemma, upos, feats, head, deprel], i) => {
            const start = text.indexOf(word, at);
            at = start + word.length;
            return { id: i + 1, text: word, lemma, upos, feats, head, deprel, start, end: start + word.length, confidence: null };
          });
          return { taskId: id, cancelled: false, ms: 1, parse: { schemaVersion: 1, parser: { name: 'fake-tell', version: '1' }, sentences: [{ start: base, end: base + phrase.length, text: phrase, tokens }] } };
        }
      }
      if (window.__styleRemark) {
        const phrase = '«Я не пойду», — сказал он, — сказал он.';
        const base = text.indexOf(phrase);
        if (base >= 0) {
          const rows = [
            ['«', '«', 'PUNCT', {}, 4, 'punct'],
            ['Я', 'я', 'PRON', { Case: 'Nom' }, 4, 'nsubj'],
            ['не', 'не', 'PART', {}, 4, 'advmod'],
            ['пойду', 'пойти', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
            ['»', '»', 'PUNCT', {}, 4, 'punct'],
            [',', ',', 'PUNCT', {}, 8, 'punct'],
            ['—', '—', 'PUNCT', {}, 8, 'punct'],
            ['сказал', 'сказать', 'VERB', { VerbForm: 'Fin' }, 4, 'parataxis'],
            ['он', 'он', 'PRON', { Case: 'Nom' }, 8, 'nsubj'],
            [',', ',', 'PUNCT', {}, 12, 'punct'],
            ['—', '—', 'PUNCT', {}, 12, 'punct'],
            ['сказал', 'сказать', 'VERB', { VerbForm: 'Fin' }, 9, 'parataxis'],
            ['он', 'он', 'PRON', { Case: 'Nom' }, 12, 'nsubj'],
            ['.', '.', 'PUNCT', {}, 4, 'punct'],
          ];
          let at = base;
          const tokens = rows.map(([word, lemma, upos, feats, head, deprel], i) => {
            const start = text.indexOf(word, at);
            at = start + word.length;
            return { id: i + 1, text: word, lemma, upos, feats, head, deprel, start, end: start + word.length, confidence: null };
          });
          return { taskId: id, cancelled: false, ms: 1, parse: { schemaVersion: 1, parser: { name: 'fake-remark', version: '1' }, sentences: [{ start: base, end: base + phrase.length, text: phrase, tokens }] } };
        }
      }
      if (window.__styleRedund) {
        const phrase = 'Он вернулся обратно.';
        const base = text.indexOf(phrase);
        if (base >= 0) {
          const rows = [
            ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
            ['вернулся', 'вернуться', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
            ['обратно', 'обратно', 'ADV', {}, 2, 'advmod'],
            ['.', '.', 'PUNCT', {}, 2, 'punct'],
          ];
          let at = base;
          const tokens = rows.map(([word, lemma, upos, feats, head, deprel], i) => {
            const start = text.indexOf(word, at);
            at = start + word.length;
            return { id: i + 1, text: word, lemma, upos, feats, head, deprel, start, end: start + word.length, confidence: null };
          });
          return { taskId: id, cancelled: false, ms: 1, parse: { schemaVersion: 1, parser: { name: 'fake-redund', version: '1' }, sentences: [{ start: base, end: base + phrase.length, text: phrase, tokens }] } };
        }
      }
      if (window.__styleOwn) {
        const phrase = 'Он поднял свою руку.';
        const base = text.indexOf(phrase);
        if (base >= 0) {
          const rows = [
            ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
            ['поднял', 'поднять', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
            ['свою', 'свой', 'DET', { Case: 'Acc', Gender: 'Fem', Number: 'Sing' }, 4, 'det'],
            ['руку', 'рука', 'NOUN', { Case: 'Acc', Gender: 'Fem', Number: 'Sing' }, 2, 'obj'],
            ['.', '.', 'PUNCT', {}, 2, 'punct'],
          ];
          let at = base;
          const tokens = rows.map(([word, lemma, upos, feats, head, deprel], i) => {
            const start = text.indexOf(word, at);
            at = start + word.length;
            return { id: i + 1, text: word, lemma, upos, feats, head, deprel, start, end: start + word.length, confidence: null };
          });
          return { taskId: id, cancelled: false, ms: 1, parse: { schemaVersion: 1, parser: { name: 'fake-own', version: '1' }, sentences: [{ start: base, end: base + phrase.length, text: phrase, tokens }] } };
        }
      }
      if (window.__styleWeak) {
        const phrase = 'Он имеет значение.';
        const base = text.indexOf(phrase);
        if (base >= 0) {
          const rows = [
            ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
            ['имеет', 'иметь', 'VERB', { VerbForm: 'Fin', Voice: 'Act' }, 0, 'root'],
            ['значение', 'значение', 'NOUN', { Case: 'Acc' }, 2, 'obj'],
            ['.', '.', 'PUNCT', {}, 2, 'punct'],
          ];
          let at = base;
          const tokens = rows.map(([word, lemma, upos, feats, head, deprel], i) => {
            const start = text.indexOf(word, at);
            at = start + word.length;
            return { id: i + 1, text: word, lemma, upos, feats, head, deprel, start, end: start + word.length, confidence: null };
          });
          return { taskId: id, cancelled: false, ms: 1, parse: { schemaVersion: 1, parser: { name: 'fake-weak', version: '1' }, sentences: [{ start: base, end: base + phrase.length, text: phrase, tokens }] } };
        }
      }
      if (window.__styleChancery) {
        const phrase = 'Отряд осуществлял разведку';
        const base = text.indexOf(phrase);
        if (base >= 0) {
          const rows = [
            ['Отряд', 'отряд', 'NOUN', { Case: 'Nom' }, 2, 'nsubj'],
            ['осуществлял', 'осуществлять', 'VERB', { VerbForm: 'Fin', Voice: 'Act' }, 0, 'root'],
            ['разведку', 'разведка', 'NOUN', { Case: 'Acc' }, 2, 'obj'],
          ];
          let at = base;
          const tokens = rows.map(([word, lemma, upos, feats, head, deprel], i) => {
            const start = text.indexOf(word, at);
            at = start + word.length;
            return { id: i + 1, text: word, lemma, upos, feats, head, deprel, start, end: start + word.length, confidence: null };
          });
          return { taskId: id, cancelled: false, ms: 1, parse: { schemaVersion: 1, parser: { name: 'fake-chancery', version: '1' }, sentences: [{ start: base, end: base + phrase.length, text: phrase, tokens }] } };
        }
      }
      if (window.__styleWhich) {
        const phrase = 'Он знал, что дом стоял, что сад шумел, что лес спал.';
        const base = text.indexOf(phrase);
        if (base >= 0) {
          const rows = [
            ['Он', 'он', 'PRON', {}, 2, 'nsubj'], ['знал', 'знать', 'VERB', {}, 0, 'root'],
            [',', ',', 'PUNCT', {}, 2, 'punct'], ['что', 'что', 'SCONJ', {}, 6, 'mark'],
            ['дом', 'дом', 'NOUN', {}, 6, 'nsubj'], ['стоял', 'стоять', 'VERB', {}, 2, 'ccomp'],
            [',', ',', 'PUNCT', {}, 2, 'punct'], ['что', 'что', 'SCONJ', {}, 10, 'mark'],
            ['сад', 'сад', 'NOUN', {}, 10, 'nsubj'], ['шумел', 'шуметь', 'VERB', {}, 2, 'ccomp'],
            [',', ',', 'PUNCT', {}, 2, 'punct'], ['что', 'что', 'SCONJ', {}, 14, 'mark'],
            ['лес', 'лес', 'NOUN', {}, 14, 'nsubj'], ['спал', 'спать', 'VERB', {}, 2, 'ccomp'],
            ['.', '.', 'PUNCT', {}, 2, 'punct'],
          ];
          let at = base;
          const tokens = rows.map(([word, lemma, upos, feats, head, deprel], i) => {
            const start = text.indexOf(word, at);
            at = start + word.length;
            return { id: i + 1, text: word, lemma, upos, feats, head, deprel, start, end: start + word.length, confidence: null };
          });
          return { taskId: id, cancelled: false, ms: 1, parse: { schemaVersion: 1, parser: { name: 'fake-which', version: '1' }, sentences: [{ start: base, end: base + phrase.length, text: phrase, tokens }] } };
        }
      }
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

  // теневой режим: новый парсер вызывается только при включённой категории
  await page.evaluate(() => {
    for (const cat of ['chancery', 'weak', 'tell', 'chain', 'remark', 'redund', 'which', 'own']) {
      const box = document.getElementById(`an_${cat}`);
      if (box && !box.checked) box.click();
    }
  });
  await page.waitForTimeout(400);
  await page.locator('.ProseMirror').first().click();
  await page.keyboard.type(' ');
  await page.waitForTimeout(1500);
  const shadow = await page.evaluate(() => window.__styleShadow || null);
  ok(!!shadow && shadow.ok === true, 'тень: парсер ответил без ошибки');
  ok(!!shadow && shadow.sentences === 1, 'тень: результат разобран в контракт');
  ok(!!shadow && Array.isArray(shadow.chain) && shadow.chainCount === 0 && Array.isArray(shadow.ruleErrors), 'тень: chain diagnostics доступны без ошибок правила');
  await page.evaluate(() => { window.__styleChain = true; });
  await page.keyboard.type(' ');
  await page.waitForTimeout(1400);
  const chainShadow = await page.evaluate(() => window.__styleShadow || null);
  ok(!!chainShadow && chainShadow.chainCount === 1 && chainShadow.chain[0].fragment === 'Отряд осуществлял разведку', 'тень: chain finding доступен в diagnostics');
  ok(!!chainShadow && chainShadow.ruleErrors.length === 0, 'тень: chain не дал rule error');
  await page.evaluate(() => { window.__styleChain = false; });
  await page.evaluate(() => { window.__styleWhich = true; });
  await page.keyboard.type(' ');
  await page.waitForTimeout(1400);
  const whichShadow = await page.evaluate(() => window.__styleShadow || null);
  ok(!!whichShadow && whichShadow.whichCount === 1 && whichShadow.which[0].fragment === 'что дом стоял, что сад шумел, что лес спал', 'тень: which finding доступен в diagnostics');
  ok(!!whichShadow && whichShadow.ruleErrors.length === 0, 'тень: which не дал rule error');
  await page.evaluate(() => { window.__styleWhich = false; });
  await page.evaluate(() => { window.__styleChancery = true; });
  await page.keyboard.type(' ');
  await page.waitForTimeout(1400);
  const chanceryShadow = await page.evaluate(() => window.__styleShadow || null);
  ok(!!chanceryShadow && chanceryShadow.chanceryCount === 1 && chanceryShadow.chancery[0].fragment === 'осуществлял разведку', 'тень: chancery finding доступен в diagnostics');
  ok(!!chanceryShadow && chanceryShadow.ruleErrors.length === 0, 'тень: chancery не дал rule error');
  await page.evaluate(() => { window.__styleChancery = false; });
  await page.evaluate(() => { window.__styleWeak = true; });
  await page.keyboard.type(' ');
  await page.waitForTimeout(1400);
  const weakShadow = await page.evaluate(() => window.__styleShadow || null);
  ok(!!weakShadow && weakShadow.weakCount === 1 && weakShadow.weak[0].fragment === 'имеет значение', 'тень: weak finding доступен в diagnostics');
  ok(!!weakShadow && weakShadow.ruleErrors.length === 0, 'тень: weak не дал rule error');
  await page.evaluate(() => { window.__styleWeak = false; });
  await page.evaluate(() => { window.__styleOwn = true; });
  await page.keyboard.type(' ');
  await page.waitForTimeout(1400);
  const ownShadow = await page.evaluate(() => window.__styleShadow || null);
  ok(!!ownShadow && ownShadow.ownCount === 1 && ownShadow.own[0].fragment === 'свою руку', 'тень: own finding доступен в diagnostics');
  ok(!!ownShadow && ownShadow.ruleErrors.length === 0, 'тень: own не дал rule error');
  await page.evaluate(() => { window.__styleOwn = false; });
  await page.evaluate(() => { window.__styleRedund = true; });
  await page.keyboard.type(' ');
  await page.waitForTimeout(1400);
  const redundShadow = await page.evaluate(() => window.__styleShadow || null);
  ok(!!redundShadow && redundShadow.redundCount === 1 && redundShadow.redund[0].fragment === 'вернулся обратно', 'тень: redund finding доступен в diagnostics');
  ok(!!redundShadow && redundShadow.ruleErrors.length === 0, 'тень: redund не дал rule error');
  await page.evaluate(() => { window.__styleRedund = false; });
  await page.evaluate(() => { window.__styleRemark = true; });
  await page.keyboard.type(' ');
  await page.waitForTimeout(1400);
  const remarkShadow = await page.evaluate(() => window.__styleShadow || null);
  ok(!!remarkShadow && remarkShadow.remarkCount === 1 && remarkShadow.remark[0].fragment === 'сказал он, — сказал он', 'тень: remark finding доступен в diagnostics');
  ok(!!remarkShadow && remarkShadow.ruleErrors.length === 0, 'тень: remark не дал rule error');
  await page.evaluate(() => { window.__styleRemark = false; });
  await page.evaluate(() => { window.__styleTell = true; });
  await page.keyboard.type(' ');
  await page.waitForTimeout(1400);
  const tellShadow = await page.evaluate(() => window.__styleShadow || null);
  ok(!!tellShadow && tellShadow.tellCount === 1 && tellShadow.tell[0].fragment === 'почувствовал страх', 'тень: tell finding доступен в diagnostics');
  ok(!!tellShadow && tellShadow.ruleErrors.length === 0, 'тень: tell не дал rule error');
  await page.evaluate(() => { window.__styleTell = false; });
  const callsBeforeNoCategories = await page.evaluate(() => window.__calls.filter(([n]) => n === 'style:parse').length);
  await page.evaluate(() => {
    for (const cat of ['chancery', 'weak', 'tell', 'chain', 'remark', 'redund', 'which', 'own']) {
      const box = document.getElementById(`an_${cat}`);
      if (box && box.checked) box.click();
    }
  });
  await page.keyboard.type(' ');
  await page.waitForTimeout(1200);
  const noCategoriesShadow = await page.evaluate(() => window.__styleShadow || null);
  const callsAfterNoCategories = await page.evaluate(() => window.__calls.filter(([n]) => n === 'style:parse').length);
  ok(!!noCategoriesShadow && noCategoriesShadow.status === 'unavailable' && noCategoriesShadow.reason === 'no-categories', 'тень: без категорий status unavailable');
  ok(callsAfterNoCategories === callsBeforeNoCategories, 'тень: без категорий style:parse не вызывается');
  await page.waitForTimeout(300);
  const shadowMarks = await page.evaluate(() => document.querySelectorAll('.ProseMirror [class*="an-"]').length);
  ok(shadowMarks === 0, 'тень: подсветка не создаётся (старый анализатор не затронут)');
  await page.evaluate(() => {
    const box = document.getElementById('an_chain');
    if (box && !box.checked) box.click();
  });
  await page.waitForTimeout(300);

  // Новый запрос сразу убирает старый успешный результат из диагностики.
  await page.evaluate(() => { window.__styleDelay = 1800; });
  await page.keyboard.type(' ');
  await page.waitForTimeout(1050);
  const runningShadow = await page.evaluate(() => window.__styleShadow || null);
  ok(!!runningShadow && runningShadow.status === 'running' && runningShadow.sentences === 0, 'тень: старый результат не выдаётся за новый');
  await page.waitForTimeout(2000);
  const latestShadow = await page.evaluate(() => window.__styleShadow || null);
  ok(!!latestShadow && latestShadow.status === 'ok' && latestShadow.task > shadow.task, 'тень: новый запрос завершился, taskId обновился');

  // Изменение документа во время уже выполняющегося запроса инвалидирует его сразу.
  await page.evaluate(() => { window.__styleDelay = 1200; });
  await page.keyboard.type(' ');
  await page.waitForTimeout(950);
  const inFlightShadow = await page.evaluate(() => window.__styleShadow || null);
  ok(!!inFlightShadow && inFlightShadow.status === 'running', 'тень: запрос действительно выполняется');
  await page.keyboard.type(' ');
  const invalidatedShadow = await page.evaluate(() => window.__styleShadow || null);
  ok(!!invalidatedShadow && invalidatedShadow.status === 'pending' && invalidatedShadow.task > inFlightShadow.task, 'тень: изменение текста сразу инвалидирует прежний запрос');
  await page.waitForTimeout(1500);
  const staleAfterChange = await page.evaluate(() => window.__styleShadow || null);
  ok(!!staleAfterChange && staleAfterChange.status === 'running' && staleAfterChange.task > invalidatedShadow.task, 'тень: поздний ответ прежнего запроса не восстановил успешное состояние');
  await page.waitForTimeout(1600);
  const afterChange = await page.evaluate(() => window.__styleShadow || null);
  ok(!!afterChange && afterChange.status === 'ok' && afterChange.task > invalidatedShadow.task, 'тень: новый запрос завершился после инвалидации');
  await page.evaluate(() => { window.__styleDelay = 0; });

  // Отключение во время запроса: состояние очищается, поздний ответ не возвращает его.
  await page.evaluate(() => { window.__styleDelay = 1500; });
  await page.keyboard.type(' ');
  await page.waitForTimeout(950);
  const beforeDisable = await page.evaluate(() => window.__styleShadow || null);
  ok(!!beforeDisable && beforeDisable.status === 'running', 'тень: запрос выполняется перед отключением');
  await page.evaluate(() => window.kabinetStyleShadow.disable());
  const disabledShadow = await page.evaluate(() => window.__styleShadow || null);
  ok(disabledShadow === null, 'тень: disable сразу очищает состояние');
  await page.waitForTimeout(1700);
  const lateAfterDisable = await page.evaluate(() => window.__styleShadow || null);
  ok(lateAfterDisable === null, 'тень: поздний ответ после disable не восстановлен');
  const disabledCalls = await page.evaluate(() => window.__calls.filter(([n]) => n === 'style:parse').length);
  ok(await page.evaluate(() => localStorage.getItem('kabinet.styleEngineShadow') === null), 'тень: disable удаляет настройку');
  await page.keyboard.type(' ');
  await page.keyboard.type(' ');
  await page.waitForTimeout(1500);
  const disabledCallsAfterUpdate = await page.evaluate(() => window.__calls.filter(([n]) => n === 'style:parse').length);
  ok(disabledCallsAfterUpdate === disabledCalls, 'тень: после disable изменения документа не запускают style:parse');
  ok(await page.evaluate(() => window.__styleShadow === null), 'тень: после disable состояние остаётся пустым');
  await page.evaluate(() => { window.__styleDelay = 0; window.kabinetStyleShadow.enable(); });
  ok(await page.evaluate(() => localStorage.getItem('kabinet.styleEngineShadow') === '1'), 'тень: enable снова сохраняет режим');
  await page.keyboard.type(' ');
  await page.waitForTimeout(1400);
  const reenabledShadow = await page.evaluate(() => window.__styleShadow || null);
  ok(!!reenabledShadow && reenabledShadow.status === 'ok', 'тень: после повторного включения запрос снова работает');

  // Таймаут не должен вешать редактор и не должен применять поздний ответ.
  await page.evaluate(() => { window.__styleTimeoutMs = 50; window.__styleDelay = 900; });
  await page.keyboard.type(' ');
  await page.waitForTimeout(1300);
  const timeoutShadow = await page.evaluate(() => window.__styleShadow || null);
  ok(!!timeoutShadow && timeoutShadow.status === 'timeout', 'тень: таймаут даёт status timeout');
  await page.evaluate(() => { window.__styleTimeoutMs = 0; window.__styleDelay = 0; });
  await page.keyboard.type(' ');
  await page.waitForTimeout(1400);
  const afterTimeoutShadow = await page.evaluate(() => window.__styleShadow || null);
  ok(!!afterTimeoutShadow && afterTimeoutShadow.status === 'ok', 'тень: после таймаута новый разбор восстанавливается');

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
  ok(!!unavailableShadow && unavailableShadow.status === 'unavailable' && /недоступна/.test(unavailableShadow.error || ''), 'тень: недоступная команда даёт unavailable');
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
    await page.evaluate(() => { window.__styleChancery = true; });
    await styleBox.check();
    await page.waitForTimeout(1700);
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
  await page.evaluate(() => { window.__styleDelay = 0; });
  await page.locator('.ProseMirror').first().click();
  await page.keyboard.press((process.platform === 'darwin' ? 'Meta' : 'Control') + '+A');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(1200);
  const emptyShadow = await page.evaluate(() => window.__styleShadow || null);
  ok(!!emptyShadow && emptyShadow.status === 'empty' && emptyShadow.sentences === 0, 'тень: пустой документ явно очищает прежний результат');
  ok(errors.length === 0, 'после работы нет исключений: ' + errors.join(' | '));

  console.log(checks.map(([c, l]) => `${c ? 'ok  ' : 'FAIL'} ${l}`).join('\n'));
  await browser.close();
  server.close();
  process.exit(checks.every(([c]) => c) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
