// ---------- обратная связь и журнал ----------
// Отчёт (сообщение, версия, система и журнал) копируется в буфер обмена, а страница нового обращения на GitHub
// открывается с заголовком и началом текста: адрес не вмещает весь журнал.

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* запасной путь ниже */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* нет доступа к буферу */ }
  ta.remove();
  return ok;
}

function openFeedback() {
  const dlg = $('#feedbackDialog');
  const text = $('#fbText');
  const hint = $('#fbHint');
  hint.textContent = '';
  const kind = () => (document.querySelector('input[name="fbKind"]:checked') || {}).value || 'Ошибка';
  const done = async (send) => {
    const body = text.value.trim();
    if (!body) { hint.textContent = t('Опишите, что случилось.'); text.focus(); return; }
    const withLog = $('#fbLog').checked;
    try {
      const report = await api.feedbackReport(kind(), body, withLog);
      const copied = await copyText(report);
      if (send) await api.feedbackOpen(kind(), body, withLog);
      dlg.close();
      text.value = '';
      if (!copied) setStatus('error', t('Не удалось скопировать отчёт. Откройте журнал через «Справка → Открыть папку журнала».'));
      else setStatus('ok', send ? t('Отчёт скопирован. На странице GitHub вставьте его в сообщение (Ctrl+V).') : t('Отчёт скопирован в буфер обмена'));
    } catch (e) { hint.textContent = e.message; }
  };
  $('#fbSend').onclick = () => done(true);
  $('#fbCopy').onclick = () => done(false);
  $('#fbCancel').onclick = () => dlg.close();
  dlg.showModal();
  text.focus();
}

let updateCheckToken = 0;

async function openUpdateCheck() {
  const dlg = $('#updateDialog');
  const status = $('#updStatus');
  const notes = $('#updNotes');
  const openBtn = $('#updOpen');
  const closeBtn = $('#updClose');
  if (!dlg || !status) return;

  const token = ++updateCheckToken;
  status.textContent = t('Проверяю обновления…');
  if (notes) { notes.hidden = true; notes.textContent = ''; }
  if (openBtn) { openBtn.hidden = true; openBtn.onclick = null; }
  if (closeBtn) closeBtn.onclick = () => dlg.close();
  if (!dlg.open) dlg.showModal();

  try {
    const res = await api.checkUpdates();
    if (token !== updateCheckToken) return;
    if (res && res.hasUpdate) {
      status.textContent = t('Доступна новая версия {0} (у вас {1}).', res.latest, res.current);
      if (notes && res.notes) {
        notes.textContent = res.notes;
        notes.hidden = false;
      }
      if (openBtn) {
        openBtn.hidden = false;
        openBtn.onclick = () => {
          api.openReleaseUrl(res.url).catch((err) => showError(err.message));
          dlg.close();
        };
      }
    } else {
      status.textContent = t('Установлена последняя версия ({0}).', (res && res.current) || '');
    }
  } catch (err) {
    if (token !== updateCheckToken) return;
    status.textContent = tdom((err && err.message) || 'Не удалось проверить обновления.');
  }
}
