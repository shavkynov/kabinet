// ---------- боковая панель: ширина и скрытие ----------

function setSidebarWidth(px) {
  const w = Math.max(180, Math.min(480, Math.round(px)));
  document.documentElement.style.setProperty('--sidebar-w', `${w}px`);
  return w;
}

let sidebarWidth = 260; // последняя «нормальная» ширина

function applySidebarHidden(hidden) {
  document.body.classList.toggle('sidebar-hidden', hidden);
  try { localStorage.setItem('kabinet.sidebarHidden', hidden ? '1' : '0'); } catch { /* ignore */ }
  setTimeout(() => { updateTwPad(); layoutGoal(); }, 0);
}

function wireSidebar() {
  try {
    const w = Number(localStorage.getItem('kabinet.sidebarWidth'));
    if (w) sidebarWidth = setSidebarWidth(w);
    if (localStorage.getItem('kabinet.sidebarHidden') === '1') {
      document.body.classList.add('sidebar-hidden');
    }
  } catch { /* настройки необязательны */ }

  const resizer = $('#resizer');

  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    document.body.classList.add('resizing');
    let collapse = false; // потянули почти до левого края: на отпускании панель скроется
    const sidebar = $('#sidebar');

    const onMove = (ev) => {
      collapse = ev.clientX < 110;
      if (collapse) {
        sidebar.style.opacity = '.45'; // подсказка: сейчас панель скроется
      } else {
        sidebar.style.opacity = '';
        sidebarWidth = setSidebarWidth(ev.clientX);
      }
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('resizing');
      sidebar.style.opacity = '';
      if (collapse) {
        applySidebarHidden(true);
      } else {
        try { localStorage.setItem('kabinet.sidebarWidth', String(sidebarWidth)); } catch { /* ignore */ }
      }
      setTimeout(updateTwPad, 0);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // двойной клик по границе скрывает панель
  resizer.addEventListener('dblclick', () => applySidebarHidden(true));
}

function toggleSidebar() {
  const hidden = !document.body.classList.contains('sidebar-hidden');
  applySidebarHidden(hidden);
  if (hidden && currentId && isTextKind(currentKind)) editor.commands.focus();
}

