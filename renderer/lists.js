// Универсальный список в левой колонке: главы, персонажи, места, заметки.
// Умеет: показывать строки, выбор, переименование двойным кликом, перетаскивание,
// клавиши (Enter создаёт, стрелки ходят, Delete удаляет, F2 переименовывает),
// правый клик (меню строит вызывающий код).

const AUTO_TITLE = /^(Глава|Рассказ|Chapter|Story) \d+$/;

export function createList(opts) {
  const { el, numbered = false, showNumbers = () => true, reorderable = true } = opts;
  let drag = null;
  let suppressClickUntil = 0;

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
    if (drag) drag.cleanup(false);
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

  function startDrag(e, row, item) {
    if (e.button !== 0 || e.pointerType === 'touch' || e.target.closest('input') || row.querySelector('input')) return;
    if (drag) drag.cleanup(false);
    const d = { id: item.id, row, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, active: false, to: -1 };
    const onMove = (ev) => {
      if (ev.pointerId !== d.pointerId) return;
      if (!d.active) {
        if (Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) < 5) return;
        d.active = true;
        row.classList.add('dragging');
        document.body.classList.add('reordering');
        try { window.getSelection()?.removeAllRanges(); } catch { /* ignore */ }
      }
      ev.preventDefault();
      const scroller = el.closest('#binder') || el;
      const sr = scroller.getBoundingClientRect();
      if (ev.clientY < sr.top + 28) scroller.scrollTop -= 10;
      else if (ev.clientY > sr.bottom - 28) scroller.scrollTop += 10;

      const er = el.getBoundingClientRect();
      if (ev.clientX < er.left - 80 || ev.clientX > er.right + 80 || ev.clientY < er.top - 48 || ev.clientY > er.bottom + 48) {
        clearDropMarks();
        d.to = -1;
        return;
      }
      const rows = [...el.querySelectorAll('.ch')];
      if (!rows.length) return;
      let hit = rows[0];
      let best = Infinity;
      for (const rEl of rows) {
        const rr = rEl.getBoundingClientRect();
        const dist = ev.clientY >= rr.top && ev.clientY <= rr.bottom ? 0 : Math.abs(ev.clientY - (rr.top + rr.height / 2));
        if (dist < best) { best = dist; hit = rEl; if (dist === 0) break; }
      }
      const hr = hit.getBoundingClientRect();
      const after = ev.clientY > hr.top + hr.height / 2;
      const from = indexOf(d.id);
      const idx = indexOf(hit.dataset.id);
      let to = idx + (after ? 1 : 0);
      if (from < to) to -= 1;
      clearDropMarks();
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
      if (drag !== d) return;
      drag = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', onKey);
      clearDropMarks();
      row.classList.remove('dragging');
      document.body.classList.remove('reordering');
      if (d.active) suppressClickUntil = Date.now() + 250;
      if (commit && d.active && d.to >= 0) {
        try {
          await opts.onReorder(d.id, d.to);
        } catch (err) {
          opts.onError(err);
        }
        render();
      }
    };
    drag = d;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onBlur);
    window.addEventListener('keydown', onKey);
  }

  function makeRow(item, i) {
    const row = document.createElement('div');
    row.className = 'ch' + (numbered ? '' : ' card');
    row.dataset.id = item.id;

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
      if (Date.now() < suppressClickUntil) return;
      opts.onOpen(item.id);
      el.focus();
    });
    row.addEventListener('dblclick', () => startRename(row, item));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      opts.onContext(item, e.clientX, e.clientY);
    });
    if (reorderable) row.addEventListener('pointerdown', (e) => startDrag(e, row, item));

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
