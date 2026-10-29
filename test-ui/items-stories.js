'use strict';
// Проверка «Предметов» в режиме «Рассказы»: скрыты по умолчанию, включаются галочкой в Aa.
// xvfb-run -a node test-ui/items-stories.js
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

  // открываем проект «Рассказы» (второй в недавних)
  const items = await win.$$('#recentList li');
  if (items.length < 2) { console.error('STORIES ERROR: в недавних нет двух проектов — запустите prepare-project.js'); process.exit(2); }
  await items[1].click();
  await win.waitForSelector('[data-sec="item"]', { timeout: 15000, state: 'attached' });

  // по умолчанию скрыты все три вида карточек
  const hiddenDefault = await win.$$eval('[data-sec="item"], [data-sec="character"], [data-sec="place"]', (els) => els.map((e) => e.hidden));
  ok('в рассказах «Предметы» скрыты по умолчанию (как персонажи и места)', hiddenDefault.every(Boolean), JSON.stringify(hiddenDefault));

  // включаем через настройки Aa
  await win.click('#btnSettings');
  await win.waitForSelector('#setStoryItems', { timeout: 10000 });
  const rowVisible = await win.$eval('#setStoryItems', (el) => {
    const r = el.closest('.row');
    return r && getComputedStyle(r).display !== 'none';
  });
  ok('галочка «Показывать предметы» видна в настройках', rowVisible === true);
  await win.check('#setStoryItems');
  await win.waitForFunction(() => document.querySelector('[data-sec="item"]') && !document.querySelector('[data-sec="item"]').hidden, null, { timeout: 10000 });
  ok('после галочки раздел появился', true);
  const othersStillHidden = await win.$$eval('[data-sec="character"], [data-sec="place"]', (els) => els.map((e) => e.hidden));
  ok('персонажи и места по-прежнему скрыты', othersStillHidden.every(Boolean), JSON.stringify(othersStillHidden));

  await app.close();
  console.log(failures === 0 ? '\nSTORIES: все проверки пройдены' : `\nSTORIES: провалов ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => { console.error('STORIES ERROR:', err.message); process.exit(2); });
