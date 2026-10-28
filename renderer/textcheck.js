// Проверка текста: подчёркивание замечаний LanguageTool в редакторе и панель со списком.
// Текст главы эти подчёркивания не меняют: это временная разметка поверх текста (decorations).
// Правка делается только по нажатию автора.

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { t } from './i18n.js';

export const issuesKey = new PluginKey('langIssues');

const flat = (s) => s.replace(/￼/g, ' ');

export const LangIssues = Extension.create({
  name: 'langIssues',
  addOptions() { return { onChange: () => {} }; },
  addProseMirrorPlugins() {
    const opts = this.options;
    return [new Plugin({
      key: issuesKey,
      state: {
        init: () => DecorationSet.empty,
        apply(tr, set) {
          const meta = tr.getMeta(issuesKey);
          if (meta) {
            if (meta.clear) return DecorationSet.empty;
            if (meta.remove) return set.remove(set.find().filter((d) => d.spec.id === meta.remove));
            if (meta.set) {
              return DecorationSet.create(tr.doc, meta.set.map((i) => Decoration.inline(
                i.from, i.to,
                { class: `lt-issue lt-${i.kind}`, 'data-issue': String(i.id) },
                { id: i.id, text: i.text, kind: i.kind, message: i.message, short: i.short, ruleId: i.ruleId, replacements: i.replacements },
              )));
            }
          }
          if (!tr.docChanged) return set;
          let next = set.map(tr.mapping, tr.doc);
          // слово изменили: старое замечание к нему больше не относится
          const stale = next.find().filter((d) => flat(tr.doc.textBetween(d.from, d.to, '', '￼')) !== d.spec.text);
          if (stale.length) next = next.remove(stale);
          return next;
        },
      },
      props: { decorations(state) { return this.getState(state); } },
      view: () => ({
        update(view, prev) {
          if (issuesKey.getState(view.state) !== issuesKey.getState(prev)) opts.onChange();
        },
      }),
    })];
  },
});

/** Абзацы документа: текст каждого текстового блока и позиция его начала. Длина текста = длине в позициях. */
export function collectBlocks(doc) {
  const blocks = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const isCode = node.type.name === 'codeBlock';
    blocks.push({ start: pos + 1, text: isCode ? '' : flat(node.textBetween(0, node.content.size, '', '￼')) });
    return false;
  });
  return blocks;
}

const KIND_LABEL = {
  spelling: 'Орфография',
  punctuation: 'Пунктуация',
  grammar: 'Грамматика',
  typography: 'Типографика',
  style: 'Стиль',
  other: 'Другое',
};

/**
 * ctx: { api, $, getEditor, canCheck(), cardNames(), showError, setStatus, openConsent() -> Promise<boolean> }
 * Возвращает { open(), run(), clear(), issueFromElement(el), applyIssue(id, text), ignoreIssue(id), addWord(id), ignoreRule(id) }
 */
