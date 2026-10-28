// ---------- свои шрифты ----------

function fillFontSelect() {
  const sel = $('#setFont');
  const builtIn = [
    ['iowan', 'Iowan Old Style'],
    ['palatino', 'Palatino'],
    ['georgia', 'Georgia'],
    ['times', 'Times New Roman'],
    ['typewriter', 'American Typewriter'],
    ['courier', 'Courier New'],
    ['sans', 'Системный без засечек'],
  ];
  sel.textContent = '';
  for (const [value, label] of builtIn) sel.append(new Option(label, value));
  if (customFonts.size > 0) {
    const group = document.createElement('optgroup');
    group.label = 'Мои шрифты';
    for (const [key, family] of customFonts) group.append(new Option(family, key));
    sel.append(group);
  }
}

// Регистрируем файлы шрифтов прямо из памяти: так не нужны ни пути, ни разрешения.
async function loadCustomFonts() {
  let list = [];
  try {
    list = await api.listFonts();
  } catch (err) {
    console.error('fonts:', err);
  }
  for (const f of document.fonts) {
    if (f.family.startsWith('"Кабинет: ') || f.family.startsWith('Кабинет: ')) document.fonts.delete(f);
  }
  customFonts.clear();
  for (const f of list) {
    const family = `Кабинет: ${f.family}`;
    try {
      const face = new FontFace(family, f.data);
      await face.load();
      document.fonts.add(face);
      customFonts.set(`custom:${f.file}`, family);
    } catch (err) {
      console.error('Не удалось загрузить шрифт', f.file, err);
    }
  }
  fillFontSelect();
}

async function addFontsFromFiles() {
  try {
    const added = await api.addFonts();
    if (!added || added.length === 0) return;
    await loadCustomFonts();
    const key = `custom:${added[added.length - 1]}`;
    if (customFonts.has(key)) settings.font = key;
    applySettings();
    saveSettings();
  } catch (err) {
    showError(err.message);
  }
}

async function removeCurrentFont() {
  if (!settings.font.startsWith('custom:')) return;
  const file = settings.font.slice('custom:'.length);
  try {
    await api.removeFont(file);
    settings.font = DEFAULT_SETTINGS.font;
    await loadCustomFonts();
    applySettings();
    saveSettings();
  } catch (err) {
    showError(err.message);
  }
}

