'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {createSingleFlight}=require('../src/single-flight');
const rawSource=fs.readFileSync(path.join(__dirname,'../renderer/app/37-yandex.js'),'utf8');
function loadVmSource(raw){
  const normalized=raw.replace(/\r\n?/g,'\n');
  const importLine="import { createSingleFlight } from '../src/single-flight.js';\n";
  assert.ok(normalized.startsWith(importLine),'Expected the explicit single-flight import');
  return normalized.slice(importLine.length);
}
const source=loadVmSource(rawSource);
function setup(platform='linux',authorize=async()=>({user:'oauth-yandex:'+'a'.repeat(32),ticket:'fixture-ticket'}),actions={}){
  const calls=[],shown=[],errors=[];let folder;
  const el=(tag,cls,text)=>({tag,className:cls,textContent:text,disabled:false,style:{},children:[],attributes:{},listeners:{},
    append(...nodes){for(const n of nodes){n.parentNode=this;this.children.push(n);}},appendChild(n){this.append(n);return n;},
    addEventListener(name,fn){this.listeners[name]=fn;},setAttribute(k,v){this.attributes[k]=v;},getAttribute(k){return this.attributes[k]??null;},removeAttribute(k){delete this.attributes[k];},
    querySelectorAll(selector){const out=[];const visit=(e)=>{for(const c of e.children){if(c.tag===selector)out.push(c);visit(c);}};visit(this);return out;}});
  const dialog=el('dialog'),body=el('div');dialog.append(body);const oldLogin=()=>{};
  const c={createSingleFlight,api:{platform,dav:async(op,...args)=>{calls.push([op,...args]);if(op==='presets')return [{id:'yandex',name:'Яндекс Диск'},{id:'mailru',name:'Mail.ru'},{id:'other',name:'WebDAV'}];if(op==='saved')return [];if(op==='yandexOAuth')return authorize();if(op==='login')return {session:'session',label:'Яндекс Диск'};return true;}},DAV:{},t:(s)=>s,$:(s)=>s==='#syncDialog'?dialog:body,davClose:()=>{},davHome:async()=>{},davStepService:async()=>{},davStepLogin:oldLogin,
    davAttach:async(...args)=>actions.attach?.(...args),davOpen:async(...args)=>actions.open?.(...args),
    davStepFolder:async(p)=>{folder=p;},davShow:(...nodes)=>{shown.push(nodes);body.children=[];body.append(...nodes);},davEl:el,davBtn:(text,click,cls)=>({...el('button',cls,text),click}),showError:(s)=>errors.push(s),Promise,URL};
  vm.createContext(c);vm.runInContext(source,c);
  return {c,calls,shown,errors,dialog,body,oldLogin,folder:()=>folder};
}
test('desktop list disables all providers except Yandex',async()=>{
  const x=setup();await x.c.davStepService();
  const list=x.shown.at(-1).find((n)=>n.className==='sync-list');
  assert.equal(list.children[0].disabled,false);
  for(const b of list.children.slice(1)){assert.equal(b.disabled,true);assert.ok(b.textContent.includes('Временно недоступно'));}
});
test('desktop sign-in uses opaque ticket and proceeds to folder selection',async()=>{
  const x=setup();await x.c.davStepLogin({id:'yandex'});
  assert.equal(x.folder(),'/');const call=x.calls.find((r)=>r[0]==='login');assert.equal(call[1].pass,'fixture-ticket');assert.equal(x.c.DAV.session,'session');
});
test('closing the dialog discards a late authorization response',async()=>{
  let finish;const x=setup('linux',()=>new Promise((r)=>{finish=r;}));
  const task=x.c.davStepLogin({id:'yandex'});x.c.davClose();finish({user:'user',ticket:'ticket'});await task;
  assert.equal(x.calls.some((r)=>r[0]==='login'),false);
});
test('Android UI is not overridden by the desktop extension',()=>{
  const x=setup('android');assert.equal(x.c.davStepLogin,x.oldLogin);assert.equal(x.calls.length,0);
});
test('repeated click invokes action once and restores button label',async()=>{
  const x=setup();let finish,count=0;const b=x.c.davBtn('Original',()=>{count++;return new Promise((r)=>{finish=r;});});
  const first=b.click();assert.equal(b.disabled,true);assert.equal(b.textContent,'Идёт обмен…');
  await b.click();assert.equal(count,1);finish();await first;assert.equal(b.disabled,false);assert.equal(b.textContent,'Original');
});
test('button becomes usable after a rejected action',async()=>{
  const x=setup();let count=0;const b=x.c.davBtn('Retry',async()=>{count++;throw new Error('failure');});
  await b.click();assert.equal(b.disabled,false);assert.equal(b.textContent,'Retry');assert.deepEqual(x.errors,['failure']);
  await b.click();assert.equal(count,2);
});
test('attachment blocks navigation and escape until completion without enabling unavailable buttons',async()=>{
  let finish;const x=setup('linux',undefined,{attach:()=>new Promise((r)=>{finish=r;})});
  let navigations=0;const nav=x.c.davBtn('Back',()=>{navigations++;}),unavailable=x.c.davBtn('Unavailable',()=>{});unavailable.disabled=true;x.body.append(nav,unavailable);
  const first=x.c.davAttach('/folder','ask');assert.equal(nav.disabled,true);assert.equal(x.dialog.getAttribute('aria-busy'),'true');
  await nav.click();assert.equal(navigations,0);await assert.rejects(x.c.davOpen('/other'));
  let prevented=false;x.dialog.listeners.cancel({preventDefault:()=>{prevented=true;}});assert.equal(prevented,true);
  finish();await first;assert.equal(nav.disabled,false);assert.equal(unavailable.disabled,true);assert.equal(x.dialog.getAttribute('aria-busy'),null);
});
test('repeated service-button click starts one browser authorization and keeps cancel usable',async()=>{
  let finish;const x=setup('linux',()=>new Promise((r)=>{finish=r;}));await x.c.davStepService();
  const list=x.shown.at(-1).find((n)=>n.className==='sync-list'),button=list.children[0];
  const first=button.click();await button.click();assert.equal(x.calls.filter((r)=>r[0]==='yandexOAuth').length,1);
  const cancel=x.shown.at(-1).at(-1).children[0];assert.equal(cancel.disabled,false);
  finish({user:'user',ticket:'ticket'});await first;
});

for(const [name,eol] of [['LF','\n'],['CRLF','\r\n']]){
  test(`VM source loader accepts ${name} line endings`,()=>{
    const fixture=rawSource.replace(/\r\n?/g,'\n').replace(/\n/g,eol);
    const loaded=loadVmSource(fixture);
    assert.equal(loaded,source);
    assert.doesNotThrow(()=>new vm.Script(loaded));
  });
}