export function initTextCheck(ctx) {
  const { api, $ } = ctx;
  let cfg = { consent: false, server: '', lang: 'ru', disabledRules: [], hiddenKinds: [], words: [] };
  let running = false;
  let skipped = 0;
  let renderTimer = null;

  const editor = () => ctx.getEditor();
  const decos = () => {
    const ed = editor();
    if (!ed) return [];
    return issuesKey.getState(ed.state).find().sort((a, b) => a.from - b.from);
  };
  const byId = (id) => decos().find((d) => d.spec.id === id);

  function setState(text) { $('#checkState').textContent = text; }

  function render() {
    const list = $('#checkList');
    list.textContent = '';
    const items = decos();
    $('#btnCheckClear').hidden = !items.length;
    if (!items.length) {
      list.hidden = true;
      return;
    }
    list.hidden = false;
    const ed = editor();
    const counts = {};
    items.forEach((d) => { counts[d.spec.kind] = (counts[d.spec.kind] || 0) + 1; });
    const summary = Object.entries(counts).map(([k, n]) => `${t(KIND_LABEL[k])}: ${n}`).join(' · ');
    setState(`${t('Найдено замечаний: {0}', items.length)}. ${summary}${skipped ? `. ${t('Пропущено из-за правок во время проверки: {0}', skipped)}` : ''}`);

    for (const d of items.slice(0, 200)) {
      const s = d.spec;
      const li = document.createElement('div');
      li.className = `chk-item lt-${s.kind}`;
      li.dataset.id = String(s.id);

      const head = document.createElement('div');
      head.className = 'chk-head';
      const tag = document.createElement('span');
      tag.className = 'chk-tag';
      tag.textContent = t(KIND_LABEL[s.kind] || 'Другое');
      const msg = document.createElement('span');
      msg.className = 'chk-msg';
      msg.textContent = s.short || s.message;
      head.append(tag, msg);

      const ctxLine = document.createElement('div');
      ctxLine.className = 'chk-ctx';
      ctxLine.setAttribute('translate', 'no');
      const $from = ed.state.doc.resolve(d.from);
      const blockText = flat($from.parent.textBetween(0, $from.parent.content.size, '', '￼'));
      const off = d.from - $from.start();
      const pre = blockText.slice(Math.max(0, off - 28), off);
      const post = blockText.slice(off + (d.to - d.from), off + (d.to - d.from) + 28);
      const mark = document.createElement('mark');
      mark.textContent = s.text;
      ctxLine.append(document.createTextNode(`${off > 28 ? '…' : ''}${pre}`), mark, document.createTextNode(post));

      const acts = document.createElement('div');
      acts.className = 'chk-acts';
      for (const r of s.replacements.slice(0, 4)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chk-rep';
        b.dataset.act = 'rep';
        b.dataset.value = r;
        b.setAttribute('translate', 'no');
        b.textContent = r === '' ? t('(удалить)') : r;
        acts.append(b);
      }
      const addBtn = (act, label, title) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chk-link';
        b.dataset.act = act;
        b.textContent = t(label);
        if (title) b.title = t(title);
        acts.append(b);
      };
      addBtn('skip', 'Пропустить');
      if (s.kind === 'spelling') addBtn('word', 'В словарь', 'Больше не считать это слово ошибкой');
      else addBtn('rule', 'Не проверять такое', 'Отключить это правило проверки насовсем');
      li.append(head, ctxLine, acts);
      list.append(li);
    }
  }

  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => { if (!$('#checkPanel').hidden) render(); else $('#btnCheckClear').hidden = !decos().length; }, 120);
  }

  function dispatch(meta) {
    const ed = editor();
    if (!ed) return;
    ed.view.dispatch(ed.state.tr.setMeta(issuesKey, meta).setMeta('addToHistory', false));
  }

  function clear() {
    dispatch({ clear: true });
    skipped = 0;
    setState('');
    render();
  }

  function gotoIssue(id) {
    const d = byId(id);
    const ed = editor();
    if (!d || !ed) return;
    ed.chain().focus().setTextSelection({ from: d.from, to: d.to }).run();
    requestAnimationFrame(() => {
      try {
        const { node } = ed.view.domAtPos(d.from);
        const el = node.nodeType === 1 ? node : node.parentElement;
        if (el) el.scrollIntoView({ block: 'center' });
      } catch { /* текст успел измениться */ }
    });
  }

  function applyIssue(id, text) {
    const d = byId(id);
    const ed = editor();
    if (!d || !ed) return;
    ed.view.dispatch(ed.state.tr.insertText(text, d.from, d.to).scrollIntoView());
    ctx.afterEdit && ctx.afterEdit();
  }

  async function ask() {
    if (cfg.consent) return true;
    const local = /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:|\/|$)/i.test(cfg.server.trim());
    if (local) return true;
    const ok = await ctx.openConsent();
    if (!ok) return false;
    cfg = await api.setCheckConfig({ consent: true });
    return true;
  }

  async function run() {
    if (running) return;
    const ed = editor();
    if (!ed || !ctx.canCheck()) { ctx.showError(t('Откройте главу или заметку, чтобы проверить текст.')); return; }
    cfg = await api.getCheckConfig();
    if (!(await ask())) return;
    const snap = collectBlocks(ed.state.doc);
    if (!snap.some((b) => b.text.trim())) { setState(t('В тексте пока нечего проверять.')); return; }
    running = true;
    skipped = 0;
    $('#btnRunCheck').disabled = true;
    $('#btnCancelCheck').hidden = false;
    setState(t('Проверяю…'));
    try {
      const issues = await api.runCheck(snap.map((b) => b.text), ctx.cardNames());
      const now = collectBlocks(editor().state.doc);
      const ready = [];
      for (const i of issues) {
        const a = snap[i.para];
        const b = now[i.para];
        if (!a || !b || a.text !== b.text || a.text.slice(i.offset, i.offset + i.length) !== i.text) { skipped += 1; continue; }
        if (i.text.includes('￼')) continue;
        ready.push({ ...i, from: b.start + i.offset, to: b.start + i.offset + i.length });
      }
      dispatch({ set: ready });
      if (!ready.length) setState(skipped ? t('Текст менялся во время проверки. Запустите её ещё раз.') : t('Замечаний нет.'));
      render();
    } catch (err) {
      setState('');
      if (!/остановлена|stopped/.test(err.message)) ctx.showError(err.message);
      else setState(t('Проверка остановлена.'));
    } finally {
      running = false;
      $('#btnRunCheck').disabled = false;
      $('#btnCancelCheck').hidden = true;
    }
  }

  async function open() {
    try { cfg = await api.getCheckConfig(); } catch { /* значения по умолчанию */ }
    $('#setCheckLang').value = cfg.lang;
    $('#setCheckServer').value = cfg.server;
    syncKindBoxes();
    render();
  }

  // Виды замечаний, которые автор скрыл: галочка снята = вид скрыт.
  function syncKindBoxes() {
    const hidden = new Set(cfg.hiddenKinds || []);
    document.querySelectorAll('#chkKinds input[data-chk-kind]').forEach((box) => { box.checked = !hidden.has(box.dataset.chkKind); });
  }

  async function onKindChange() {
    const before = new Set(cfg.hiddenKinds || []);
    const hiddenKinds = [...document.querySelectorAll('#chkKinds input[data-chk-kind]')].filter((b) => !b.checked).map((b) => b.dataset.chkKind);
    try {
      cfg = await api.setCheckConfig({ hiddenKinds });
    } catch (err) {
      ctx.showError(err.message);
      syncKindBoxes();
      return;
    }
    const now = new Set(cfg.hiddenKinds || []);
    // скрытые виды убираем из текста и списка сразу
    for (const d of decos().filter((x) => now.has(x.spec.kind))) dispatch({ remove: d.spec.id });
    render();
    if ([...before].some((k) => !now.has(k))) ctx.setStatus('ok', t('Замечания этого вида появятся при следующей проверке: нажмите «Проверить текст».'));
  }

  api.onCheckProgress((p) => {
    if (running && p.total > 1) setState(t('Проверяю… часть {0} из {1}', Math.min(p.done + 1, p.total), p.total));
  });

  $('#btnRunCheck').addEventListener('click', run);
  $('#btnCancelCheck').addEventListener('click', () => api.cancelCheck());
  $('#btnCheckClear').addEventListener('click', clear);
  document.querySelectorAll('#chkKinds input[data-chk-kind]').forEach((box) => box.addEventListener('change', onKindChange));
  $('#setCheckLang').addEventListener('change', async (e) => {
    try { cfg = await api.setCheckConfig({ lang: e.target.value }); } catch (err) { ctx.showError(err.message); }
  });
  $('#setCheckServer').addEventListener('change', async (e) => {
    try { cfg = await api.setCheckConfig({ server: e.target.value }); } catch (err) { ctx.showError(err.message); e.target.value = cfg.server; }
  });
  $('#btnCheckReset').addEventListener('click', async () => {
    try {
      cfg = await api.setCheckConfig({ disabledRules: [], words: [], consent: false });
      ctx.setStatus('ok', t('Исключения и согласие сброшены'));
    } catch (err) { ctx.showError(err.message); }
  });

  async function skipIssue(id) { dispatch({ remove: id }); }

  async function addWord(id) {
    const d = byId(id);
    if (!d) return;
    const word = d.spec.text;
    try {
      await api.addCheckWord(word);
      // убираем все такие же подчёркивания
      for (const x of decos().filter((y) => y.spec.kind === 'spelling' && y.spec.text.toLowerCase() === word.toLowerCase())) dispatch({ remove: x.spec.id });
      ctx.setStatus('ok', t('«{0}» добавлено в словарь', word));
    } catch (err) { ctx.showError(err.message); }
  }

  async function ignoreRule(id) {
    const d = byId(id);
    if (!d) return;
    const rule = d.spec.ruleId;
    try {
      await api.ignoreCheckRule(rule);
      for (const x of decos().filter((y) => y.spec.ruleId === rule)) dispatch({ remove: x.spec.id });
      ctx.setStatus('ok', t('Это правило больше не проверяется'));
    } catch (err) { ctx.showError(err.message); }
  }

  $('#checkList').addEventListener('click', (e) => {
    const item = e.target.closest('.chk-item');
    if (!item) return;
    const id = Number(item.dataset.id);
    const btn = e.target.closest('button[data-act]');
    if (!btn) { gotoIssue(id); return; }
    const act = btn.dataset.act;
    if (act === 'rep') applyIssue(id, btn.dataset.value);
    else if (act === 'skip') skipIssue(id);
    else if (act === 'word') addWord(id);
    else if (act === 'rule') ignoreRule(id);
  });

  return {
    open,
    run,
    clear,
    scheduleRender,
    applyIssue,
    skipIssue,
    addWord,
    ignoreRule,
    issueAtPoint(x, y) {
      const el = document.elementFromPoint(x, y);
      const hit = el && el.closest ? el.closest('.lt-issue') : null;
      return hit ? byId(Number(hit.dataset.issue)) : null;
    },
    isRunning: () => running,
  };
}
