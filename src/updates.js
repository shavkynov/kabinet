'use strict';

// Проверка новой версии: сравнение номеров и разбор ответа GitHub (releases/latest). Ничего не скачивает и не ставит.

/** «v0.31.2» -> [0,31,2]; null, если это не номер версии. */
function parseVersion(v) {
  const m = /^\s*v?(\d+)\.(\d+)(?:\.(\d+))?/i.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

/** 1, если a новее b; -1, если старее; 0, если равны или не разобрать. */
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

/** Ответ GitHub -> { version, url, notes } или null. Черновики и предварительные выпуски пропускаются. */
function parseRelease(json) {
  if (!json || typeof json !== 'object' || json.draft || json.prerelease) return null;
  const version = String(json.tag_name || json.name || '').trim();
  if (!parseVersion(version)) return null;
  const url = typeof json.html_url === 'string' && /^https:\/\/github\.com\//.test(json.html_url) ? json.html_url : null;
  return { version: version.replace(/^v/i, ''), url, notes: String(json.body || '').trim().slice(0, 1500) };
}

module.exports = { parseVersion, compareVersions, parseRelease };
