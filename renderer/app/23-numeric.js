// ---------- числа: ползунок + поле для ввода ----------

function bindNumeric(key) {
  const id = key.charAt(0).toUpperCase() + key.slice(1);
  const slider = $(`#set${id}`);
  const num = $(`#num${id}`);
  const lim = LIMITS[key];

  const commit = (v) => {
    const clamped = Math.min(lim.max, Math.max(lim.min, v));
    settings[key] = Number(clamped.toFixed(lim.decimals));
    applySettings();
    saveSettings();
  };
  const fromText = () => {
    const v = parseFloat(num.value.replace(',', '.'));
    if (Number.isFinite(v)) commit(v);
    else applySettings(); // непонятный ввод: возвращаем прежнее значение
  };

  slider.addEventListener('input', () => commit(Number(slider.value)));
  num.addEventListener('change', fromText);
  num.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      fromText();
      num.select();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const cur = parseFloat(num.value.replace(',', '.'));
      const base = Number.isFinite(cur) ? cur : settings[key];
      commit(base + (e.key === 'ArrowUp' ? lim.step : -lim.step));
      num.select();
    }
  });
  num.addEventListener('focus', () => num.select());
}

function bindSetting(selector, key, read) {
  $(selector).addEventListener('input', (e) => {
    settings[key] = read(e.target);
    applySettings();
    saveSettings();
    if (key === 'typewriter' && settings.typewriter) recenterNow();
  });
}

function toggleTypewriter() {
  settings.typewriter = !settings.typewriter;
  applySettings();
  saveSettings();
  if (settings.typewriter) recenterNow();
}

// Пустое место сверху и снизу листа равно половине высоты окна: так любая строка может встать по центру.
function updateTwPad() {
  const area = $('#paper-area');
  document.documentElement.style.setProperty('--tw-pad', `${Math.floor(area.clientHeight / 2)}px`);
}

function centerCaret() {
  if (!settings.typewriter || !editor || !editor.isEditable) return;
  const area = $('#paper-area');
  let rect;
  try {
    rect = editor.view.coordsAtPos(editor.state.selection.head);
  } catch {
    return;
  }
  const box = area.getBoundingClientRect();
  const delta = (rect.top + rect.bottom) / 2 - (box.top + area.clientHeight / 2);
  twTarget = area.scrollTop + delta;
  if (!twRaf) twRaf = requestAnimationFrame(twStep);
}

// Плавное движение листа к цели; не зацикливается, если упёрлись в край.
function twStep() {
  twRaf = 0;
  const area = $('#paper-area');
  const diff = twTarget - area.scrollTop;
  if (Math.abs(diff) < 0.5) {
    area.scrollTop = twTarget;
    return;
  }
  const before = area.scrollTop;
  area.scrollTop = before + diff * 0.3;
  if (Math.abs(area.scrollTop - before) < 0.05) return;
  twRaf = requestAnimationFrame(twStep);
}

function scheduleCenter() {
  if (!settings.typewriter || !followCaret || loading) return;
  requestAnimationFrame(centerCaret);
}

function recenterNow() {
  followCaret = true;
  requestAnimationFrame(centerCaret);
}

