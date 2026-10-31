'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../renderer/app/37-yandex.js'),'utf8');
function setup(platform='linux',authorize=async()=>({user:'oauth-yandex:'+'a'.repeat(32),ticket:'fixture-ticket'})){
  const calls=[],shown=[];let folder;
  const el=(tag,cls,text)=>({tag,className:cls,textContent:text,style:{},children:[],append(...nodes){for(const n of nodes){n.parentNode=this;this.children.push(n);}},appendChild(n){this.append(n);return n;},addEventListener(){},querySelectorAll:()=>[]});
  const dialog=el('dialog');const oldLogin=()=>{};
  const c={api:{platform,dav:async(op,...args)=>{calls.push([op,...args]);if(op==='presets')return [{id:'yandex',name:'Яндекс Диск'},{id:'mailru',name:'Mail.ru'},{id:'other',name:'WebDAV'}];if(op==='saved')return [];if(op==='yandexOAuth')return authorize();if(op==='login')return {session:'session',label:'Яндекс Диск'};return true;}},DAV:{},t:(s)=>s,$:()=>dialog,davClose:()=>{},davHome:async()=>{},davStepService:async()=>{},davStepLogin:oldLogin,davStepFolder:async(p)=>{folder=p;},davShow:(...nodes)=>shown.push(nodes),davEl:el,davBtn:(text,click,cls)=>({...el('button',cls,text),click}),showError:(s)=>{throw new Error(s);},Promise,URL};
  vm.createContext(c);vm.runInContext(source,c);
  return {c,calls,shown,oldLogin,folder:()=>folder};
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
