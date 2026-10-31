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
  const copies = be.listCopies();
  assert.ok(copies.length >= 1, 'копия есть в списке');
  const restored = be.restoreCopy(copies[0]);
  assert.match(restored, /копия/);
  assert.equal(be.flushFolder() instanceof Promise, true);
  assert.equal(be.folderStatus().busy, false);
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
  assert.equal(list.length, 2); // проект и восстановленная из копии версия
  const reopened = await be2.api.openRecent(list.find((r) => r.name === 'Мой роман').path);
  assert.equal(reopened.name, 'Мой роман');

  // синхронизация с обычной папкой: два устройства работают в одной папке
  const nodes = new Map(); // файлы «внешней папки»: путь → байты
  const folders = new Set(); // пустые папки: SAF их тоже показывает
  const rel = (p) => String(p).split('/').filter(Boolean).join('/');
  const URI = 'content://fake/tree';
  // Папка на каждый uri: у разных проектов могут быть разные папки, и подставной адаптер
  // обязан это учитывать, иначе тест не заметит, что проект пишет в чужую папку.
  const stores = new Map([[URI, { nodes, folders }]]);
  const storeOf = (uri) => {
    if (!stores.has(uri)) stores.set(uri, { nodes: new Map(), folders: new Set() });
    return stores.get(uri);
  };
  host.folder = {
    choose: async () => ({ uri: URI, name: 'Яндекс.Диск' }),
    forget: async () => {},
    adapter: (uri) => {
      const s = storeOf(uri || URI);
      return {
        async list(p) {
          const base = rel(p);
          const out = new Map();
          const add = (key) => {
            if (base && !key.startsWith(`${base}/`)) return;
            const rest = base ? key.slice(base.length + 1) : key;
            const name = rest.split('/')[0];
            if (name && !out.get(name)) out.set(name, rest.includes('/'));
          };
          for (const key of s.nodes.keys()) add(key);
          for (const key of s.folders) add(key);
          return [...out].map(([name, dir]) => ({ name, dir }));
        },
        async read(p) { const v = s.nodes.get(rel(p)); return v ? new Uint8Array(v) : null; },
        async write(p, data) { s.nodes.set(rel(p), new Uint8Array(data)); },
        async remove(p) { s.nodes.delete(rel(p)); },
        async mkdir(p) { if (rel(p)) s.folders.add(rel(p)); },
      };
    },
  };
  await be2.call('folder:choose'); // папка пуста → проект выгружается целиком
  assert.ok(nodes.has('project.json'), 'project.json ушёл в папку');
  assert.equal(be2.folderStatus().linked, true);
  const chapterRel = [...nodes.keys()].find((k) => k.startsWith('Главы/'));
  assert.ok(chapterRel, 'глава ушла в папку');

  // правка с другого устройства приходит в открытые списки
  const incoming = [];
  be2.api.onExternalChange((files) => incoming.push(...files));
  nodes.set(chapterRel, new Uint8Array(Buffer.from('Правка с компьютера.\n')));
  await be2.call('folder:syncNow');
  assert.ok(incoming.includes(chapterRel), 'о пришедшей правке сообщено интерфейсу');

  // спорная правка: своя остаётся, чужая уходит в «Конфликты»
  const chapterId = chapterRel.slice('Главы/'.length, -3);
  await be2.api.writeChapter(chapterId, 'Своя правка.\n');
  nodes.set(chapterRel, new Uint8Array(Buffer.from('Чужая правка.\n')));
  await be2.call('folder:syncNow');
  assert.match(await be2.api.readChapter(chapterId), /Своя правка/);
  assert.ok([...nodes.keys()].some((k) => k.startsWith('Конфликты/')), 'чужая версия видна и в папке');

  await be2.api.closeProject();
  assert.equal(be2.folderStatus().linked, false);
  assert.ok(!nodes.has('kabinet.lock'), 'замок снят');

  // Второй проект — своя папка. Плагин помнит последнюю выбранную папку, поэтому адаптер
  // обязан работать с папкой именно этого проекта, иначе второй проект уедет в первую папку.
  const URI2 = 'content://fake/tree2';
  const nodes2 = storeOf(URI2).nodes;
  host.folder.choose = async () => ({ uri: URI2, name: 'Google Drive' });
  const second = await be2.api.createProject('Второй роман', 'novel');
  await be2.call('folder:choose');
  assert.ok(nodes2.has('project.json'), 'второй проект лёг в свою папку');
  assert.match(Buffer.from(nodes2.get('project.json')).toString('utf8'), /Второй роман/);
  assert.match(Buffer.from(nodes.get('project.json')).toString('utf8'), /Мой роман/, 'в первой папке остался первый проект');
  assert.equal(be2.folderStatus().uri, URI2);
  await be2.api.closeProject();

  // «Заменить папку»: в папке уже лежит чужой проект, выбираем замену — чужие главы не должны
  // попасть в открытый проект, а их версии сохраняются в «Конфликты».
  const URI3 = 'content://fake/tree3';
  const store3 = storeOf(URI3);
  store3.nodes.set('project.json', new Uint8Array(Buffer.from('{"name":"Чужой роман","chapters":[]}')));
  store3.nodes.set('Главы/чужой1.md', new Uint8Array(Buffer.from('Чужой текст.')));
  const third = await be2.api.createProject('Третий роман', 'novel');
  const thirdId = third.chapters[0].id;
  await be2.api.writeChapter(thirdId, 'Свой текст.\n');
  host.folder.choose = async () => ({ uri: URI3, name: 'Облако' });
  host.confirm = async () => 1; // «Заменить папку»
  await be2.call('folder:choose');
  await new Promise((r) => setTimeout(r, 30)); // вычитка из папки идёт следом за выбором
  const after = await be2.api.currentProject();
  assert.equal(after.name, 'Третий роман');
  assert.ok(!after.chapters.some((c) => c.id === 'чужой1'), 'чужие главы не влились');
  assert.equal(await be2.api.readChapter(thirdId), 'Свой текст.\n');
  assert.match(Buffer.from(store3.nodes.get('project.json')).toString('utf8'), /Третий роман/);
  assert.ok([...store3.nodes.keys()].some((k) => k.startsWith('Конфликты/')), 'чужой текст сохранён в «Конфликты»');
  const stray = [...fs._files.keys()].filter((k) => k.endsWith('чужой1.md'));
  assert.deepEqual(stray, [], 'чужие файлы глав не появились в проекте');
  host.confirm = async () => 0;
  await be2.api.closeProject();

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
