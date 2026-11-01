'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {createSingleFlight}=require('../src/single-flight');
const source=fs.readFileSync(path.join(__dirname,'../src/davlink.js'),'utf8');
const tick=()=>new Promise((r)=>setImmediate(r));
function setup(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kab-dav-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const state={exports:0,imports:0,syncs:0,created:0,intervals:0,exists:false,ensureError:null,probeError:null,exportTask:()=>Promise.resolve(),syncTask:()=>Promise.resolve({pulled:[],conflicts:[]})};
  const adapter={ensureRoot:async()=>{if(state.ensureError)throw state.ensureError;},read:async()=>null,write:async()=>{},remove:async()=>{}};
  const folders={isSyncable:()=>true,createFolderSync:()=>{state.created++;return{hasProject:async()=>{if(state.probeError)throw state.probeError;return state.exists;},exportAll:async()=>{state.exports++;return state.exportTask();},sync:async()=>{state.syncs++;return state.syncTask();},replaceAll:async()=>{},importAll:async()=>{state.imports++;}};}};
  const mod={exports:{}};
  const deps={'fs':{...fs,watch:()=>({on(){},close(){}})},'./webdav':{createWebDav:()=>adapter,normalizeUrl:(s)=>s,browseFolders:async()=>[]},'./folder':folders,'./cloud':{LOCK_FILE:'kabinet.lock'},'./fsutil':{writeFileAtomic:(p,s)=>fs.writeFileSync(p,s)},'./single-flight':{createSingleFlight}};
  vm.runInNewContext(source,{module:mod,exports:mod.exports,require:(id)=>deps[id]||require(id),console,TextEncoder,TextDecoder,
    setInterval:()=>{state.intervals++;return{unref(){}};},clearInterval:()=>{},
    setTimeout:(fn,ms)=>ms===50||ms===100?setTimeout(fn,ms):{unref(){}},clearTimeout:()=>{}});
  const link=mod.exports.createDavLink({dataDir:dir,request:async()=>{throw new Error('Unexpected network request');}});
  t.after(()=>link.stopWork());
  const acc={url:'https://example.org',user:'user',pass:'fixture',root:'/new',label:'Cloud'};
  return{dir,link,acc,state};
}
test('single-flight rejects duplicates and releases after success and failure',async()=>{
  const gate=createSingleFlight();let finish;const first=gate.run(()=>new Promise((r)=>{finish=r;}));
  await assert.rejects(gate.run(()=>{}),(e)=>e.code==='OPERATION_IN_PROGRESS');finish(1);assert.equal(await first,1);assert.equal(gate.busy,false);
  await assert.rejects(gate.run(()=>{throw new Error('failure');}));assert.equal(gate.busy,false);assert.equal(await gate.run(()=>2),2);
});
test('initial export finishes before background sync is constructed or timers start',async(t)=>{
  const x=setup(t);let finish;x.state.exportTask=()=>new Promise((r)=>{finish=r;});
  const first=x.link.attach(x.dir,x.acc);await tick();
  assert.equal(x.state.exports,1);assert.equal(x.state.created,1);assert.equal(x.state.intervals,0);assert.equal(x.link.status(x.dir).linked,false);
  await assert.rejects(x.link.attach(x.dir,x.acc),(e)=>e.code==='OPERATION_IN_PROGRESS');
  await assert.rejects(x.link.syncNow());finish();const result=await first;
  assert.equal(result.status.linked,true);assert.equal(x.state.exports,1);assert.equal(x.state.created,2);assert.equal(x.state.intervals,2);
});
test('probe failures never become permission to export into an allegedly empty folder',async(t)=>{
  const x=setup(t);x.state.probeError=new Error('423');await assert.rejects(x.link.attach(x.dir,x.acc),/423/);
  assert.equal(x.state.exports,0);assert.equal(x.state.intervals,0);assert.equal(x.link.status(x.dir).linked,false);
});
test('failed first export leaves no linked project and can be retried',async(t)=>{
  const x=setup(t);x.state.exportTask=()=>Promise.reject(new Error('upload failed'));
  await assert.rejects(x.link.attach(x.dir,x.acc),/upload failed/);assert.equal(x.link.status(x.dir).linked,false);assert.equal(x.state.intervals,0);
  x.state.exportTask=()=>Promise.resolve();await x.link.attach(x.dir,x.acc);assert.equal(x.link.status(x.dir).linked,true);
});
test('existing project in ask mode is not exported or linked',async(t)=>{
  const x=setup(t);x.state.exists=true;const result=await x.link.attach(x.dir,x.acc);
  assert.equal(result.exists,true);assert.equal(x.state.exports,0);assert.equal(x.state.intervals,0);assert.equal(x.link.status(x.dir).linked,false);
});
test('reconfiguration waits for an already running sync',async(t)=>{
  const x=setup(t);await x.link.attach(x.dir,x.acc);let finish;
  x.state.syncTask=()=>new Promise((r)=>{finish=r;});const sync=x.link.syncNow();await tick();
  let made=false;x.state.exportTask=()=>Promise.resolve();const folder=x.link.makeFolder(x.acc,'/','next').then(()=>{made=true;});await tick();
  assert.equal(made,false);finish({pulled:[],conflicts:[]});await sync;await folder;assert.equal(made,true);
});
test('failed reattachment restores previous persisted connection',async(t)=>{
  const x=setup(t);await x.link.attach(x.dir,{...x.acc,root:'/old'});
  x.state.ensureError=new Error('busy');await assert.rejects(x.link.attach(x.dir,x.acc),/busy/);
  assert.equal(x.link.status(x.dir).root,'/old');assert.equal(x.link.status(x.dir).linked,true);
});
