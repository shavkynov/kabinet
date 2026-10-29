'use strict';

// Цветовые темы. Режим (светлый или тёмный) определяет и системные элементы окна; сами цвета лежат в renderer/style.css
// блоками :root[data-theme="…"]. «system», «light» и «dark» оставлены как раньше (совместимость с настройками).

const THEMES = [
  { id: 'light', mode: 'light' },
  { id: 'light-snow', mode: 'light' },
  { id: 'light-sage', mode: 'light' },
  { id: 'light-sand', mode: 'light' },
  { id: 'light-rose', mode: 'light' },
  { id: 'dark', mode: 'dark' },
  { id: 'dark-graphite', mode: 'dark' },
  { id: 'dark-forest', mode: 'dark' },
  { id: 'dark-midnight', mode: 'dark' },
  { id: 'dark-ember', mode: 'dark' },
];

/** Допустимое значение настройки «Тема»: 'system' или id из списка. */
function isTheme(id) {
  return id === 'system' || THEMES.some((t) => t.id === id);
}

/** Режим окна для nativeTheme.themeSource. */
function themeMode(id) {
  const t = THEMES.find((x) => x.id === id);
  return t ? t.mode : 'system';
}

module.exports = { THEMES, isTheme, themeMode };
