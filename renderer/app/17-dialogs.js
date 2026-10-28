// ---------- маленькие диалоги: название поля, шаблоны ----------

// prompt() в Electron не работает, поэтому свой диалог.
function askText(title, initial = '') {
  return new Promise((resolve) => {
    const dlg = $('#textDialog');
    const input = $('#textDialogInput');
    $('#textDialogTitle').textContent = title;
    input.value = initial;
    dlg.returnValue = '';
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      const v = input.value.trim();
      resolve(dlg.returnValue === 'ok' && v ? v : null);
    };
    dlg.addEventListener('close', onClose);
    dlg.showModal();
    input.focus();
    input.select();
  });
}

// Enter в поле диалога подтверждает его (по умолчанию сработала бы «Отмена»: она первая в форме).
function enterConfirms(dlg, input) {
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    if (!input.value.trim()) return;
    dlg.close('ok');
  });
}

let tplKind = 'character';
let tplDraft = { character: [], place: [] };

function renderTemplateRows(focusLast) {
  const box = $('#tplList');
  box.textContent = '';
  const list = tplDraft[tplKind];
  list.forEach((name, i) => {
    const row = document.createElement('div');
    row.className = 'tpl-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = name;
    input.maxLength = 100;
    input.autocomplete = 'off';
    input.addEventListener('input', () => { list[i] = input.value; });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        list.splice(i + 1, 0, '');
        renderTemplateRows(i + 1);
      }
    });
    const mkBtn = (label, title, fn, disabled) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.disabled = !!disabled;
      b.addEventListener('click', fn);
      return b;
    };
    const swap = (a, b) => { [list[a], list[b]] = [list[b], list[a]]; renderTemplateRows(); };
    row.append(
      input,
      mkBtn('↑', 'Выше', () => swap(i, i - 1), i === 0),
      mkBtn('↓', 'Ниже', () => swap(i, i + 1), i === list.length - 1),
      mkBtn('×', 'Убрать', () => { list.splice(i, 1); renderTemplateRows(); }),
    );
    box.append(row);
  });
  if (focusLast !== undefined) {
    const inputs = box.querySelectorAll('input');
    const target = inputs[focusLast === true ? inputs.length - 1 : focusLast];
    if (target) target.focus();
  }
}

function openTemplates(kind) {
  if (!project) return;
  const tpl = project.templates || {};
  tplDraft = { character: [...(tpl.character || [])], place: [...(tpl.place || [])] };
  tplKind = kind === 'place' ? 'place' : 'character';
  document.querySelectorAll('input[name="tplKind"]').forEach((r) => { r.checked = r.value === tplKind; });
  renderTemplateRows();
  const dlg = $('#tplDialog');
  dlg.returnValue = '';
  dlg.showModal();
}

function wireTemplates() {
  const dlg = $('#tplDialog');
  document.querySelectorAll('input[name="tplKind"]').forEach((r) => {
    r.addEventListener('change', () => {
      if (!r.checked) return;
      tplKind = r.value;
      renderTemplateRows();
    });
  });
  $('#tplAdd').addEventListener('click', () => {
    tplDraft[tplKind].push('');
    renderTemplateRows(true);
  });
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue !== 'ok') return;
    try {
      for (const kind of ['character', 'place']) {
        const names = tplDraft[kind].map((n) => n.trim()).filter(Boolean);
        const old = (project.templates && project.templates[kind]) || [];
        if (JSON.stringify(names) !== JSON.stringify(old)) project = await api.setTemplate(kind, names);
      }
    } catch (err) {
      showError(err.message);
    }
  });
  enterConfirms($('#textDialog'), $('#textDialogInput'));
}

