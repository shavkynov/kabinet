'use strict';
// Слияние project.json, когда он разошёлся на двух устройствах: побеждает наш, но то, что появилось на другом
// устройстве (главы, карточки, заметки, слова словаря), не теряется. Файлы глав и карточек при этом приходят отдельно,
// без записи в списке они выглядели бы «найденными» и теряли название.

const dict = require('./dict');

const LISTS = ['chapters', 'characters', 'places', 'items', 'notes'];

function parse(bytes) {
  try {
    const v = JSON.parse(Buffer.from(bytes).toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

/**
 * Возвращает новый текст нашего project.json или null, если сливать нечего.
 * Запись с чужого устройства добавляется, если её id у нас нет ни в списках, ни в корзине (удалённое нами не воскрешаем).
 * Остальное (названия, цели, порядок того, что есть у нас) остаётся нашим.
 */
function mergeMeta(localBytes, remoteBytes) {
  const local = parse(localBytes);
  const remote = parse(remoteBytes);
  if (!local || !remote) return null;
  const out = { ...local };
  let changed = false;

  const ours = (key) => (Array.isArray(local[key]) ? local[key] : []);
  const known = new Set();
  for (const key of LISTS) for (const e of ours(key)) if (e && typeof e.id === 'string') known.add(e.id);
  for (const e of ours('trash')) if (e && typeof e.id === 'string') known.add(e.id);

  for (const key of LISTS) {
    if (!Array.isArray(remote[key])) continue;
    const merged = [...ours(key)];
    const placed = new Set(merged.map((x) => x && x.id));
    let prev = null;
    for (const e of remote[key]) {
      if (!e || typeof e.id !== 'string') continue;
      if (!known.has(e.id)) {
        // рядом с тем, после чего запись стоит у автора на другом устройстве
        const at = prev ? merged.findIndex((x) => x && x.id === prev) : -1;
        merged.splice(at + 1, 0, e);
        known.add(e.id);
        changed = true;
      }
      if (placed.has(e.id) || merged.some((x) => x && x.id === e.id)) { placed.add(e.id); prev = e.id; }
    }
    if (merged.length !== ours(key).length) out[key] = merged;
  }

  if (Array.isArray(remote.trash)) {
    const have = new Set(ours('trash').map((e) => e && e.tid));
    const extra = remote.trash.filter((e) => e && typeof e.tid === 'string' && !have.has(e.tid) && !known.has(e.id));
    if (extra.length) { out.trash = [...ours('trash'), ...extra]; changed = true; }
  }

  const text = changed ? Buffer.from(JSON.stringify(out, null, 2), 'utf8') : null;
  // слова словаря (добавленные на другом устройстве) сливаются тем же проходом
  return dict.mergeMetaWords(text || localBytes, remoteBytes) || text;
}

module.exports = { mergeMeta };
