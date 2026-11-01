'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {installYandexDesktop}=require('../src/yandex-desktop');
const state='a'.repeat(43);
function setup({secure=true,browserError=false,realCore=false}={}){
  const app=new EventEmitter(),handlers=new Map(),opened=[];let linkOptions;
  app.getAppPath=()=>path.resolve(__dirname,'..');app.setAsDefaultProtocolClient=()=>true;
  const sender=new EventEmitter();sender.isDestroyed=()=>false;sender.mainFrame={url:pathToFileURL(path.join(app.getAppPath(),'renderer/index.html')).href};
  const event={sender,senderFrame:sender.mainFrame};
  const webdav={createWebDav:(x)=>({legacy:x}),browseFolders:async()=>[{name:'legacy'}]};
  const davlink={createDavLink:(o)=>{linkOptions=o;return {login:async(a)=>a};}};
  const makeOAuth=()=>({begin:()=>`https://oauth.yandex.ru/authorize?state=${state}`,cancel:()=>{},complete:async()=>({accessToken:'native-only-fixture',expiresAt:Date.now()+3600000,tokenType:'bearer'})});
  const electron={app,ipcMain:{handle:(k,h)=>handlers.set(k,h)},shell:{openExternal:async(u)=>{opened.push(u);if(browserError)throw new Error('browser');}},safeStorage:{isEncryptionAvailable:()=>secure,getSelectedStorageBackend:()=>secure?'gnome_libsecret':'basic_text'},BrowserWindow:{fromWebContents:()=>null}};
  installYandexDesktop({electron,webdav,davlink,makeOAuth:realCore?require('../src/yandex-oauth').createYandexOAuth:makeOAuth});
  const link=davlink.createDavLink({secret:{seal:(s)=>'enc:'+s,open:(s)=>s.slice(4)}});
  return {app,handlers,event,webdav,link,opened,options:()=>linkOptions};
}
const tick=()=>new Promise((r)=>setImmediate(r));
test('browser callback produces only a one-use ticket; credentials stay main-side',async()=>{
  const x=setup();const task=x.handlers.get('dav:yandexOAuth')(x.event);await tick();
  assert.equal(x.opened.length,1);
  x.app.emit('second-instance',{},[`kabinet://oauth/yandex?code=1234567&state=${state}`]);
  const result=await task;assert.equal(result.ok,true);assert.equal(JSON.stringify(result).includes('native-only-fixture'),false);
  const form={url:'https://webdav.yandex.ru',user:result.data.user,pass:result.data.ticket};
  const acc=await x.link.login(form);assert.equal(JSON.parse(acc.pass).accessToken,'native-only-fixture');
  assert.ok(x.options().secret.seal(acc.pass).startsWith('enc:'));
  await assert.rejects(x.link.login(form));
});
test('foreign state is ignored and owner can cancel pending browser flow',async()=>{
  const x=setup();const task=x.handlers.get('dav:yandexOAuth')(x.event);await tick();
  x.app.emit('second-instance',{},['kabinet://oauth/yandex?code=1234567&state=foreign']);
  const cancel=await x.handlers.get('dav:yandexCancel')(x.event);assert.equal(cancel.ok,true);
  assert.equal((await task).ok,false);
});
test('untrusted frame cannot begin or cancel OAuth',async()=>{
  const x=setup();const event={...x.event,senderFrame:{url:'https://evil.example/'}};
  assert.equal((await x.handlers.get('dav:yandexOAuth')(event)).ok,false);
  assert.equal((await x.handlers.get('dav:yandexCancel')(event)).ok,false);assert.equal(x.opened.length,0);
});
test('no plaintext fallback; browser failure is reported without hanging',async()=>{
  const x=setup({secure:false});assert.equal((await x.handlers.get('dav:yandexOAuth')(x.event)).ok,false);assert.equal(x.opened.length,0);
  const y=setup({browserError:true});assert.equal((await y.handlers.get('dav:yandexOAuth')(y.event)).ok,false);
});
test('legacy accounts retain their original adapter and login',async()=>{
  const x=setup(),acc={user:'legacy',pass:'old'};
  assert.deepEqual(x.webdav.createWebDav(acc),{legacy:acc});assert.deepEqual(await x.link.login(acc),acc);
});
test('macOS open-url follows the same callback route',async()=>{
  const x=setup();const task=x.handlers.get('dav:yandexOAuth')(x.event);await tick();let prevented=false;
  x.app.emit('open-url',{preventDefault:()=>{prevented=true;}},`kabinet://oauth/yandex?code=1234567&state=${state}`);
  assert.equal((await task).ok,true);assert.equal(prevented,true);
});

test('real PKCE core exchanges callback through bridge without exposing token to renderer',async(t)=>{
  t.mock.method(global,'fetch',async(url,options)=>{
    assert.equal(url,'https://oauth.yandex.ru/token');assert.equal(options.redirect,'error');
    const form=new URLSearchParams(new TextDecoder().decode(options.body));
    assert.equal(form.get('code'),'1234567');assert.equal(form.has('client_secret'),false);
    assert.equal(form.get('code_verifier').length,43);
    return new Response(JSON.stringify({access_token:'integration-fixture',token_type:'bearer',expires_in:3600}),{status:200});
  });
  const x=setup({realCore:true});const task=x.handlers.get('dav:yandexOAuth')(x.event);await tick();
  const state=new URL(x.opened[0]).searchParams.get('state');
  x.app.emit('second-instance',{},[`kabinet://oauth/yandex?code=1234567&state=${state}`]);
  const result=await task;assert.equal(result.ok,true);assert.equal(JSON.stringify(result).includes('integration-fixture'),false);
  const acc=await x.link.login({user:result.data.user,pass:result.data.ticket});
  assert.equal(JSON.parse(acc.pass).accessToken,'integration-fixture');
});
