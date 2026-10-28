// ---------- доска со стикерами ----------

let boardDrag = null;

async function openBoard() {
  if (!project) return;
  closePanels();
  await flush();
  $('#board').hidden = false;
  await renderBoard();
}

function closeBoard() {
  $('#board').hidden = true;
}

async function renderBoard() {
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
  $('#boardInfo').textContent = `${cards.length} гл. · ${n(total)} ${wordsForm(total)}`;

  cards.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'sticky';
    el.draggable = true;
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
      closeBoard();
      openDoc('chapter', c.id);
    });
    el.addEventListener('dragstart', (e) => {
      boardDrag = c.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', c.id);
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => {
      boardDrag = null;
      el.classList.remove('dragging');
      grid.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    });
    el.addEventListener('dragover', (e) => {
      if (!boardDrag) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      grid.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
      el.classList.add(after ? 'drop-after' : 'drop-before');
    });
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      const id = boardDrag;
      boardDrag = null;
      if (!id) return;
      const r = el.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      const from = cards.findIndex((x) => x.id === id);
      let to = i + (after ? 1 : 0);
      if (from < to) to -= 1;
      if (from < 0 || to === from) { renderBoard(); return; }
      try {
        project = await api.moveChapter(id, to);
        refreshLists();
      } catch (err) {
        showError(err.message);
      }
      renderBoard();
    });
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

