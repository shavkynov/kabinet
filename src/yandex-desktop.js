'use strict';
const crypto=require('node:crypto');
const path=require('node:path');
const {fileURLToPath}=require('node:url');
const {createYandexOAuth}=require('./yandex-oauth');
const {createYandexDisk,isOAuthUser,PREFIX}=require('./yandex-disk');
const config=require('./yandex-oauth-config.json');

// Extends the existing DAV session/link interface before main.js loads it.
function installYandexDesktop({electron=require('electron'),webdav=require('./webdav'),davlink=require('./davlink'),makeOAuth=createYandexOAuth}={}) {
  const {app,ipcMain,shell,safeStorage,BrowserWindow}=electron;
  const tickets=new Map(); let pending=null;
  const secure=()=>safeStorage.isEncryptionAvailable() && (process.platform!=='linux' || !safeStorage.getSelectedStorageBackend || safeStorage.getSelectedStorageBackend()!=='basic_text');
  const requireSecure=()=>{if(!secure()) throw new Error('Защищённое хранилище системы недоступно. Подключение Яндекса не сохранено.');};
  const originalDav=webdav.createWebDav;
  webdav.createWebDav=(acc)=>isOAuthUser(acc.user)?createYandexDisk(acc):originalDav(acc);
  const originalBrowse=webdav.browseFolders;
  webdav.browseFolders=async(acc)=>{
    if(!isOAuthUser(acc.user))return originalBrowse(acc);
    const at=acc.path || '';
    const items=await createYandexDisk({...acc,root:at}).list('');
    return items.filter((x)=>x.dir && !x.name.startsWith('.')).map((x)=>({name:x.name,path:'/'+[...at.split('/').filter(Boolean),x.name].join('/')})).sort((a,b)=>a.name.localeCompare(b.name,'ru'));
  };
  const originalLink=davlink.createDavLink;
  davlink.createDavLink=(options)=>{
    const oldSecret=options.secret;
    const secret={...oldSecret,seal:(text)=>{
      let oauth=false; try{oauth=JSON.parse(text)?.kind==='kabinet-yandex-oauth';}catch{}
      if(oauth)requireSecure();
      const sealed=oldSecret.seal(text);
      if(oauth && (!String(sealed).startsWith('enc:') || sealed===text)) throw new Error('Не удалось защитить токен Яндекса.');
      return sealed;
    }};
    const link=originalLink({...options,secret}); const login=link.login;
    link.login=async(acc)=>{
      if(!isOAuthUser(acc.user))return login(acc);
      const t=tickets.get(acc.pass); tickets.delete(acc.pass);
      if(!t || t.user!==acc.user || Date.now()>=t.until)throw new Error('Подключение устарело. Войдите в Яндекс заново.');
      requireSecure();
      return login({...acc,pass:JSON.stringify(t.credentials)});
    };
    return link;
  };
  function trusted(event) {
    try {
      return !event.sender.isDestroyed() && event.senderFrame===event.sender.mainFrame &&
        path.resolve(fileURLToPath(event.senderFrame.url))===path.resolve(app.getAppPath(),'renderer','index.html');
    } catch{return false;}
  }
  function finish(p,error,value) {
    if(pending!==p)return;
    clearTimeout(p.timer); pending=null;
    p.sender.removeListener('destroyed',p.onDestroyed);
    p.flow.cancel();
    if(error)p.reject(error);else p.resolve(value);
  }
  async function receive(raw) {
    const p=pending; if(!p || p.receiving || typeof raw!=='string')return;
    let u;try{u=new URL(raw);}catch{return;}
    const base=new URL(u.href);base.search='';base.hash='';
    if(base.href!==config.callbackUri || u.searchParams.get('state')!==p.state)return;
    p.receiving=true;
    try {
      const token=await p.flow.complete(raw); requireSecure();
      if(pending!==p)return;
      const user=PREFIX+crypto.randomBytes(16).toString('hex');
      const ticket=crypto.randomBytes(32).toString('hex');
      tickets.set(ticket,{user,credentials:{kind:'kabinet-yandex-oauth',...token},until:Date.now()+90000});
      setTimeout(()=>tickets.delete(ticket),90000).unref?.();
      const win=BrowserWindow.fromWebContents(p.sender);
      if(win && !win.isDestroyed()){if(win.isMinimized())win.restore();win.focus();}
      finish(p,null,{user,ticket});
    }catch(e){finish(p,new Error(e.message));}
  }
  app.on('open-url',(event,url)=>{if(typeof url==='string' && url.startsWith('kabinet:')){event.preventDefault();void receive(url);}});
  app.on('second-instance',(_event,argv)=>{for(const arg of argv || [])if(typeof arg==='string' && arg.startsWith('kabinet:'))void receive(arg);});
  app.on('before-quit',()=>{if(pending)finish(pending,new Error('Подключение отменено.'));tickets.clear();});
  ipcMain.handle('dav:yandexOAuth',async(event)=>{
    if(!trusted(event))return {ok:false,error:'Недопустимый источник запроса.'};
    try {
      requireSecure(); if(pending)throw new Error('Вход в Яндекс уже выполняется.');
      const registered=process.defaultApp?app.setAsDefaultProtocolClient('kabinet',process.execPath,[app.getAppPath()]):app.setAsDefaultProtocolClient('kabinet');
      if(!registered)throw new Error('Не удалось настроить возврат. Установите собранный Кабинет и повторите вход.');
      const flow=makeOAuth({request:async({url,method,headers,body,timeoutMs})=>{
        const r=await fetch(url,{method,headers,body,redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
        return {status:r.status,body:new Uint8Array(await r.arrayBuffer())};
      }});
      const url=flow.begin();
      const data=await new Promise((resolve,reject)=>{
        const p={flow,sender:event.sender,resolve,reject,state:new URL(url).searchParams.get('state'),receiving:false};
        p.onDestroyed=()=>finish(p,new Error('Подключение отменено.'));
        p.timer=setTimeout(()=>finish(p,new Error('Время входа истекло. Повторите подключение.')),600000);p.timer.unref?.();
        pending=p;event.sender.once('destroyed',p.onDestroyed);
        Promise.resolve().then(()=>shell.openExternal(url)).catch(()=>finish(p,new Error('Не удалось открыть браузер.')));
      });
      return {ok:true,data};
    }catch(e){return {ok:false,error:e.message};}
  });
  ipcMain.handle('dav:yandexCancel',async(event)=>{
    if(!trusted(event))return {ok:false,error:'Недопустимый источник запроса.'};
    if(pending && pending.sender===event.sender)finish(pending,new Error('Подключение отменено.'));
    return {ok:true,data:true};
  });
}
module.exports={installYandexDesktop};
