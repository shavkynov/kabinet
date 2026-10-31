'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {createYandexDisk,isOAuthUser}=require('../src/yandex-disk');
const enc=(x)=>new TextEncoder().encode(JSON.stringify(x));
const response=(status,data)=>({status,headers:{},body:data===undefined?new Uint8Array():enc(data)});
const pass=JSON.stringify({kind:'kabinet-yandex-oauth',accessToken:'fixture-token',expiresAt:Date.now()+3600000});
function setup(fn,extra={}){const calls=[];const disk=createYandexDisk({pass,root:'/Кабинет/Роман',sleep:async()=>{},request:async(r)=>{calls.push(r);return fn(r,calls.length);},...extra});return {disk,calls};}
test('identity marker and credentials validation',()=>{
  assert.equal(isOAuthUser('oauth-yandex:'+'a'.repeat(32)),true);
  assert.equal(isOAuthUser('ordinary'),false);
  assert.throws(()=>createYandexDisk({pass:'{}',request:async()=>{}}));
});
test('list paginates and encodes Cyrillic path',async()=>{
  const x=setup((r)=>{const u=new URL(r.url),offset=Number(u.searchParams.get('offset'));assert.equal(u.searchParams.get('path'),'disk:/Кабинет/Роман');return response(200,{_embedded:{total:2,items:[{name:offset?'Б.md':'А.md',type:'file',size:1,modified:'2026-01-01T00:00:00Z'}]}});});
  const list=await x.disk.list('');assert.deepEqual(list.map((x)=>x.name),['А.md','Б.md']);assert.equal(x.calls.length,2);
});
test('partial listing never pretends the folder is empty',async()=>{
  const x=setup(()=>response(200,{_embedded:{total:1,items:[]}}));await assert.rejects(x.disk.list(''),/неполный/);
});
test('traversal and slash-containing remote names are rejected',async()=>{
  const x=setup(()=>response(200,{_embedded:{total:1,items:[{name:'../a',type:'file'}]}}));
  await assert.rejects(x.disk.list(''));await assert.rejects(x.disk.read('../secret'));
  assert.equal(x.calls.length,1);
});
test('download follows provider redirects without leaking OAuth header',async()=>{
  const x=setup((r)=>{
    const u=new URL(r.url);
    if(u.hostname==='cloud-api.yandex.net'){assert.equal(r.headers.Authorization,'OAuth fixture-token');return response(200,{href:'https://downloader.disk.yandex.ru/file'});}
    assert.equal(r.headers.Authorization,undefined);
    if(u.hostname==='downloader.disk.yandex.ru')return {status:302,headers:{location:'https://storage.yandex.net/file'},body:new Uint8Array()};
    return {status:200,headers:{},body:new Uint8Array([1,2,3])};
  });assert.deepEqual([...await x.disk.read('Главы/1.md')],[1,2,3]);assert.equal(x.calls.length,3);
});
test('untrusted transfer URLs and redirect destinations are blocked',async()=>{
  for(const href of ['https://evil.example/file','http://downloader.disk.yandex.ru/file','https://user:pass@downloader.disk.yandex.ru/file']){
    const x=setup(()=>response(200,{href}));await assert.rejects(x.disk.read('a'));assert.equal(x.calls.length,1);
  }
  const x=setup((r)=>new URL(r.url).hostname==='cloud-api.yandex.net'?response(200,{href:'https://downloader.disk.yandex.ru/file'}):{status:302,headers:{location:'https://evil.example/file'}});
  await assert.rejects(x.disk.read('a'));assert.equal(x.calls.length,2);
});
test('only metadata 404 means absent; transfer failures are errors',async()=>{
  const missing=setup(()=>response(404));assert.equal(await missing.disk.read('a'),null);
  const x=setup((r)=>new URL(r.url).hostname==='cloud-api.yandex.net'?response(200,{href:'https://downloader.disk.yandex.ru/file'}):response(404));await assert.rejects(x.disk.read('a'));
});
test('upload verifies persisted MD5 and keeps token off upload server',async()=>{
  const bytes=new Uint8Array([1,2,3]);const md5=crypto.createHash('md5').update(bytes).digest('hex');
  const x=setup((r)=>{const u=new URL(r.url);
    if(u.hostname==='uploader.disk.yandex.net'){assert.equal(r.headers.Authorization,undefined);assert.deepEqual(r.body,bytes);return response(201);}
    if(r.method==='PUT')return response(201);
    if(u.pathname.endsWith('/upload'))return response(200,{href:'https://uploader.disk.yandex.net/upload'});
    return response(200,{type:'file',md5,size:3});
  });await x.disk.write('Главы/1.md',bytes);
  assert.ok(x.calls.some((r)=>r.method==='GET' && new URL(r.url).searchParams.get('fields')==='type,size,md5'));
});
test('upload without persistence confirmation is not acknowledged',async()=>{
  const x=setup((r)=>{const u=new URL(r.url);if(r.method==='PUT')return response(201);if(u.pathname.endsWith('/upload'))return response(200,{href:'https://uploader.disk.yandex.net/upload'});return response(200,{type:'file',md5:'different'});});
  await assert.rejects(x.disk.write('a',new Uint8Array([1])),/не подтвердил/);
});
test('existing directories must really be directories',async()=>{
  const x=setup((r)=>r.method==='PUT'?response(409):response(200,{type:'file'}));await assert.rejects(x.disk.ensureRoot());
});
test('asynchronous deletion polls operation to success',async()=>{
  let polls=0;const x=setup((r)=>r.method==='DELETE'?response(202,{href:'https://cloud-api.yandex.net/v1/disk/operations/test'}):response(200,{status:++polls===1?'in-progress':'success'}));
  await x.disk.remove('a');assert.equal(polls,2);await assert.rejects(x.disk.remove(''));
});
test('expired credentials make no network request; errors do not leak tokens',async()=>{
  const x=setup(()=>{throw new Error('fixture-token');},{now:()=>Number.MAX_SAFE_INTEGER});await assert.rejects(x.disk.list(''),/истёк/);assert.equal(x.calls.length,0);
  const y=setup(()=>{throw new Error('fixture-token');});await assert.rejects(y.disk.list(''),(e)=>!e.message.includes('fixture-token'));
});
