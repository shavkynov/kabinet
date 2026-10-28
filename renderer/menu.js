// Простое контекстное меню (правый клик по строке списка) и выбор иконки.

// Иконки для персонажей: люди, профессии и архетипы, существа.
export const ICONS_CHARACTER = [
  '👤', '👨', '👩', '🧑', '👦', '👧', '🧒', '👶',
  '👴', '👵', '🧔', '👱', '🧙', '🧝', '🧛', '🧟',
  '🧞', '🧜', '🧚', '🦸', '🦹', '🥷', '🕵️', '👮',
  '🤴', '👸', '👑', '🤺', '🏴‍☠️', '🧑‍⚕️', '🧑‍🏫', '🧑‍🌾',
  '🧑‍🍳', '🧑‍🔧', '🧑‍🎨', '🧑‍🚀', '🧑‍✈️', '🎭', '🤡', '💀',
  '👻', '👹', '🐺', '🦊', '🐉', '🦅', '🐈‍⬛', '🐎',
];

// Иконки для мест: постройки, природа, города, необычные локации.
export const ICONS_PLACE = [
  '🏰', '🏯', '🏛️', '⛪', '🕌', '⛩️', '🏠', '🏡',
  '🏘️', '🏚️', '🏢', '🏭', '🏥', '🏫', '🏪', '🍺',
  '☕', '🏨', '⛺', '🏕️', '🌲', '🌳', '🌴', '🌾',
  '⛰️', '🏔️', '🌋', '🏜️', '🏝️', '🏖️', '🌊', '⛲',
  '🌉', '🏙️', '🌆', '🌃', '🚉', '⚓', '🚢', '✈️',
  '🗼', '🗽', '🚪', '🕳️', '⚰️', '🪦', '❄️', '🌌',
];

let menuEl = null;
let stop = null;

export function closeMenu() {
  if (stop) stop();
  stop = null;
  if (menuEl) menuEl.remove();
  menuEl = null;
}

/**
 * entries: массив пунктов
 *   { label, onClick, checked?, swatch?, disabled? }
 *   { separator: true }
 *   { icons: [...], current, onPick(иконка | null) }   сетка иконок
 */
export function showMenu(x, y, entries) {
  closeMenu();

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.setAttribute('role', 'menu');
  // клик по пункту не должен отнимать фокус у текста: иначе «Вставить» и замена слова не найдут курсор
  menu.addEventListener('mousedown', (ev) => ev.preventDefault());

  for (const e of entries) {
    if (e.separator) {
      const hr = document.createElement('div');
      hr.className = 'ctx-sep';
      menu.append(hr);
    } else if (e.icons) {
      menu.append(makeIconGrid(e));
    } else if (e.submenu) {
      menu.append(makeSub(e));
    } else {
      menu.append(makeItem(e));
    }
  }

  document.body.append(menu);
  menuEl = menu;

  // не даём меню уйти за край окна
  const r = menu.getBoundingClientRect();
  const left = Math.max(6, Math.min(x, window.innerWidth - r.width - 6));
  const top = Math.max(6, Math.min(y, window.innerHeight - r.height - 6));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const onDown = (ev) => { if (!menu.contains(ev.target)) closeMenu(); };
  const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); closeMenu(); } };
  const onOther = () => closeMenu();
  // подписываемся чуть позже, чтобы не поймать то же самое нажатие, которое открыло меню
  const timer = setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onOther);
    window.addEventListener('resize', onOther);
  }, 0);
  stop = () => {
    clearTimeout(timer);
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', onOther);
    window.removeEventListener('resize', onOther);
  };
}

function makeSub(e) {
  const wrap = document.createElement('div');
  wrap.className = 'ctx-subwrap';
  const btn = makeItem({ label: e.label, raw: e.raw, noClose: true });
  const arrow = document.createElement('span');
  arrow.className = 'ctx-arrow';
  arrow.textContent = '›';
  btn.append(arrow);
  const sm = document.createElement('div');
  sm.className = 'ctx-menu ctx-sub';
  sm.setAttribute('role', 'menu');
  for (const it of e.submenu) sm.append(it.separator ? Object.assign(document.createElement('div'), { className: 'ctx-sep' }) : makeItem(it));
  const open = () => {
    for (const o of document.querySelectorAll('.ctx-sub.open')) if (o !== sm) o.classList.remove('open');
    sm.classList.add('open');
    const r = btn.getBoundingClientRect();
    const w = sm.offsetWidth || 240;
    const left = r.right + 4 + w > window.innerWidth ? Math.max(6, r.left - w - 4) : r.right + 4;
    sm.style.left = `${left}px`;
    sm.style.top = `${Math.max(6, Math.min(r.top - 5, window.innerHeight - sm.offsetHeight - 6))}px`;
  };
  wrap.addEventListener('mouseenter', open);
  wrap.addEventListener('mouseleave', () => sm.classList.remove('open'));
  btn.addEventListener('click', open);
  wrap.append(btn, sm);
  return wrap;
}

function makeItem(e) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ctx-item';
  btn.setAttribute('role', 'menuitem');
  btn.disabled = !!e.disabled;

  const mark = document.createElement('span');
  mark.className = 'ctx-mark';
  if (e.swatch) {
    mark.classList.add('swatch');
    mark.style.background = e.swatch;
  } else {
    mark.textContent = e.checked ? '✓' : '';
  }

  const label = document.createElement('span');
  label.textContent = e.label;
  if (e.raw) label.setAttribute('translate', 'no');
  btn.append(mark, label);

  btn.addEventListener('click', () => {
    if (e.noClose) return;
    closeMenu();
    if (e.onClick) e.onClick();
  });
  return btn;
}

function makeIconGrid(e) {
  const wrap = document.createElement('div');
  wrap.className = 'ctx-icons';

  for (const icon of e.icons) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx-icon' + (icon === e.current ? ' current' : '');
    b.textContent = icon;
    b.addEventListener('click', () => {
      closeMenu();
      e.onPick(icon);
    });
    wrap.append(b);
  }

  const none = document.createElement('button');
  none.type = 'button';
  none.className = 'ctx-icon-none';
  none.textContent = 'Без иконки';
  none.addEventListener('click', () => {
    closeMenu();
    e.onPick(null);
  });
  wrap.append(none);
  return wrap;
}
