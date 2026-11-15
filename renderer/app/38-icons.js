// ---------- свои смайлы для карточек ----------
// Набор из menu.js дополняется смайлами, которые пользователь добавил сам, и теми, что уже стоят на карточках проекта
// (так смайл, поставленный на другом устройстве, сразу есть в наборе и здесь).

// Один «символ» на экране: смайл, составной смайл (семья, профессия) или буква. Не длиннее 16 кодовых единиц,
// как и допускает ядро проекта.
function cleanIcon1(value) {
  const s = String(value || '').trim();
  if (!s || s.length > 16) return null;
  const parts = typeof Intl !== 'undefined' && Intl.Segmenter
    ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)]
    : [...s];
  return parts.length === 1 ? s : null;
}

function cleanIconList(list) {
  const out = [];
  for (const v of list) {
    const i = cleanIcon1(v);
    if (i && !out.includes(i)) out.push(i);
  }
  return out.slice(0, 60);
}

function customIconsFor(kind) {
  const base = new Set([...ICONS_CHARACTER, ...ICONS_PLACE, ...ICONS_ITEM]);
  const used = ['character', 'place', 'item'].flatMap((k) => itemsOf(k).map((c) => c.icon)).filter(Boolean);
  const own = settings.customIcons.filter((i) => !base.has(i));
  const extra = [...new Set([...own, ...used.filter((i) => !base.has(i))])];
  return { own: new Set(own), list: extra };
}

function iconGridEntry(kind, item) {
  const base = kind === 'place' ? ICONS_PLACE : kind === 'item' ? ICONS_ITEM : ICONS_CHARACTER;
  const { own, list } = customIconsFor(kind);
  return {
    icons: [...base, ...list],
    current: item.icon,
    custom: new Set(list),
    onPick: (icon) => setIcon(kind, item.id, icon),
    // «＋»: свой смайл. Вставьте любой смайл с системной клавиатуры (Win+. на Windows, Ctrl+Cmd+Пробел на Mac).
    onAdd: async () => {
      const v = await askText(t('Свой смайл: вставьте один символ'), '');
      if (!v) return;
      const icon = cleanIcon1(v);
      if (!icon) { showError(t('Нужен один смайл или символ.')); return; }
      if (!settings.customIcons.includes(icon)) { settings.customIcons = cleanIconList([...settings.customIcons, icon]); saveSettings(); }
      setIcon(kind, item.id, icon);
    },
    // Shift + клик по своему смайлу убирает его из набора (с карточек, где он стоит, он не пропадает).
    onRemove: (icon) => {
      if (!own.has(icon)) return;
      settings.customIcons = settings.customIcons.filter((i) => i !== icon);
      saveSettings();
    },
  };
}
