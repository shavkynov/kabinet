// ---------- доска со стикерами ----------

let boardDrag = null;
let boardSuppressClickUntil = 0;

function clearBoardDropMarks(grid) {
  grid.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
}

function cancelBoardDrag() {
  if (boardDrag) boardDrag.cleanup(false);
}

function startBoardDrag(e, el, card, cards, grid) {
  if (e.button !== 0 || e.pointerType === 'touch') return;
  cancelBoardDrag();
  const d = { id: card.id, el, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, active: false, to: -1 };
  const onMove = (ev) => {
    if (ev.pointerId !== d.pointerId) return;
    if (!d.active) {
      if (Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) < 6) return;
      d.active = true;
      el.classList.add('dragging');
      document.body.classList.add('reordering');
      try { window.getSelection()?.removeAllRanges(); } catch { /* ignore */ }
    }
    ev.preventDefault();
    const scroller = $('#board');
    if (scroller) {
      const sr = scroller.getBoundingClientRect();
      if (ev.clientY < sr.top + 32) scroller.scrollTop -= 12;
      else if (ev.clientY > sr.bottom - 32) scroller.scrollTop += 12;
    }
    const gr = grid.getBoundingClientRect();
    if (ev.clientX < gr.left - 48 || ev.clientX > gr.right + 48 || ev.clientY < gr.top - 48 || ev.clientY > gr.bottom + 48) {
      clearBoardDropMarks(grid);
      d.to = -1;
      return;
    }
    const items = [...grid.querySelectorAll('.sticky:not(.add)')];
    if (!items.length) return;
    let hit = items[0];
    let hitRect = hit.getBoundingClientRect();
    let best = Infinity;
    for (const st of items) {
      const rr = st.getBoundingClientRect();
      const dx = ev.clientX < rr.left ? rr.left - ev.clientX : ev.clientX > rr.right ? ev.clientX - rr.right : 0;
      const dy = ev.clientY < rr.top ? rr.top - ev.clientY : ev.clientY > rr.bottom ? ev.clientY - rr.bottom : 0;
      const dist = dx * dx + dy * dy;
      if (dist < best) { best = dist; hit = st; hitRect = rr; if (dist === 0) break; }
    }
    const after = ev.clientX > hitRect.left + hitRect.width / 2;
    const from = cards.findIndex((x) => x.id === d.id);
    const idx = cards.findIndex((x) => x.id === hit.dataset.id);
    let to = idx + (after ? 1 : 0);
    if (from < to) to -= 1;
    clearBoardDropMarks(grid);
    if (from < 0 || idx < 0 || to === from) {
      d.to = -1;
    } else {
      d.to = to;
      hit.classList.add(after ? 'drop-after' : 'drop-before');
    }
  };
  const onUp = (ev) => { if (ev.pointerId === d.pointerId) d.cleanup(true); };
  const onCancel = (ev) => { if (ev.pointerId === undefined || ev.pointerId === d.pointerId) d.cleanup(false); };
  const onKey = (ev) => { if (ev.key === 'Escape') d.cleanup(false); };
  const onBlur = () => d.cleanup(false);
  d.cleanup = async (commit) => {
    if (boardDrag !== d) return;
    boardDrag = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('keydown', onKey);
    clearBoardDropMarks(grid);
    el.classList.remove('dragging');
    document.body.classList.remove('reordering');
    if (d.active) boardSuppressClickUntil = Date.now() + 250;
    if (commit && d.active && d.to >= 0) {
      try {
        project = await api.moveChapter(d.id, d.to);
        refreshLists();
        fillP2Select();
      } catch (err) {
        showError(err.message);
      }
      renderBoard();
    }
  };
  boardDrag = d;
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('blur', onBlur);
  window.addEventListener('keydown', onKey);
}

async function openBoard() {
  if (!project || (typeof isChallengeActive === 'function' && isChallengeActive())) return;
  closePanels();
  if (typeof closeSearch === 'function') closeSearch(false);
  await flush();
  $('#board').hidden = false;
  await renderBoard();
}

function closeBoard() {
  cancelBoardDrag();
  $('#board').hidden = true;
}

async function renderBoard() {
  cancelBoardDrag();
  let cards = [];
  try {
    cards = await api.projectBoard();
  } catch (err) {
    showError(err.message);
    closeBoard();
    return;
  }
  const grid = $('#boardGrid');
  grid.textContent = '';
  const n = (v) => v.toLocaleString(LOCALE);
  $('#boardTitle').textContent = project.name;
  const total = cards.reduce((a, c) => a + c.words, 0);
  $('#boardInfo').textContent = t('{0} гл. · {1} {2}', cards.length, n(total), wordsForm(total));

  cards.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'sticky';
    el.dataset.id = c.id;
    el.style.setProperty('--rot', `${(((i * 37) % 7) - 3) * 0.45}deg`);
    if (c.marker) el.style.setProperty('--tape', MARKER_COLORS[c.marker]);

    const num = document.createElement('div');
    num.className = 'st-num';
    num.textContent = t('Глава {0}', i + 1);
    const title = document.createElement('div');
    title.className = 'st-title';
    title.setAttribute('translate', 'no');
    title.textContent = c.title;
    const syn = document.createElement('div');
    syn.className = 'st-syn' + (c.synopsis ? '' : ' empty');
    syn.setAttribute('translate', 'no');
    syn.textContent = c.synopsis || t('Синопсиса пока нет');
    const words = document.createElement('div');
    words.className = 'st-words';
    words.textContent = `${n(c.words)} ${wordsForm(c.words)}`;
    el.append(num, title, syn, words);

    el.addEventListener('click', () => {
      if (Date.now() < boardSuppressClickUntil) return;
      closeBoard();
      openDoc('chapter', c.id);
    });
    el.addEventListener('pointerdown', (e) => startBoardDrag(e, el, c, cards, grid));
    grid.append(el);
  });

  const add = document.createElement('div');
  add.className = 'sticky add';
  add.textContent = t('+ Новая глава');
  add.addEventListener('click', () => {
    closeBoard();
    addDoc('chapter');
  });
  grid.append(add);
}

function wireBoard() {
  $('#projectName').addEventListener('click', openBoard);
  $('#boardClose').addEventListener('click', closeBoard);
  $('#board').addEventListener('mousedown', (e) => {
    if (e.target.id === 'board' || e.target.classList.contains('board-inner')) closeBoard();
  });
}

