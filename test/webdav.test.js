'use strict';
// Доступ к сетевой папке по WebDAV (src/webdav.js) и синхронизация проекта через неё.
// Сервер подставной: Map путей, ответы как у настоящего WebDAV (207, MKCOL, PUT, 409 без родителя).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dav = require('../src/webdav');
const folder = require('../src/folder');
const project = require('../src/project');

const enc = new TextEncoder();
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** Подставной сервер. dirs — множество путей папок («/a/b»), files — Map путь → байты. */
function fakeServer({ user = 'u', pass = 'p', prefix = 'd' } = {}) {
  const dirs = new Set(['/']);
  const files = new Map();
  const log = [];
  const request = async ({ method, url, headers = {}, body }) => {
    log.push(method);
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname).replace(/\/+$/, '') || '/';
    const parent = p.slice(0, p.lastIndexOf('/')) || '/';
    const ok = headers.Authorization === `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    if (!ok) return { status: 401, headers: {}, body: new Uint8Array(0) };
    if (method === 'MKCOL') {
      if (dirs.has(p) || files.has(p)) return { status: 405, headers: {}, body: new Uint8Array(0) };
      if (!dirs.has(parent)) return { status: 409, headers: {}, body: new Uint8Array(0) };
      dirs.add(p);
      return { status: 201, headers: {}, body: new Uint8Array(0) };
    }
    if (method === 'PUT') {
      if (!dirs.has(parent)) return { status: 409, headers: {}, body: new Uint8Array(0) };
      files.set(p, new Uint8Array(body));
      return { status: 201, headers: {}, body: new Uint8Array(0) };
    }
    if (method === 'GET') {
      return files.has(p) ? { status: 200, headers: {}, body: files.get(p) } : { status: 404, headers: {}, body: new Uint8Array(0) };
    }
    if (method === 'DELETE') {
      if (files.delete(p)) return { status: 204, headers: {}, body: new Uint8Array(0) };
      if (dirs.has(p)) { for (const k of [...files.keys()]) if (k.startsWith(`${p}/`)) files.delete(k); dirs.delete(p); return { status: 204, headers: {}, body: new Uint8Array(0) }; }
      return { status: 404, headers: {}, body: new Uint8Array(0) };
    }
    if (method === 'PROPFIND') {
      if (!dirs.has(p)) return { status: 404, headers: {}, body: new Uint8Array(0) };
      const entry = (href, isDir, size) => `<${prefix}:response><${prefix}:href>${esc(encodeURI(href))}</${prefix}:href><${prefix}:propstat><${prefix}:prop>` +
        (isDir ? `<${prefix}:resourcetype><${prefix}:collection/></${prefix}:resourcetype>` : `<${prefix}:resourcetype/><${prefix}:getcontentlength>${size}</${prefix}:getcontentlength>`) +
        `<${prefix}:getlastmodified>Wed, 01 Jan 2025 10:00:00 GMT</${prefix}:getlastmodified></${prefix}:prop></${prefix}:propstat></${prefix}:response>`;
      let xml = `<?xml version="1.0"?><${prefix}:multistatus xmlns:${prefix}="DAV:">` + entry(`${p === '/' ? '' : p}/`, true, 0);
      if (headers.Depth !== '0') {
        for (const d of dirs) if (d !== p && (d.slice(0, d.lastIndexOf('/')) || '/') === p) xml += entry(`${d}/`, true, 0);
        for (const [f, v] of files) if ((f.slice(0, f.lastIndexOf('/')) || '/') === p) xml += entry(f, false, v.length);
      }
      xml += `</${prefix}:multistatus>`;
      return { status: 207, headers: {}, body: enc.encode(xml) };
    }
    return { status: 405, headers: {}, body: new Uint8Array(0) };
  };
  return { dirs, files, log, request };
}

const mk = (srv, root = '/Кабинет/Роман') => dav.createWebDav({ url: 'https://dav.example.com', user: 'u', pass: 'p', root, request: srv.request });

test('адрес приводится к виду https://host/путь', () => {
  assert.equal(dav.normalizeUrl('webdav.yandex.ru'), 'https://webdav.yandex.ru');
  assert.equal(dav.normalizeUrl(' https://x.ru/remote.php/dav/files/me/ '), 'https://x.ru/remote.php/dav/files/me');
  assert.throws(() => dav.normalizeUrl(''), /адрес/i);
  assert.throws(() => dav.normalizeUrl('ftp://x.ru'), /https/);
});

test('разбор ответа с любыми префиксами и русскими именами', () => {
  const xml = '<?xml version="1.0"?><multistatus xmlns="DAV:"><response><href>/a/%D0%93%D0%BB%D0%B0%D0%B2%D1%8B/</href><propstat><prop><resourcetype><collection/></resourcetype></prop></propstat></response>' +
    '<response><href>/a/f%20&amp;g.md</href><propstat><prop><resourcetype/><getcontentlength>12</getcontentlength></prop></propstat></response></multistatus>';
  const r = dav.parseMultistatus(xml);
  assert.deepEqual(r.map((x) => [x.href, x.dir, x.size]), [['/a/Главы/', true, 0], ['/a/f &g.md', false, 12]]);
});

for (const prefix of ['d', 'D', 'lp1']) {
  test(`запись, чтение, список, удаление (префикс ${prefix})`, async () => {
    const srv = fakeServer({ prefix });
    const a = mk(srv);
    await a.write('Главы/01 Начало.md', enc.encode('Текст'));
    assert.equal(Buffer.from(await a.read('Главы/01 Начало.md')).toString(), 'Текст');
    assert.equal(await a.read('Главы/нет.md'), null);
    const top = await a.list('');
    assert.deepEqual(top.map((x) => [x.name, x.dir]), [['Главы', true]]);
    const inner = await a.list('Главы');
    assert.deepEqual(inner.map((x) => [x.name, x.dir]), [['01 Начало.md', false]]);
    assert.deepEqual(await a.list('Нет такой'), []);
    await a.remove('Главы/01 Начало.md');
    assert.equal(await a.read('Главы/01 Начало.md'), null);
    await a.remove('Главы/нет.md'); // удаление отсутствующего не ошибка
  });
}

test('неверный пароль даёт понятную ошибку', async () => {
  const srv = fakeServer({ pass: 'другой' });
  await assert.rejects(() => mk(srv).check(), /логин или пароль/);
});

test('выбор папки: показываются только каталоги', async () => {
  const srv = fakeServer();
  const a = dav.createWebDav({ url: 'https://dav.example.com', user: 'u', pass: 'p', root: '', request: srv.request });
  srv.dirs.add('/Книги'); srv.dirs.add('/Абрикос'); srv.files.set('/файл.txt', enc.encode('x'));
  const list = await dav.browseFolders({ url: 'https://dav.example.com', user: 'u', pass: 'p', path: '', request: srv.request });
  assert.deepEqual(list, [{ name: 'Абрикос', path: '/Абрикос' }, { name: 'Книги', path: '/Книги' }]);
  void a;
});

test('проект уходит на сервер и приходит обратно на другое устройство', async () => {
  const srv = fakeServer();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kab-dav-'));
  try {
    const d1 = path.join(tmp, 'one');
    project.createProject(d1, 'Роман', {});
    const s1 = folder.createFolderSync(d1, mk(srv), { stateFile: path.join(tmp, 's1.json') });
    await s1.exportAll();
    assert.ok([...srv.files.keys()].some((k) => k.startsWith('/Кабинет/Роман/Главы/')), 'глава на сервере');

    const d2 = path.join(tmp, 'two');
    const s2 = folder.createFolderSync(d2, mk(srv), { stateFile: path.join(tmp, 's2.json') });
    await s2.importAll();
    assert.ok(project.openProject(d2).chapters.length >= 1);
    const id = project.openProject(d2).chapters[0].id;
    project.writeChapter(d2, id, 'Новая строка с другого устройства');
    await s2.sync();
    await s1.sync();
    assert.match(project.readChapter(d1, id), /Новая строка/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('компьютер: связь проекта с сетевой папкой, вход, подключение, повторное открытие', async () => {
  const { createDavLink } = require('../src/davlink');
  const srv = fakeServer();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kab-davlink-'));
  const events = [];
  const link = createDavLink({ dataDir: path.join(tmp, 'data'), request: srv.request, secret: { seal: (s) => `s:${s}`, open: (s) => s.slice(2) }, onEvent: (e) => events.push(e) });
  fs.mkdirSync(path.join(tmp, 'data'));
  try {
    await assert.rejects(() => link.login({ url: 'dav.example.com', user: 'u', pass: 'плохой' }), /логин или пароль/);
    const acc0 = await link.login({ url: 'dav.example.com', user: 'u', pass: 'p' });
    assert.deepEqual(await link.browse(acc0, ''), []);
    const root = await link.makeFolder(acc0, '', 'Кабинет');
    const root2 = await link.makeFolder(acc0, root, 'Роман');
    assert.equal(root2, '/Кабинет/Роман');
    const acc = { ...acc0, root: root2, label: 'Тест' };

    const d1 = path.join(tmp, 'one');
    project.createProject(d1, 'Роман', {});
    assert.equal(link.status(d1).linked, false);
    const res = await link.attach(d1, acc, 'ask');
    assert.equal(res.exists, false);
    assert.equal(link.status(d1).linked, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'dav-links.json'), 'utf8'))[d1].pass, 's:p', 'пароль хранится в запечатанном виде');
    assert.ok([...srv.files.keys()].some((k) => k.startsWith('/Кабинет/Роман/Главы/')));

    // второй компьютер: открыть проект из папки
    const d2 = path.join(tmp, 'two');
    await link.openRemote(acc, d2);
    assert.ok(project.openProject(d2).chapters.length >= 1);
    assert.equal((await link.attach(path.join(tmp, 'three'), acc, 'ask').catch(() => ({ exists: true }))).exists, true);

    link.start(d2);
    const id = project.openProject(d2).chapters[0].id;
    project.writeChapter(d2, id, 'Правка на втором компьютере');
    const st = await link.syncNow();
    assert.equal(st.linked, true);
    assert.equal(st.error, '');
    assert.match(Buffer.from([...srv.files.entries()].find(([k]) => k.includes('/Главы/') && k.endsWith('.md'))[1]).toString(), /Правка на втором/);
    await link.detach(d2);
    assert.equal(link.status(d2).linked, false);
    assert.equal(srv.files.has('/Кабинет/Роман/kabinet.lock'), false, 'замок снят при отключении');
  } finally {
    link.stopWork();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('http:// допустим только в домашней сети, через интернет пароль не отправляется', () => {
  for (const ok of ['http://localhost', 'http://127.0.0.1:8080', 'http://192.168.1.5/dav', 'http://10.0.0.2', 'http://172.20.1.1', 'http://nas.local', 'http://nas', 'https://dav.example.com']) {
    assert.doesNotThrow(() => dav.createWebDav({ url: ok, user: 'u', pass: 'p', request: async () => ({ status: 200, headers: {}, body: new Uint8Array() }) }), ok);
  }
  for (const bad of ['http://dav.example.com', 'http://8.8.8.8', 'http://172.32.0.1', 'http://192.169.1.1']) {
    assert.throws(() => dav.createWebDav({ url: bad, user: 'u', pass: 'p', request: async () => ({}) }), /https/, bad);
  }
});
