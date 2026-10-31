'use strict';
const crypto = require('node:crypto');
const API = 'https://cloud-api.yandex.net/v1/disk';
const PREFIX = 'oauth-yandex:';
const isOAuthUser = (s) => typeof s === 'string' && /^oauth-yandex:[a-f0-9]{32}$/.test(s);
function createYandexDisk({ pass, root = '', request, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let credentials;
  try { credentials = JSON.parse(pass); } catch { throw new Error('Подключите Яндекс Диск заново.'); }
  if (!credentials || credentials.kind !== 'kabinet-yandex-oauth' || typeof credentials.accessToken !== 'string' || !credentials.accessToken || !Number.isFinite(credentials.expiresAt)) throw new Error('Некорректные данные подключения Яндекса.');
  const parts = (s) => {
    const a = String(s || '').split('/').filter(Boolean);
    if (a.some((p) => p === '.' || p === '..' || /[\\\0]/.test(p))) throw new Error('Недопустимый путь Диска.');
    return a;
  };
  const base = parts(root);
  const diskPath = (rel) => 'disk:/' + [...base, ...parts(rel)].join('/');
  const known = new Set();
  function fail(status) {
    const message = ({401:'Доступ к Яндекс Диску истёк. Подключите его заново.',403:'Яндекс не разрешил доступ к папке.',429:'Яндекс просит подождать. Повторим синхронизацию позже.',507:'На Яндекс Диске закончилось место.'})[status];
    const e = new Error(message || `Яндекс Диск ответил кодом ${status}.`); e.status = status; throw e;
  }
  async function send(method, suffix, query = {}, allowMissing = false) {
    if (now() >= credentials.expiresAt) fail(401);
    const url = new URL(API + suffix); url.search = new URLSearchParams(query).toString();
    let res;
    try { res = await request({method, url:url.href, headers:{Authorization:`OAuth ${credentials.accessToken}`}, redirect:'manual', timeoutMs:90000}); }
    catch { throw new Error('Нет связи с Яндекс Диском.'); }
    if (allowMissing && res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) fail(res.status);
    let data = null;
    if (res.body && res.body.length) {
      try { data = JSON.parse(new TextDecoder().decode(res.body)); } catch { throw new Error('Некорректный ответ Яндекс Диска.'); }
    }
    return { ...res, data };
  }
  function transferUrl(raw) {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || !['yandex.ru','yandex.net'].some((h) => u.hostname === h || u.hostname.endsWith('.'+h))) throw new Error('Яндекс вернул недопустимую ссылку на файл.');
    return u.href;
  }
  async function transfer(method, href, body) {
    let url = transferUrl(href);
    for (let i=0; i<6; i++) {
      let res;
      try { res = await request({method,url,headers:method==='PUT'?{'Content-Type':'application/octet-stream'}:{},body,redirect:'manual',timeoutMs:90000}); }
      catch { throw new Error('Не удалось передать файл Яндекс Диску.'); }
      if ([301,302,303,307,308].includes(res.status)) {
        if (method !== 'GET' || !res.headers || !res.headers.location) throw new Error('Неожиданный переход при передаче файла.');
        url = transferUrl(new URL(res.headers.location,url).href); continue;
      }
      if (res.status < 200 || res.status >= 300) fail(res.status);
      return res;
    }
    throw new Error('Слишком много переходов при скачивании файла.');
  }
  const meta = (p, missing=false) => send('GET','/resources',{path:p,fields:'type,size,md5'},missing);
  async function mkdirPath(p) {
    if (known.has(p)) return;
    try { await send('PUT','/resources',{path:p}); }
    catch (e) { if (e.status !== 409 || (await meta(p)).data?.type !== 'dir') throw e; }
    known.add(p);
  }
  async function ensure(rel='') {
    const all = [...base,...parts(rel)];
    for (let i=1;i<=all.length;i++) await mkdirPath('disk:/'+all.slice(0,i).join('/'));
  }
  return {
    async check() { const res=await meta(diskPath('')); return !!res && res.data?.type==='dir'; },
    ensureRoot: () => ensure(),
    mkdir: (rel) => ensure(rel),
    async list(rel) {
      const out=[]; let offset=0;
      for (;;) {
        const res=await send('GET','/resources',{path:diskPath(rel),limit:'1000',offset:String(offset)},true);
        if (!res) return [];
        const e=res.data && res.data._embedded;
        if (!e || !Array.isArray(e.items) || !Number.isSafeInteger(e.total) || e.total<0 || e.total>1000000) throw new Error('Неполный список файлов Яндекс Диска.');
        if (offset<e.total && !e.items.length) throw new Error('Яндекс вернул неполный список файлов.');
        for (const it of e.items) {
          if (!it || typeof it.name!=='string' || parts(it.name).length!==1 || it.name.includes('/') || !['dir','file'].includes(it.type)) throw new Error('Некорректный элемент папки Яндекса.');
          out.push({name:it.name,dir:it.type==='dir',size:Number(it.size)||0,mtime:Date.parse(it.modified)||0});
        }
        offset+=e.items.length;
        if (offset>=e.total) return out;
      }
    },
    async read(rel) {
      const res=await send('GET','/resources/download',{path:diskPath(rel)},true);
      if (!res) return null;
      if (!res.data || typeof res.data.href!=='string') throw new Error('Яндекс не выдал ссылку на файл.');
      return new Uint8Array((await transfer('GET',res.data.href)).body || new Uint8Array());
    },
    async write(rel, bytes) {
      const p=parts(rel); if (!p.length) throw new Error('Не указан файл.');
      await ensure(p.slice(0,-1).join('/'));
      const res=await send('GET','/resources/upload',{path:diskPath(rel),overwrite:'true'});
      if (!res.data || typeof res.data.href!=='string') throw new Error('Яндекс не выдал ссылку для загрузки.');
      await transfer('PUT',res.data.href,bytes);
      const md5=crypto.createHash('md5').update(bytes).digest('hex');
      for (let i=0;i<20;i++) {
        const check=await meta(diskPath(rel),true);
        if (check?.data?.type==='file' && check.data.md5===md5) return;
        await sleep(500);
      }
      throw new Error('Яндекс ещё не подтвердил сохранение файла. Синхронизация будет повторена.');
    },
    async remove(rel) {
      if (!parts(rel).length) throw new Error('Удаление корня запрещено.');
      const res=await send('DELETE','/resources',{path:diskPath(rel)},true);
      if (!res || res.status===204) return;
      if (res.status!==202 || typeof res.data?.href!=='string') throw new Error('Яндекс не подтвердил удаление.');
      const u=new URL(res.data.href);
      if (u.origin!=='https://cloud-api.yandex.net' || !u.pathname.startsWith('/v1/disk/operations/') || u.search || u.hash) throw new Error('Некорректный адрес операции Яндекса.');
      for (let i=0;i<30;i++) {
        const op=await send('GET',u.pathname.slice('/v1/disk'.length));
        if (op.data?.status==='success') return;
        if (op.data?.status!=='in-progress') throw new Error('Яндекс не смог удалить файл.');
        await sleep(500);
      }
      throw new Error('Удаление на Яндекс Диске ещё не завершено.');
    },
  };
}
module.exports={createYandexDisk,isOAuthUser,PREFIX};
