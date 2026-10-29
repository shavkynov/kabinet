'use strict';

// Поисковые системы для пункта «Искать в интернете» (настройка searchEngine). Адреса зашиты в код: наружу открываются только они.

const ENGINES = [
  { id: 'yandex', url: () => 'https://yandex.ru/search/?text=' },
  { id: 'google', url: () => 'https://www.google.com/search?q=' },
  { id: 'duckduckgo', url: () => 'https://duckduckgo.com/?q=' },
  { id: 'bing', url: () => 'https://www.bing.com/search?q=' },
  { id: 'wikipedia', url: (lang) => `https://${lang === 'en' ? 'en' : 'ru'}.wikipedia.org/w/index.php?search=` },
];

function isEngine(id) {
  return ENGINES.some((e) => e.id === id);
}

/** Адрес поиска для слова; null, если слово пустое. Неизвестная система заменяется на Google. */
function searchUrl(engine, text, lang) {
  const q = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!q) return null;
  const e = ENGINES.find((x) => x.id === engine) || ENGINES[1];
  return e.url(lang) + encodeURIComponent(q);
}

module.exports = { ENGINES, isEngine, searchUrl };
