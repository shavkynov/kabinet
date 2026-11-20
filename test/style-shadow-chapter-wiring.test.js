'use strict';
// Регрессия F.3.1-C: смена главы идёт через editor.setContent(…, false), а он не вызывает onUpdate.
// Без явного scheduleStyleShadow() запрос прежней главы не отменялся, а разбор новой главы не запускался:
// состояние тени оставалось от предыдущего документа (findings с offsets главы А применялись к тексту главы Б).
// Проверка проводки по исходникам; поведение в настоящем окне проверяет experiments/tauri-app/e2e/chapters-ranges.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..', 'renderer', 'app');
const links = fs.readFileSync(path.join(APP, '12-links.js'), 'utf8');

function functionBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `нет функции ${name}`);
  const open = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(open, i + 1); }
  }
  throw new Error(`не закрыта функция ${name}`);
}

test('смена документа: setEditorContent запускает тень после загрузки текста, с защитой до инициализации модуля', () => {
  const body = functionBody(links, 'setEditorContent');
  const load = body.indexOf('.setContent(');
  const schedule = body.indexOf('scheduleStyleShadow()');
  assert.ok(load >= 0 && schedule > load, 'scheduleStyleShadow() должен вызываться после setContent');
  assert.match(body, /if \(window\.__styleShadowReady\) scheduleStyleShadow\(\)/);
});

test('смена документа: основной редактор загружает текст только через setEditorContent', () => {
  const offenders = [];
  for (const f of fs.readdirSync(APP).filter((n) => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(APP, f), 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (/\beditor\b\s*(\n\s*)?\.(chain\(\)|commands)?[^;]*setContent\(/.test(line) || /^\s*\.setContent\(/.test(line)) offenders.push(`${f}:${i + 1}`);
    });
  }
  // Единственное место основного редактора — setEditorContent (12-links.js).
  // 05-pane2.js — второй лист со своим editor2: тень на нём не работает, и там это проверено явно.
  const pane2 = fs.readFileSync(path.join(APP, '05-pane2.js'), 'utf8');
  assert.match(pane2, /editor2\s*\n\s*\.chain\(\)[\s\S]{0,200}\.setContent\(/);
  assert.deepEqual(offenders.filter((o) => !o.startsWith('12-links.js') && !o.startsWith('05-pane2.js')), [], `прямые setContent основного редактора: ${offenders}`);
});
