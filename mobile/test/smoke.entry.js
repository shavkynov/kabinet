// Запускается в Node через esbuild (build-smoke.js): модули проекта работают поверх виртуальной ФС.
const assert = require('assert');
const fs = require('fs');
const { createBackend } = require('../backend');

const sent = [];
const host = {
  version: 'test', platform: 'android',
  confirm: async () => 0,
  choose: async ({ options }) => options[0].value,
  pickFiles: async () => [],
  deliver: async (f) => { sent.push(f); },
  openUrl: () => {},
  zip: (entries) => Buffer.from(JSON.stringify(entries.map((e) => e.path))),
};

(async () => {
  const mem = new Map();
  fs.setStore({
    loadAll: async () => [...mem.values()],
    apply: async (puts, dels) => { for (const r of puts) mem.set(r.p, r); for (const p of dels) mem.delete(p); },
  }, { delay: 1 });
  const be = createBackend(host);
  const api = be.api;

  let proj = await api.createProject('Мой роман', 'novel');
  assert.equal(proj.name, 'Мой роман');
  const id = proj.chapters[0].id;
  await api.writeChapter(id, 'Анна пришла домой. Анна улыбнулась.\n\n— Привет, — сказала она.');
  assert.match(await api.readChapter(id), /Анна пришла/);
  const added = await api.addChapter(id);
  assert.equal(added.project.chapters.length, 2);

  const card = await api.addItem('character', null);
  assert.ok(card);
  const hits = await api.searchProject('Анна');
  assert.ok(JSON.stringify(hits).includes('Анна'));
  const dry = await api.replaceProject('Анна', 'Мария', true);
  assert.ok(dry);
  await api.replaceProject('Анна', 'Мария', false);
  assert.match(await api.readChapter(id), /Мария пришла/);

  for (const fmt of ['docx', 'rtf', 'md', 'txt', 'html']) {
    host.choose = async () => fmt;
    const name = await api.exportProject({});
    assert.equal(name, `Мой роман.${fmt}`);
  }
  assert.equal(sent.length, 5);
  assert.ok(sent[0].data.length > 200, 'docx не пустой');
  assert.equal(String(Buffer.from(sent[0].data.slice(0, 2))), 'PK');

  assert.ok(await api.backupNow() !== undefined);
  const zipName = await api.openBackupFolder();
  assert.equal(zipName, 'Мой роман.zip');

  await api.setDayWords('2026-10-30', 120);
  const sum = await api.statsSummary('2026-10-30', 120);
  assert.ok(sum);
  const board = await api.projectBoard();
  assert.ok(board);

  // импорт глав
  host.pickFiles = async () => [{ name: 'a.txt', data: new Uint8Array(Buffer.from('Глава 1\n\nТекст первый.\n\nГлава 2\n\nТекст второй.')) }];
  const imp = await api.importFiles();
  assert.ok(imp.ids.length >= 1);

  // корзина
  const cur = await api.currentProject();
  const last = cur.chapters[cur.chapters.length - 1];
  await api.deleteChapter(last.id);
  assert.ok(await api.currentProject());

  // запись на «диск» и загрузка в чистую ФС
  await fs.flush();
  const before = [...fs._files.keys()].sort();
  fs.reset();
  assert.equal(fs._files.size, 0);
  fs.setStore({ loadAll: async () => [...mem.values()], apply: async () => {} });
  await fs.loadAll();
  assert.deepEqual([...fs._files.keys()].sort(), before);
  const be2 = createBackend(host);
  const list = await be2.api.listRecents();
  assert.equal(list.length, 1);
  const reopened = await be2.api.openRecent(list[0].path);
  assert.equal(reopened.name, 'Мой роман');

  // каждый вызов из preload.js должен иметь обработчик
  const pre = PRELOAD_SRC;
  const channels = [...pre.matchAll(/call\('([a-zA-Z:]+)'/g)].map((m) => m[1]);
  const missing = channels.filter((c) => !be2.handlers[c]);
  assert.deepEqual(missing, [], `нет обработчиков: ${missing}`);
  const apiNames = [...pre.matchAll(/^\s{2}([a-zA-Z]+):/gm)].map((m) => m[1]);
  const lack = apiNames.filter((n) => !(n in be2.api));
  assert.deepEqual(lack, [], `нет в api: ${lack}`);
  console.log('OK: каналов', channels.length, ', методов', apiNames.length, ', файлов в ФС', before.length);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
