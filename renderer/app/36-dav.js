// ---------- «Синхронизация…»: проект в облаке или сетевой папке (WebDAV) ----------
// Окно ведёт по шагам: сервис → логин и пароль → папка → готово. Запросы к серверу выполняет главный процесс
// (api.dav('…')), пароль окну не отдаётся: после входа остаётся только номер сеанса.

function davEl(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function davBtn(text, onClick, cls = 'secondary') {
  const b = davEl('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function davShow(...nodes) {
  const body = $('#syncBody');
  body.textContent = '';
  body.append(...nodes);
  const first = body.querySelector('input, button.primary');
  if (first) first.focus();
}

function davClose() {
  const dlg = $('#syncDialog');
  if (dlg.open) dlg.close();
}

function davFail(box, err) {
  box.textContent = tdom(String((err && err.message) || err));
  box.hidden = false;
}

async function openSyncDialog(mode) {
  const dlg = $('#syncDialog');
  if (!dlg.open) dlg.showModal();
  if (mode === 'open') { DAV.mode = 'open'; await davStepService(); return; }
  await davHome();
}

// ----- главная страница -----
async function davHome() {
  let st = { linked: false };
  try { st = await api.dav('status'); } catch { /* покажем как «не подключено» */ }
  const nodes = [davEl('h2', '', t('Синхронизация'))];
  const actions = davEl('div', 'dialog-actions');
  if (st.linked) {
    nodes.push(davEl('p', 'sync-line', t('Проект синхронизируется с «{0}», папка {1}.', st.label, st.root)));
    let line = t('Ещё не обновлялось.');
    if (st.error) line = t('Ошибка: {0}', tdom(st.error));
    else if (st.busy) line = t('Идёт обмен…');
    else if (st.lastSync) line = t('Обновлено: {0}', new Date(st.lastSync).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' }));
    const status = davEl('p', st.error ? 'sync-line err' : 'sync-line muted', line);
    nodes.push(status);
    if (st.conflict) nodes.push(davEl('p', 'hint', t('Был конфликт: чужая версия текста лежит в папке «Конфликты» проекта.')));
    nodes.push(davEl('p', 'hint', t('Правки уходят в облако сами через несколько секунд после изменения. Чужие подтягиваются раз в полминуты.')));
    actions.append(
      davBtn(t('Как это работает'), () => api.dav('info').catch((e) => showError(e.message))),
      davBtn(t('Отключить'), async () => {
        if (!confirm(t('Отключить синхронизацию? Файлы в облаке и на компьютере останутся, они просто перестанут обновляться.'))) return;
        try { await flush(); await api.dav('detach'); setStatus('ok', t('Синхронизация отключена')); davClose(); } catch (e) { showError(e.message); }
      }),
      davBtn(t('Синхронизировать сейчас'), async (ev) => {
        ev.target.disabled = true;
        try { await flush(); await api.dav('syncNow'); } catch (e) { showError(e.message); }
        await davHome();
      }, 'primary'),
    );
  } else {
    nodes.push(davEl('p', 'sync-line', project
      ? t('Проект лежит только на этом компьютере. Его копию можно хранить в облаке (Яндекс Диск, Mail.ru, Nextcloud и другие) и открывать на телефоне и других компьютерах.')
      : t('Проект, который лежит в облаке, можно открыть здесь: он скопируется на этот компьютер и будет синхронизироваться.')));
    nodes.push(davEl('p', 'hint', t('Нужны логин и пароль приложения от облака: подсказка появится на следующем шаге.')));
    actions.append(
      davBtn(t('Как это работает'), () => api.dav('info').catch((e) => showError(e.message))),
      davBtn(t('Закрыть'), davClose),
      davBtn(t('Открыть из облака…'), () => { DAV.mode = 'open'; davStepService(); }),
    );
    if (project) actions.append(davBtn(t('Подключить облако…'), () => { DAV.mode = 'link'; davStepService(); }, 'primary'));
  }
  nodes.push(actions);
  davShow(...nodes);
}

// ----- шаг 1: сервис -----
async function davStepService() {
  let presets = [];
  let saved = [];
  try {
    presets = await api.dav('presets');
    saved = await api.dav('saved');
  } catch (e) { showError(e.message); return; }
  const list = davEl('div', 'sync-list');
  for (const s of saved) {
    list.append(davBtn(`${s.label}: ${s.user}`, async () => {
      try {
        const r = await api.dav('useSaved', s.index);
        DAV.session = r.session;
        DAV.label = r.label;
        await davStepFolder('/');
      } catch (e) { showError(e.message); }
    }, 'sync-row primary'));
  }
  for (const p of presets) list.append(davBtn(saved.length ? `+ ${t(p.name)}` : t(p.name), () => davStepLogin(p), 'sync-row secondary'));
  davShow(
    davEl('h2', '', DAV.mode === 'open' ? t('Открыть проект из облака') : t('Где хранить проект?')),
    davEl('p', 'hint', saved.length ? t('Можно войти заново или выбрать уже сохранённый вход.') : t('Выберите облако или сервер.')),
    list,
    davEl('div', 'dialog-actions').appendChild(davBtn(t('Назад'), davHome)).parentNode,
  );
}

// ----- шаг 2: логин и пароль -----
function davStepLogin(preset) {
  const form = davEl('form', 'sync-form');
  const fields = {};
  const add = (key, label, type, ph) => {
    const wrap = davEl('label', '', label);
    const input = davEl('input');
    input.type = type;
    input.autocomplete = key === 'pass' ? 'current-password' : 'off';
    if (ph) input.placeholder = ph;
    wrap.append(input);
    form.append(wrap);
    fields[key] = input;
  };
  if (!preset.url) add('url', t('Адрес сервера'), 'text', 'https://…');
  add('user', t('Логин'), 'text');
  add('pass', t('Пароль приложения'), 'password');
  const err = davEl('p', 'sync-line err');
  err.hidden = true;
  const submit = davEl('button', 'primary', t('Войти'));
  submit.type = 'submit';
  const actions = davEl('div', 'dialog-actions');
  actions.append(davBtn(t('Назад'), davStepService), submit);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.hidden = true;
    if (!fields.user.value.trim() || !fields.pass.value) { davFail(err, new Error(t('Введите логин и пароль.'))); return; }
    submit.disabled = true;
    submit.textContent = t('Проверяю…');
    try {
      const r = await api.dav('login', { preset: preset.id, url: fields.url ? fields.url.value : '', user: fields.user.value.trim(), pass: fields.pass.value });
      DAV.session = r.session;
      DAV.label = r.label;
      await davStepFolder('/');
    } catch (e) {
      davFail(err, e);
      submit.disabled = false;
      submit.textContent = t('Войти');
    }
  });
  davShow(davEl('h2', '', t(preset.name)), davEl('p', 'hint', t(preset.hint)), form, err, actions);
  $('#syncBody').querySelector('input').focus();
  // кнопка «Войти» вне формы: связываем через form=
  const id = 'davForm';
  form.id = id;
  submit.setAttribute('form', id);
}

// ----- шаг 3: папка -----
async function davStepFolder(at) {
  let res;
  try {
    res = await api.dav('browse', DAV.session, at);
  } catch (e) {
    showError(e.message);
    await davStepService();
    return;
  }
  const here = res.path || '/';
  const nodes = [
    davEl('h2', '', DAV.mode === 'open' ? t('Где лежит проект?') : t('Выберите папку')),
    davEl('p', 'sync-line muted', t('{0}: {1}', DAV.label, here)),
  ];
  const err = davEl('p', 'sync-line err');
  err.hidden = true;
  const main = davEl('div', 'sync-main');
  if (DAV.mode === 'link' && here === '/') {
    const name = String((project && project.name) || t('Проект')).replace(/[\\/:*?"<>|]/g, '-');
    main.append(davBtn(t('Создать «Кабинет/{0}» (рекомендуется)', name), async () => {
      try {
        const root = await api.dav('mkdir', DAV.session, '/Кабинет', name);
        await davAttach(root, 'ask');
      } catch (e) { davFail(err, e); }
    }, 'sync-row primary'));
  }
  if (here !== '/') {
    main.append(davBtn(DAV.mode === 'open' ? t('Открыть проект из этой папки') : t('Сохранять проект в этой папке'), async () => {
      try {
        if (DAV.mode === 'open') await davOpen(here);
        else await davAttach(here, 'ask');
      } catch (e) { davFail(err, e); }
    }, 'sync-row primary'));
  }
  nodes.push(main);
  const list = davEl('div', 'sync-list');
  if (here !== '/') list.append(davBtn(`↑ ${t('На уровень выше')}`, () => davStepFolder(`/${here.split('/').filter(Boolean).slice(0, -1).join('/')}`), 'sync-row secondary'));
  for (const f of res.folders) list.append(davBtn(`📁 ${f.name}`, () => davStepFolder(f.path), 'sync-row secondary'));
  if (!res.folders.length) list.append(davEl('p', 'hint', t('Вложенных папок нет.')));
  nodes.push(list, err);
  const actions = davEl('div', 'dialog-actions');
  actions.append(davBtn(t('Назад'), davStepService));
  if (DAV.mode === 'link') {
    actions.append(davBtn(t('Новая папка…'), async () => {
      const name = await askText(t('Название папки'), 'Кабинет');
      if (!name) return;
      try { await davStepFolder(await api.dav('mkdir', DAV.session, here, name)); } catch (e) { davFail(err, e); }
    }));
  }
  nodes.push(actions);
  davShow(...nodes);
}

async function davAttach(root, mode) {
  await flush();
  const res = await api.dav('attach', DAV.session, root, mode);
  if (res.exists && !res.status) {
    davShow(
      davEl('h2', '', t('В этой папке уже есть проект')),
      davEl('p', 'sync-line', t('«Соединить»: правки с обеих сторон сохранятся, спорные тексты уйдут в папку «Конфликты». «Заменить папку»: в облако запишется проект с этого компьютера, а то, что там лежало, попадёт в «Конфликты» и не пропадёт.')),
      (() => {
        const actions = davEl('div', 'dialog-actions');
        actions.append(
          davBtn(t('Назад'), () => davStepFolder('/')),
          davBtn(t('Заменить папку'), () => davAttach(root, 'replace').catch((e) => showError(e.message))),
          davBtn(t('Соединить'), () => davAttach(root, 'merge').catch((e) => showError(e.message)), 'primary'),
        );
        return actions;
      })(),
    );
    return;
  }
  davClose();
  setStatus('ok', t('Синхронизация включена'));
}

async function davOpen(root) {
  await flush();
  const proj = await api.dav('open', DAV.session, root);
  if (!proj) return; // отказались выбирать место на компьютере
  davClose();
  enterProject(proj);
}

function wireDav() {
  api.onOpenSync(() => openSyncDialog());
  api.onDavEvent((e) => {
    if (!e) return;
    if (e.type === 'conflict') setStatus('error', t('Этот текст изменили на другом устройстве. Чужая версия сохранена в папке «Конфликты».'));
    else if (e.type === 'error' && e.message !== DAV.lastError) {
      DAV.lastError = e.message;
      setStatus('error', t('Синхронизация: {0}', tdom(e.message)));
    } else if (e.type === 'error') DAV.lastError = e.message;
  });
  $('#btnOpenCloud').addEventListener('click', () => openSyncDialog('open'));
}
