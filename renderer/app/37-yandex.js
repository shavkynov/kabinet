// Desktop-only OAuth; Android keeps its native connection flow until its SDK integration.
if (['win32','darwin','linux'].includes(api.platform)) {
  let yandexRun=0;
  const oauthUser=(s)=>typeof s==='string' && s.startsWith('oauth-yandex:');
  const cancelYandex=()=>{yandexRun++;void api.dav('yandexCancel').catch(()=>{});};
  const oldClose=davClose;
  davClose=()=>{cancelYandex();oldClose();};
  $('#syncDialog')?.addEventListener('close',cancelYandex);
  const oldHome=davHome;
  davHome=async()=>{
    await oldHome();
    for(const el of $('#syncBody').querySelectorAll('p')) {
      if(el.textContent===t('Нужны логин и пароль приложения от облака: подсказка появится на следующем шаге.'))el.textContent=t('Вход в Яндекс откроется в вашем браузере. Пароль вводится только на сайте Яндекса.');
      if(el.textContent===t('Проект лежит только на этом компьютере. Его копию можно хранить в облаке (Яндекс Диск, Mail.ru, Nextcloud и другие) и открывать на телефоне и других компьютерах.'))el.textContent=t('Подключите Яндекс Диск, чтобы хранить копию проекта в облаке. Остальные сервисы временно недоступны.');
    }
  };
  davStepService=async()=>{
    cancelYandex();
    let presets,saved;
    try{[presets,saved]=await Promise.all([api.dav('presets'),api.dav('saved')]);}catch(e){showError(e.message);return;}
    saved=saved.filter((s)=>{try{return new URL(s.url).hostname==='webdav.yandex.ru';}catch{return false;}});
    const list=davEl('div','sync-list');
    for(const s of saved)list.append(davBtn(oauthUser(s.user)?`${t('Яндекс Диск — сохранённое подключение')} ${s.index+1}`:`${s.label}: ${s.user}`,async()=>{
      try{const r=await api.dav('useSaved',s.index);DAV.session=r.session;DAV.label=r.label;await davStepFolder('/');}catch(e){showError(e.message);}
    },'sync-row primary'));
    for(const p of presets){
      const active=p.id==='yandex';
      const b=davBtn(active?t('Подключить Яндекс Диск'):`${t(p.name)} — ${t('Временно недоступно')}`,()=>{if(active)void davStepLogin(p);},'sync-row secondary');
      b.disabled=!active;if(!active)b.style.opacity='0.5';list.append(b);
    }
    davShow(davEl('h2','',t('Синхронизация')),davEl('p','hint',t('Подтвердите доступ на сайте Яндекса, затем выберите папку проекта в Кабинете.')),list,
      davEl('div','dialog-actions').appendChild(davBtn(t('Назад'),davHome)).parentNode);
  };
  davStepLogin=async(preset)=>{
    if(preset.id!=='yandex')return;
    const run=++yandexRun;
    davShow(davEl('h2','',t('Подключение Яндекс Диска')),davEl('p','sync-line',t('Завершите вход в браузере. Затем нажмите «Вернуться в Кабинет».')),
      davEl('div','dialog-actions').appendChild(davBtn(t('Отмена'),()=>{cancelYandex();void davStepService();})).parentNode);
    try{
      const auth=await api.dav('yandexOAuth');if(run!==yandexRun)return;
      const r=await api.dav('login',{preset:'yandex',user:auth.user,pass:auth.ticket});if(run!==yandexRun)return;
      DAV.session=r.session;DAV.label=r.label;await davStepFolder('/');
    }catch(e){if(run===yandexRun){showError(e.message);await davStepService();}}
  };
}
