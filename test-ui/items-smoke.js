'use strict';
// Поведенческая проверка «Предметов» в запущенном приложении. См. README.md.
// xvfb-run -a node test-ui/items-smoke.js
// Приложение запускается с изолированным HOME: настоящие настройки не затрагиваются.
const path = require('path');
const { _electron: electron } = require(path.join(__dirname, '..', 'node_modules', 'playwright'));

const APP = path.join(__dirname, '..');
const HOME = '/tmp/kabinet-smoke-home';
let failures = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? 'OK  ' : 'FAIL') + ' ' + name + (cond ? '' : (extra ? ' :: ' + extra : '')));
  if (!cond) failures++;
};

(async () => {
  const app = await electron.launch({
    args: [APP],
    env: { ...process.env, HOME, XDG_CONFIG_HOME: path.join(HOME, '.config') },
    timeout: 30000,
  });
  const win = await app.firstWindow();
  await win.waitForSelector('#start', { timeout: 15000 });

  // 1. открыть недавний проект «Роман»
  await win.waitForSelector('#recentList li', { timeout: 10000 });
  await win.click('#recentList li');
  await win.waitForSelector('[data-sec="item"]', { timeout: 15000 });
  await win.waitForFunction(() => document.querySelector('#itemList').textContent.includes('Экскалибур'), null, { timeout: 10000 });
  ok('раздел «Предметы» видим, карточка в списке', true);

  // 2. открыть главу: имя предмета подсвечено
  await win.click('#chapterList .ch');
  await win.waitForSelector('.name-link.kind-item', { timeout: 10000 });
  const hl = await win.$eval('.name-link.kind-item', (el) => el.textContent);
  ok('подсветка имени предмета в тексте', hl === 'Экскалибур', 'получили: ' + hl);

  // 3. Ctrl+клик по подсвеченному имени открывает карточку
  await win.click('.name-link.kind-item', { modifiers: ['Control'] });
  await win.waitForFunction(() => document.querySelector('#cardView') && !document.querySelector('#cardView').hidden, null, { timeout: 10000 });
  const title = await win.$eval('#cardTitle', (el) => el.value);
  ok('карточка открылась по клику', title === 'Экскалибур', 'получили: ' + title);
  const protagHidden = await win.$eval('#cardProtagRow', (el) => el.hidden);
  ok('строки протагониста нет (как у мест)', protagHidden === true);

  // 3а. список глав, где предмет встречается
  await win.waitForSelector('#cardView .mention-list button', { timeout: 10000 });
  const mentions = await win.$$eval('#cardView .mention-list button', (els) => els.map((b) => b.textContent.trim()));
  ok('карточка показывает главы с упоминаниями', mentions.length === 1 && mentions[0].startsWith('1.'), JSON.stringify(mentions));

  // 4. «+» создаёт предмет и сразу открывает переименование (как у остальных карточек)
  const before = await win.$$eval('#itemList .card', (r) => r.length);
  await win.click('#addItem');
  await win.waitForFunction((n) => document.querySelectorAll('#itemList .card').length === n + 1, before, { timeout: 10000 });
  await win.waitForSelector('#itemList .card input.rename', { timeout: 10000 });
  ok('новая карточка в режиме переименования', true);
  await win.fill('#itemList .card input.rename', 'Лунный камень');
  await win.keyboard.press('Enter');
  await win.waitForFunction(() => [...document.querySelectorAll('#itemList .card')].some((x) => x.textContent.includes('Лунный камень')), null, { timeout: 10000 });
  ok('имя вписалось в список', true);

  // 5. карточка без шаблона: только служебные блоки
  const rowIdx = await win.$$eval('#itemList .card', (r) => r.findIndex((x) => x.textContent.includes('Лунный камень')));
  await win.click(`#itemList .card:nth-child(${rowIdx + 1})`);
  await win.waitForFunction(() => document.querySelector('#cardView') && !document.querySelector('#cardView').hidden, null, { timeout: 10000 });
  await win.waitForFunction(() => document.querySelector('#cardTitle').value === 'Лунный камень', null, { timeout: 10000 });
  const cfLabels = await win.$$eval('#cardView .cf', (r) => r.map((x) => x.textContent.trim().split('\n')[0]));
  ok('шаблонных полей нет: только служебные блоки', cfLabels.length === 3, 'cf-строк: ' + cfLabels.length);
  ok('поля-шаблона «Общее описание» нет', !cfLabels.some((x) => x.startsWith('Общее описание')), JSON.stringify(cfLabels));

  // 6. краткая справка — обязательно
  const shortInput = await win.$('#cardView textarea');
  ok('поле краткой справки на месте', !!shortInput);
  if (!shortInput) { await app.close(); process.exit(1); }
  await shortInput.fill('подарок луны');

  // 7. своё поле через меню «+»
  await win.click('#cardAddField');
  await win.waitForSelector('.ctx-menu button', { timeout: 10000 });
  const hasTpl = await win.$$eval('.ctx-menu button', (els) => els.some((b) => b.textContent.includes('Общее описание')));
  ok('в меню нет полей-шаблонов, только «Своё поле…»', !hasTpl);
  await win.click('.ctx-menu button:has-text("Своё поле…")');
  await win.waitForSelector('#textDialog', { state: 'visible', timeout: 10000 });
  await win.fill('#textDialogInput', 'Происхождение');
  await win.click('#textDialog button[value="ok"]');
  await win.waitForFunction(() => [...document.querySelectorAll('#cardView .cf')].some((x) => x.textContent.trim().startsWith('Происхождение')), null, { timeout: 10000 });
  ok('своё поле добавлено', true);
  const fieldTA = await win.$$eval('#cardView .cf', (rows) => {
    const row = rows.find((x) => x.textContent.trim().startsWith('Происхождение'));
    return row ? row.querySelector('textarea').value : null;
  });
  const fieldBox = await win.$$('#cardView .cf textarea');
  const lastTA = fieldBox[fieldBox.length - 1];
  await lastTA.fill('упал с неба');
  ok('значение своего поля заполнено', fieldTA === '', 'стартовое значение: ' + JSON.stringify(fieldTA));

  // 8. автосохранение, переоткрытие: имя, справка и своё поле на месте
  await win.waitForTimeout(2500); // автосохранение (1,5 с) + индекс
  await win.click('#chapterList .ch');
  await win.waitForFunction(() => document.querySelector('#cardView').hidden === true, null, { timeout: 10000 });
  const idx2 = await win.$$eval('#itemList .card', (r) => r.findIndex((x) => x.textContent.includes('Лунный камень')));
  await win.click(`#itemList .card:nth-child(${idx2 + 1})`);
  await win.waitForFunction(() => document.querySelector('#cardTitle').value === 'Лунный камень', null, { timeout: 10000 });
  const shortBack = await win.$eval('#cardView textarea', (el) => el.value);
  ok('краткая справка сохранилась', shortBack === 'подарок луны', 'получили: ' + JSON.stringify(shortBack));
  const fieldBack = await win.$$eval('#cardView .cf', (rows) => {
    const row = rows.find((x) => x.textContent.trim().startsWith('Происхождение'));
    return row ? row.querySelector('textarea').value : null;
  });
  ok('своё поле сохранилось', fieldBack === 'упал с неба', 'получили: ' + JSON.stringify(fieldBack));

  await app.close();
  console.log(failures === 0 ? '\nSMOKE: все проверки пройдены' : `\nSMOKE: провалов ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => { console.error('SMOKE ERROR:', err.message); process.exit(2); });
