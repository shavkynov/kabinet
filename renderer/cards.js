// Вид карточки персонажа или места в центре окна: заголовок и поля.
// Данные карточки (как в файле): { short, aliases, inflect, fields: [{ name, value }] }.
// inflect: склонять имя автоматически (по умолчанию да; в файле хранится только inflect: false).
// «Краткая справка» (short) есть всегда и идёт первой; остальные поля берутся из шаблона.

import { t } from './i18n.js';

export const SHORT_LABEL = 'Краткая справка';
export const SHORT_HINT = 'Показывается во всплывающей подсказке. Если пусто, берётся «Общее описание».';

export const ALIAS_LABEL = 'Имена в тексте';
export const ALIAS_HINT = 'Как это имя встречается в тексте: падежи, прозвища. Через запятую. Совпадения подсвечиваются в главах.';
export const IGNORE_LABEL = 'Не считать ссылкой';
export const IGNORE_HINT = 'Слова, которые не нужно подсвечивать. Пополняется из меню правого клика в тексте.';

const splitNames = (v) => [...new Set(String(v).split(/[,;\n]/).map((x) => x.trim()).filter(Boolean))];

export function createCardView({ root, onChange, onTitle, onAddField, onKey, onPickImage, getImageUrl, onOpenChapter, onProtagonist, onCommit }) {
  const titleInput = root.querySelector('#cardTitle');
  const fieldsEl = root.querySelector('#cardFields');
  const addBtn = root.querySelector('#cardAddField');
  const protagRow = root.querySelector('#cardProtagRow');
  const protagBox = root.querySelector('#cardProtag');
  const inflectBox = root.querySelector('#cardInflect');
  const mentionsEl = root.querySelector('#cardMentions');

  let data = null;
  let savedTitle = '';
  let fieldOffset = 1; // сколько полей ввода стоит перед полями шаблона
  const photo = root.querySelector('#cardPhoto');
  const img = root.querySelector('#cardImg');
  const pickBtn = root.querySelector('#cardPhotoPick');
  const clearBtn = root.querySelector('#cardPhotoClear');
  let imageToken = 0;

  async function renderPhoto() {
    const token = ++imageToken;
    const file = data && data.image;
    clearBtn.hidden = !file;
    pickBtn.textContent = file ? 'Заменить фото' : 'Добавить фото';
    photo.classList.toggle('has-image', !!file);
    img.hidden = !file;
    if (!file) { img.removeAttribute('src'); return; }
    try {
      const url = await getImageUrl(file);
      if (token === imageToken) img.src = url;
    } catch (err) {
      console.error('image:', err);
      if (token === imageToken) img.hidden = true;
    }
  }

  function autosize(ta) {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }

  function autosizeAll() {
    fieldsEl.querySelectorAll('textarea').forEach(autosize);
  }

  function block({ label, hint, value, onInput, onRemove }) {
    const sec = document.createElement('section');
    sec.className = 'cf';

    const head = document.createElement('div');
    head.className = 'cf-head';
    const lab = document.createElement('label');
    lab.textContent = label;
    if (onRemove) lab.setAttribute('translate', 'no'); // название поля из шаблона: данные автора
    head.append(lab);
    if (onRemove) {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'cf-x';
      x.textContent = '×';
      x.title = 'Убрать поле из этой карточки';
      x.addEventListener('click', onRemove);
      head.append(x);
    }
    sec.append(head);

    if (hint) {
      const h = document.createElement('p');
      h.className = 'cf-hint';
      h.textContent = hint;
      sec.append(h);
    }

    const ta = document.createElement('textarea');
    ta.rows = 1;
    ta.value = value;
    ta.addEventListener('input', () => {
      onInput(ta.value);
      autosize(ta);
      onChange();
    });
    ta.addEventListener('keydown', (e) => { if (onKey) onKey(e); });
    ta.addEventListener('change', () => { if (onCommit) onCommit(); }); // поле закончили править (потеря фокуса)
    lab.addEventListener('click', () => ta.focus());
    sec.append(ta);
    return sec;
  }

  function render() {
    fieldsEl.textContent = '';
    fieldsEl.append(block({
      label: SHORT_LABEL,
      hint: SHORT_HINT,
      value: data.short,
      onInput: (v) => { data.short = v; },
    }));
    fieldsEl.append(block({
      label: ALIAS_LABEL,
      hint: ALIAS_HINT,
      value: data.aliases.join(', '),
      onInput: (v) => { data.aliases = splitNames(v); },
    }));
    fieldOffset = 2;
    if (data.ignore.length) {
      fieldsEl.append(block({
        label: IGNORE_LABEL,
        hint: IGNORE_HINT,
        value: data.ignore.join(', '),
        onInput: (v) => { data.ignore = splitNames(v); },
      }));
      fieldOffset = 3;
    }
    data.fields.forEach((f, i) => {
      fieldsEl.append(block({
        label: f.name,
        value: f.value,
        onInput: (v) => { f.value = v; },
        onRemove: () => {
          if (f.value.trim() && !confirm(t('Убрать поле «{0}» вместе с его текстом?', f.name))) return;
          data.fields.splice(i, 1);
          render();
          onChange();
        },
      }));
    });
    requestAnimationFrame(autosizeAll);
  }

  titleInput.addEventListener('change', async () => {
    const value = titleInput.value.trim();
    if (!value || value === savedTitle) {
      titleInput.value = savedTitle;
      return;
    }
    await onTitle(value);
  });
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      titleInput.blur();
    } else if (e.key === 'Escape') {
      titleInput.value = savedTitle;
      titleInput.blur();
    }
  });

  addBtn.addEventListener('click', () => onAddField(addBtn.getBoundingClientRect()));
  protagBox.addEventListener('change', () => {
    if (!data) return;
    data.protagonist = protagBox.checked;
    onChange();
    if (onProtagonist) onProtagonist(data.protagonist);
  });
  inflectBox.addEventListener('change', () => {
    if (!data) return;
    data.inflect = inflectBox.checked;
    onChange();
  });
  pickBtn.addEventListener('click', async () => {
    if (!data) return;
    const file = await onPickImage();
    if (!file) return;
    data.image = file;
    renderPhoto();
    onChange();
  });
  clearBtn.addEventListener('click', () => {
    if (!data) return;
    data.image = '';
    renderPhoto();
    onChange();
  });

  return {
    show({ title, card, kind }) {
      savedTitle = title;
      titleInput.value = title;
      protagRow.hidden = kind !== 'character';
      protagBox.checked = card.protagonist === true;
      inflectBox.checked = card.inflect !== false;
      mentionsEl.hidden = true;
      data = {
        protagonist: card.protagonist === true,
        inflect: card.inflect !== false,
        short: String(card.short ?? ''),
        aliases: Array.isArray(card.aliases) ? card.aliases.map(String) : [],
        ignore: Array.isArray(card.ignore) ? card.ignore.map(String) : [],
        image: typeof card.image === 'string' ? card.image : '',
        fields: Array.isArray(card.fields)
          ? card.fields.map((f) => ({ name: String(f.name ?? 'Поле'), value: String(f.value ?? '') }))
          : [],
      };
      render();
      renderPhoto();
      root.parentElement.scrollTop = 0;
    },

    /** Где встречается карточка: { protagonist, chapters: [{ id, title, n, count }] }. null: спрятать. */
    setMentions(res) {
      mentionsEl.textContent = '';
      if (!res || res.protagonist || (data && data.protagonist)) { mentionsEl.hidden = true; return; }
      const head = document.createElement('div');
      head.className = 'cf-head';
      const lab = document.createElement('label');
      lab.textContent = t('Встречается в главах');
      head.append(lab);
      mentionsEl.append(head);
      if (!res.chapters.length) {
        const none = document.createElement('p');
        none.className = 'cf-hint';
        none.textContent = t('Пока не встречается ни в одной главе. Имена берутся из названия и поля «Имена в тексте».');
        mentionsEl.append(none);
      } else {
        const box = document.createElement('div');
        box.className = 'mention-list';
        for (const c of res.chapters) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'mention secondary small';
          b.setAttribute('translate', 'no');
          b.title = c.title;
          b.textContent = `${c.n}. ${c.title}`;
          const cnt = document.createElement('span');
          cnt.className = 'mention-n';
          cnt.textContent = `×${c.count}`;
          b.append(cnt);
          b.addEventListener('click', () => { if (onOpenChapter) onOpenChapter(c.id); });
          box.append(b);
        }
        mentionsEl.append(box);
      }
      mentionsEl.hidden = false;
    },

    setTitle(title) {
      savedTitle = title;
      titleInput.value = title;
    },

    /** Текст для записи в файл. */
    toJSON() {
      return JSON.stringify(data);
    },

    fieldNames() {
      return data ? data.fields.map((f) => f.name) : [];
    },

    addField(name) {
      const clean = String(name).replace(/\s+/g, ' ').trim().slice(0, 100);
      if (!data || !clean) return false;
      const same = (a) => a.toLowerCase() === clean.toLowerCase();
      const exists = data.fields.findIndex((f) => same(f.name));
      if (exists >= 0 || same(SHORT_LABEL)) {
        const tas = fieldsEl.querySelectorAll('textarea');
        const ta = tas[exists >= 0 ? exists + fieldOffset : 0];
        if (ta) ta.focus();
        return false;
      }
      data.fields.push({ name: clean, value: '' });
      render();
      onChange();
      const tas = fieldsEl.querySelectorAll('textarea');
      const last = tas[tas.length - 1];
      if (last) last.focus();
      return true;
    },

    focusFirst() {
      const ta = fieldsEl.querySelector('textarea');
      if (ta) ta.focus();
    },
  };
}
