'use strict';

// Обвязка для проверки renderer/analysis.js без редактора: копия модуля во временной папке с заглушками
// tiptap/ProseMirror, i18n и поддельным документом из абзацев. Работает с настоящим кодом подсветки.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const STATE = `export class Plugin { constructor(spec) { this.spec = spec; } }
export class PluginKey { constructor(name) { this.name = name; } getState(state) { return state.__an; } }`;
const VIEW = `export const Decoration = { inline(from, to, attrs) { return { from, to, attrs }; } };
export const DecorationSet = { empty: [], create(doc, decos) { return decos; } };`;
const CORE = `export const Extension = { create(cfg) { return { cfg, plugins(options) { return cfg.addProseMirrorPlugins.call({ options: { ...cfg.addOptions(), ...options } }); } }; } };`;

/** Копия analysis.js с заглушками из корня проекта root. lang: 'ru' | 'en'. Возвращает { mod, plugin, make }. */
async function loadAnalysis(root, lang = 'ru') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kabinet-an-'));
  fs.cpSync(path.join(root, 'src'), path.join(dir, 'src'), { recursive: true });
  write(path.join(dir, 'src', 'package.json'), '{"type":"commonjs"}');
  write(path.join(dir, 'renderer', 'package.json'), '{"type":"module"}');
  fs.copyFileSync(path.join(root, 'renderer', 'analysis.js'), path.join(dir, 'renderer', 'analysis.js'));
  write(path.join(dir, 'renderer', 'i18n.js'), `export const LANG = '${lang}';
export const t = (s, ...a) => s.replace(/\\{(\\d+)\\}/g, (m, i) => (a[i] === undefined ? m : a[i]));`);
  const nm = path.join(dir, 'node_modules', '@tiptap');
  write(path.join(nm, 'core', 'package.json'), '{"type":"module","main":"index.js"}');
  write(path.join(nm, 'core', 'index.js'), CORE);
  write(path.join(nm, 'pm', 'package.json'), '{"type":"module","exports":{"./state":"./state.js","./view":"./view.js"}}');
  write(path.join(nm, 'pm', 'state.js'), STATE);
  write(path.join(nm, 'pm', 'view.js'), VIEW);
  const mod = await import(pathToFileURL(path.join(dir, 'renderer', 'analysis.js')).href);
  return mod;
}

/** Поддельный документ из абзацев; позиции как в ProseMirror (абзац занимает длину текста плюс 2). */
function makeDoc(paragraphs) {
  let pos = 0;
  const nodes = paragraphs.map((p) => {
    const text = typeof p === 'string' ? p : p.text;
    const type = typeof p === 'string' ? 'paragraph' : (p.type || 'paragraph'); // { text, type: 'heading' } для заголовка
    const node = {
      isTextblock: true, type: { name: type }, content: { size: text.length }, text,
      textBetween: (a, b) => text.slice(a, b),
    };
    const at = pos;
    pos += text.length + 2;
    return { node, at };
  });
  return {
    descendants(cb) { for (const { node, at } of nodes) cb(node, at); },
    textBetween(from, to) {
      let out = '';
      for (const { node, at } of nodes) {
        const a = Math.max(from, at + 1);
        const b = Math.min(to, at + 1 + node.text.length);
        if (b > a) out += node.text.slice(a - at - 1, b - at - 1);
      }
      return out;
    },
  };
}

/** Строит подсветку: { set, stats, active, ranges } для текста и настроек cfg. */
function runBuild(mod, paragraphs, cfg) {
  const ext = mod.TextAnalysis;
  const [plugin] = ext.plugins({ getConfig: () => cfg });
  const doc = makeDoc(paragraphs);
  const state = { doc };
  const result = plugin.spec.state.init(null, state);
  state.__an = result;
  return { result, state, doc };
}

module.exports = { loadAnalysis, makeDoc, runBuild };
