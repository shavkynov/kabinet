// ---------- вкладка «Ритм»: монотонность повествования ----------
// Лента: одна полоска на предложение (высота = длина). Бирюзовые полоски: цепочки и ровный ритм.
// Список находок как у проверки времён; клик переносит к месту в тексте.

let rhythmTimer = 0;
let rhythmData = null;

function scheduleRhythm() {
  if (!$('#checkPanel') || $('#checkPanel').hidden || $('#viewRhythm').hidden) return;
  clearTimeout(rhythmTimer);
  rhythmTimer = setTimeout(renderRhythm, 600);
}

function rhythmMessage(it) {
  if (it.type === 'short') return t('Короткие предложения подряд (до {1} слов), всего: {0}', it.to - it.from + 1, it.max);
  if (it.type === 'even') return t('Ровный ритм: предложений {0}, длина {1}–{2} слов', it.to - it.from + 1, it.min, it.max);
  return t('Одинаковое начало «{1}», предложений подряд: {0}', it.to - it.from + 1, it.word);
}

function renderRhythm() {
  const box = $('#rhythmList');
  if (!box || !editor || $('#viewRhythm').hidden) return;
  const res = scanRhythm(editor.state.doc);
  rhythmData = res;
  const st = res.stats;
  const n = (v) => v.toLocaleString(LOCALE);

  // сводка
  const sum = $('#rhythmSummary');
  sum.textContent = '';
  if (!st.count) {
    sum.textContent = t('В этой главе пока нет повествования для разбора.');
  } else {
    const names = { low: t('низкий'), normal: t('нормальный'), high: t('высокий'), unknown: t('мало текста для оценки') };
    const l1 = document.createElement('div');
    l1.textContent = t('Предложений в повествовании: {0}. Средняя длина: {1} слов.', n(st.count), n(st.mean));
    const l2 = document.createElement('div');
    l2.textContent = t('Короткие (до 6 слов): {0}%, средние: {1}%, длинные (от 18): {2}%.', st.short, st.medium, st.long);
    const l3 = document.createElement('div');
    l3.textContent = t('Разброс длины предложений: {0}.', names[st.spread]);
    sum.append(l1, l2, l3);
  }

  // лента
  const bar = $('#rhythmBar');
  bar.textContent = '';
  const inRun = new Set();
  res.items.forEach((it) => { for (let k = it.from; k <= it.to; k += 1) inRun.add(k); });
  const max = Math.max(20, ...res.sentences.map((s) => s.words));
  res.sentences.forEach((s, i) => {
    const b = document.createElement('i');
    b.style.height = `${Math.max(6, Math.round((Math.min(s.words, max) / max) * 100))}%`;
    if (s.dialogue) b.classList.add('dlg');
    else if (inRun.has(i)) b.classList.add('run');
    b.title = t('{0} слов', s.words);
    b.dataset.sent = String(i);
    bar.append(b);
  });
  $('#rhythmLegend').textContent = res.sentences.length
    ? t('Каждая полоска: предложение, высота: длина. Бирюзовым отмечены находки, бледным: реплики диалога.')
    : '';

  // список
  box.textContent = '';
  if (!res.items.length) {
    if (st.count) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = t('Монотонных мест не найдено.');
      box.append(p);
    }
    return;
  }
  const doc = editor.state.doc;
  const TAGS = { short: t('Короткие'), even: t('Ровный ритм'), start: t('Начало') };
  res.items.slice(0, 200).forEach((it, idx) => {
    const row = document.createElement('div');
    row.className = 'chk-item rhythm-item';
    row.dataset.idx = String(idx);
    const head = document.createElement('div');
    head.className = 'chk-head';
    const tag = document.createElement('span');
    tag.className = 'chk-tag';
    tag.textContent = TAGS[it.type];
    const msg = document.createElement('span');
    msg.className = 'chk-msg';
    msg.textContent = rhythmMessage(it);
    head.append(tag, msg);
    const first = res.sentences[it.from];
    const ctx = document.createElement('div');
    ctx.className = 'chk-ctx';
    ctx.setAttribute('translate', 'no');
    let snippet = doc.textBetween(first.from, Math.min(res.sentences[it.to].to, first.from + 140), ' ').replace(/\s+/g, ' ');
    if (res.sentences[it.to].to > first.from + 140) snippet += '…';
    ctx.textContent = snippet;
    row.append(head, ctx);
    box.append(row);
  });
  if (res.items.length > 200) {
    const more = document.createElement('p');
    more.className = 'hint';
    more.textContent = t('Показаны первые 200 из {0}.', res.items.length);
    box.append(more);
  }
}

function gotoRhythm(from, to) {
  if (!editor) return;
  editor.chain().focus().setTextSelection({ from, to }).run();
  requestAnimationFrame(() => {
    try {
      const { node } = editor.view.domAtPos(from);
      const el = node.nodeType === 1 ? node : node.parentElement;
      if (el) el.scrollIntoView({ block: 'center' });
    } catch { /* текст успел измениться */ }
  });
}

function wireRhythm() {
  $('#rhythmList').addEventListener('click', (e) => {
    const row = e.target.closest('.rhythm-item');
    if (!row || !rhythmData) return;
    const it = rhythmData.items[Number(row.dataset.idx)];
    if (!it) return;
    gotoRhythm(rhythmData.sentences[it.from].from, rhythmData.sentences[it.to].to);
  });
  $('#rhythmBar').addEventListener('click', (e) => {
    const b = e.target.closest('i[data-sent]');
    if (!b || !rhythmData) return;
    const s = rhythmData.sentences[Number(b.dataset.sent)];
    if (s) gotoRhythm(s.from, s.to);
  });
}
