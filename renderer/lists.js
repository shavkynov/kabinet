// Универсальный список в левой колонке: главы, персонажи, места, заметки.
// Умеет: показывать строки, выбор, переименование двойным кликом, перетаскивание,
// клавиши (Enter создаёт, стрелки ходят, Delete удаляет, F2 переименовывает),
// правый клик (меню строит вызывающий код).

const AUTO_TITLE = /^(Глава|Рассказ|Chapter|Story) \d+$/;

export function createList(opts) {
  const { el, numbered = false, showNumbers = () => true } = opts;
  let dragId = null;

  function items() {
    return opts.getItems() || [];
  }

  function indexOf(id) {
    return items().findIndex((c) => c.id === id);
  }

  function clearDropMarks() {
    el.querySelectorAll('.drop-before, .drop-after')
      .forEach((n) => n.classList.remove('drop-before', 'drop-after'));
  }

  function render() {
    el.textContent = '';
    items().forEach((item, i) => el.append(makeRow(item, i)));
    updateSelection();
  }

  function updateSelection() {
    const sel = opts.getSelectedId();
    for (const row of el.children) {
      const on = row.dataset.id === sel;
      row.classList.toggle('selected', on);
      if (on) row.scrollIntoView({ block: 'nearest' });
    }
  }

  function makeRow(item, i) {
    const row = document.createElement('div');
    row.className = 'ch' + (numbered ? '' : ' card');
    row.dataset.id = item.id;
    row.draggable = true;

    if (numbered) {
      // цветовой маркер главы: полоса слева
      const mk = document.createElement('span');
      mk.className = 'mk';
      if (item.marker && opts.markerColor) mk.style.background = opts.markerColor(item.marker);
      row.append(mk);
    }

    const lead = document.createElement('span');
    if (numbered) {
      lead.className = 'num';
      // номер всегда по позиции в списке; у «Глава N» номер уже в названии
      lead.textContent = AUTO_TITLE.test(item.title) || !showNumbers() ? '' : `${i + 1}.`;
      if (!lead.textContent) lead.hidden = true;
    } else {
      lead.className = 'ic';
      lead.textContent = item.icon || '';
    }

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = item.title;
    title.setAttribute('translate', 'no');
    title.title = item.title;

    row.append(lead, title);
    if (opts.badge && opts.badge(item)) {
      const star = document.createElement('span');
      star.className = 'star';
      star.textContent = '★';
      star.title = opts.badgeTitle || '';
      row.append(star);
    }

    row.addEventListener('click', () => {
      opts.onOpen(item.id);
      el.focus();
    });
    row.addEventListener('dblclick', () => startRename(row, item));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      opts.onContext(item, e.clientX, e.clientY);
    });

    row.addEventListener('dragstart', (e) => {
      dragId = item.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', item.id);
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      dragId = null;
      row.classList.remove('dragging');
      clearDropMarks();
    });
    row.addEventListener('dragover', (e) => {
      if (!dragId) return;
      e.preventDefault();
      const r = row.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      clearDropMarks();
      row.classList.add(after ? 'drop-after' : 'drop-before');
    });
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      const id = dragId;
      if (!id) return;
      const r = row.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      const from = indexOf(id);
      let to = indexOf(item.id) + (after ? 1 : 0);
      if (from < to) to -= 1;
      clearDropMarks();
      dragId = null;
      if (to === from) return;
      try {
        await opts.onReorder(id, to);
      } catch (err) {
        opts.onError(err);
      }
      render();
    });

    return row;
  }

  function startRename(row, item) {
    const titleEl = row.querySelector('.title');
    if (!titleEl || row.querySelector('input')) return;

    const input = document.createElement('input');
    input.className = 'rename';
    input.value = item.title;
    input.maxLength = 200;
    titleEl.replaceWith(input);
    row.draggable = false;
    input.focus();
    input.select();

    let done = false;
    const finish = async (commit, refocus) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      if (commit && value && value !== item.title) {
        try {
          await opts.onRename(item.id, value);
        } catch (err) {
          opts.onError(err);
        }
      }
      render();
      if (refocus) el.focus();
    };

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true, true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false, true);
      }
    });
    input.addEventListener('blur', () => finish(true, false));
  }

  function renameById(id) {
    const row = [...el.children].find((r) => r.dataset.id === id);
    const item = items().find((c) => c.id === id);
    if (row && item) startRename(row, item);
  }

  el.addEventListener('keydown', (e) => {
    if (e.target !== el) return; // не вмешиваемся, пока идёт переименование
    // ⌘⌫ и ⌃⌫ удаляют так же, как просто Delete
    if ((e.metaKey || e.ctrlKey || e.altKey) && !((e.metaKey || e.ctrlKey) && (e.key === 'Backspace' || e.key === 'Delete'))) return;
    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        if (!e.repeat) opts.onAdd();
        break;
      case 'ArrowDown':
        e.preventDefault();
        opts.onSelectRelative(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        opts.onSelectRelative(-1);
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        if (!e.repeat) opts.onDelete();
        break;
      case 'F2': {
        e.preventDefault();
        const id = opts.getSelectedId();
        if (id) renameById(id);
        break;
      }
      case 'Tab':
        if (!e.shiftKey && opts.onTab && opts.onTab()) e.preventDefault();
        break;
      default:
    }
  });

  return { render, updateSelection, renameById, el };
}
