// ---------- свои звуки: эмбиент и клавиши ----------
// Файлы лежат в userData/sounds/<ambient|keys>/<вариант>/. Список файлов приходит из main,
// сами записи читаются и раскодируются только когда они нужны (эмбиент бывает большим).

const KEY_KINDS = { key: 'Буквы', space: 'Пробел', backspace: 'Delete', enter: 'Enter' };
let soundFiles = {};          // 'ambient/rain' -> ['rain.mp3', ...]
const soundBufCache = new Map();
let ambientListOpen = false;  // раскрыт ли список под выбранным эмбиентом
let keySlotOpen = null;       // для какой клавиши раскрыт список

function getSoundBuffer(slot, file) {
  const key = `${slot}/${file}`;
  if (!soundBufCache.has(key)) {
    soundBufCache.set(key, api.readSound(slot, file).then((data) => sounds.decode(data)).catch((err) => {
      soundBufCache.delete(key);
      throw err;
    }));
  }
  return soundBufCache.get(key);
}

async function loadSounds() {
  try {
    soundFiles = await api.listSounds();
  } catch (err) {
    console.error('sounds:', err);
    soundFiles = {};
  }
  // выбранного файла больше нет (его удалили): возвращаем встроенный звук
  for (const v of Object.keys(AMBIENTS)) {
    const f = settings.ambientSrc[v];
    if (f && f !== 'default' && !(soundFiles[`ambient/${v}`] || []).includes(f)) delete settings.ambientSrc[v];
  }
  for (const k of Object.keys(KEY_KINDS)) {
    const f = settings.keySrc[k];
    const files = soundFiles[`keys/${k}`] || [];
    if (f && f !== 'default' && f !== '*' && !files.includes(f)) delete settings.keySrc[k];
    const items = [];
    for (const file of files) {
      try { items.push({ file, buffer: await getSoundBuffer(`keys/${k}`, file) }); } catch (err) { console.error('sound:', file, err); }
    }
    sounds.setKeyFiles(k, items);
  }
  applySettings();
  renderMySounds();
}

const soundLabel = (file) => file.replace(/\.[^.]+$/, '');

function renderSrcList(box, { slot, current, def, allLabel, onPick }) {
  const files = soundFiles[slot] || [];
  box.textContent = '';
  const row = (value, label, deletable) => {
    const r = document.createElement('div');
    r.className = `src-row${current === value ? ' on' : ''}`;
    const name = document.createElement('span');
    name.className = 'src-name';
    name.textContent = label;
    if (deletable) name.setAttribute('translate', 'no');
    r.append(name);
    r.addEventListener('click', () => onPick(value));
    if (deletable) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'src-del';
      del.textContent = '×';
      del.title = 'Убрать из программы (ваш исходный файл не удаляется)';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(t('Убрать «{0}» из программы?', soundLabel(value)))) return;
        try {
          await api.removeSound(slot, value);
          soundBufCache.delete(`${slot}/${value}`);
          await loadSounds();
          saveSettings();
        } catch (err) {
          showError(err.message);
        }
      });
      r.append(del);
    }
    box.append(r);
  };
  row('default', def, false);
  if (allLabel && files.length >= 2) row('*', allLabel, false);
  for (const f of files) row(f, soundLabel(f), true);
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'secondary small src-add';
  add.textContent = 'Загрузить…';
  add.addEventListener('click', async () => {
    try {
      const added = await api.addSounds(slot);
      if (!added.length) return;
      await loadSounds();
      onPick(added[0]);
    } catch (err) {
      showError(err.message);
    }
  });
  box.append(add);
}

function renderMySounds() {
  const aBox = $('#ambientSrc');
  aBox.hidden = !ambientListOpen;
  if (ambientListOpen) {
    const v = settings.ambient;
    renderSrcList(aBox, {
      slot: `ambient/${v}`,
      current: settings.ambientSrc[v] || 'default',
      def: t('Встроенный звук'),
      onPick: (value) => {
        settings.ambientSrc[v] = value;
        settings.ambientOn = true;
        applySettings();
        saveSettings();
        renderMySounds();
      },
    });
  }

  document.querySelectorAll('#chipKeySlots button').forEach((b) => b.classList.toggle('active', b.dataset.value === keySlotOpen));
  const kBox = $('#keySrc');
  kBox.hidden = !keySlotOpen;
  if (keySlotOpen) {
    const k = keySlotOpen;
    renderSrcList(kBox, {
      slot: `keys/${k}`,
      current: settings.keySrc[k] || 'default',
      def: t('Встроенный звук'),
      allLabel: t('Все загруженные вперемешку'),
      onPick: (value) => {
        settings.keySrc[k] = value;
        settings.soundOn = true;
        applySettings();
        saveSettings();
        renderMySounds();
        sounds.play(k);
      },
    });
  }
}
