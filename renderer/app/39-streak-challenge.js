// ---------- серия дней (стрики) и режим вызова ----------

const STREAK_STORAGE_KEY = 'kabinet.streak';
const STREAK_WEEKDAYS = [
  { wd: 1, label: 'Пн' },
  { wd: 2, label: 'Вт' },
  { wd: 3, label: 'Ср' },
  { wd: 4, label: 'Чт' },
  { wd: 5, label: 'Пт' },
  { wd: 6, label: 'Сб' },
  { wd: 0, label: 'Вс' },
];

let streakCache = null;
let streakHitTimer = null;
let challengeSession = null;
let challengeTimer = null;
let challengePrevFocus = false;
let challengeFinishing = false;
let challengeKind = 'sprint';
const challengePresetByKind = { sprint: '15m', marathon: '30m', pomodoro: '4r' };

function readStreakState() {
  if (streakCache) return streakCache;
  let raw = null;
  try { raw = localStorage.getItem(STREAK_STORAGE_KEY); } catch { /* ignore */ }
  streakCache = loadStreak(raw);
  return streakCache;
}

function writeStreakState(state) {
  streakCache = state;
  try { localStorage.setItem(STREAK_STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

function streakDaysForm(k) {
  if (LANG === 'en') return k === 1 ? 'day' : 'days';
  const m10 = k % 10;
  const m100 = k % 100;
  if (m10 === 1 && m100 !== 11) return 'день';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'дня';
  return 'дней';
}

function isChallengeActive() {
  return !!challengeSession;
}

function refreshStreakBadge() {
  const btn = $('#barStreak');
  const num = $('#barStreakNum');
  if (!btn || !num) return;
  const summary = computeStreak(readStreakState());
  const n = (v) => v.toLocaleString(LOCALE);
  num.textContent = n(summary.current);
  btn.classList.toggle('met', summary.metToday);
  btn.title = t(
    'Серия: {0} {1} · Сегодня {2} из {3} слов',
    n(summary.current),
    streakDaysForm(summary.current),
    n(summary.todayWords),
    n(summary.goal),
  );
  const pop = $('#streakPop');
  btn.setAttribute('aria-expanded', pop && !pop.hidden ? 'true' : 'false');
  if (pop && !pop.hidden) renderStreakPop(summary);
}

function renderStreakPop(precomputed) {
  const summary = precomputed || computeStreak(readStreakState());
  const n = (v) => v.toLocaleString(LOCALE);
  $('#stStreakCur').textContent = `${n(summary.current)} ${streakDaysForm(summary.current)}`;
  $('#stStreakBest').textContent = t('Рекорд: {0}', n(summary.best));
  $('#stTodayText').textContent = `${n(summary.todayWords)} / ${n(summary.goal)} ${wordsForm(summary.goal)}`;
  $('#stTodaySub').textContent = summary.metToday
    ? t('Цель на сегодня выполнена')
    : t('Осталось {0} {1}', n(summary.remaining), wordsForm(summary.remaining));
  const pct = summary.goal > 0 ? Math.min(100, Math.round((summary.todayWords / summary.goal) * 100)) : 0;
  $('#stTodayFill').style.width = `${summary.todayWords > 0 ? Math.max(3, pct) : 0}%`;

  const daysBox = $('#stDays');
  daysBox.textContent = '';
  for (const d of summary.last14) {
    const cell = document.createElement('div');
    cell.className = 'st-day';
    if (d.met) cell.classList.add('met');
    else if (d.rest) cell.classList.add('rest');
    if (d.today) cell.classList.add('today');
    const restLabel = d.rest ? ` · ${t('выходной')}` : '';
    cell.title = `${d.date}: ${n(d.words)} / ${n(d.goal)}${restLabel}`;
    const bar = document.createElement('i');
    const fillPct = d.goal > 0 ? Math.min(100, Math.round((d.words / d.goal) * 100)) : 0;
    bar.style.height = `${d.words > 0 ? Math.max(14, fillPct) : 0}%`;
    cell.append(bar);
    daysBox.append(cell);
  }

  document.querySelectorAll('#stGoalPresets button[data-goal]').forEach((b) => {
    const on = Number(b.dataset.goal) === summary.goal;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });

  const inp = $('#stGoalInput');
  if (inp && document.activeElement !== inp) inp.value = String(summary.goal);

  const restBox = $('#stRestDays');
  restBox.textContent = '';
  for (const item of STREAK_WEEKDAYS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'st-wd';
    b.dataset.wd = String(item.wd);
    const on = summary.restDays.includes(item.wd);
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.textContent = t(item.label);
    restBox.append(b);
  }
}

function openStreakPop() {
  if (!project || isChallengeActive()) return;
  if (typeof closeGoalPop === 'function') closeGoalPop();
  if (typeof closeProjPop === 'function') closeProjPop();
  const pop = $('#streakPop');
  renderStreakPop();
  pop.hidden = false;
  $('#barStreak').classList.add('on');
  $('#barStreak').setAttribute('aria-expanded', 'true');
  if (!document.body.classList.contains('m-narrow')) {
    const r = $('#barStreak').getBoundingClientRect();
    const w = pop.offsetWidth || 320;
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    pop.style.bottom = `${Math.max(8, window.innerHeight - r.top + 8)}px`;
  } else {
    pop.style.left = '';
    pop.style.bottom = '';
  }
}

function closeStreakPop() {
  const pop = $('#streakPop');
  if (!pop || pop.hidden) return;
  pop.hidden = true;
  if ($('#barStreak')) {
    $('#barStreak').classList.remove('on');
    $('#barStreak').setAttribute('aria-expanded', 'false');
  }
}

function commitStreakGoalInput() {
  const inp = $('#stGoalInput');
  if (!inp) return;
  const parsed = Number(String(inp.value).replace(/[^\d]/g, ''));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    inp.value = String(readStreakState().goal);
    return;
  }
  const clamped = Math.max(MIN_GOAL, Math.min(MAX_GOAL, Math.round(parsed)));
  const res = setDailyGoal(readStreakState(), clamped, new Date());
  writeStreakState(res.state);
  inp.value = String(res.summary.goal);
  refreshStreakBadge();
}

function onManualEditorInput({ delta, inserted, fromPane2 = false }) {
  if (delta > 0 && project && (currentKind === 'chapter' || fromPane2)) {
    addToday(delta);
    refreshBar();
  }
  if (delta > 0) {
    const { state, reachedTodayNow } = recordTypedWords(readStreakState(), delta, new Date());
    writeStreakState(state);
    refreshStreakBadge();
    if (reachedTodayNow && !isChallengeActive()) {
      if (settings.goalChime) sounds.chime();
      const btn = $('#barStreak');
      if (btn) {
        btn.classList.remove('hit');
        void btn.offsetWidth;
        btn.classList.add('hit');
        clearTimeout(streakHitTimer);
        streakHitTimer = setTimeout(() => btn.classList.remove('hit'), 1200);
      }
      setStatus('ok', t('Дневная цель выполнена!'));
    }
  }
  if (challengeSession && !challengeFinishing) {
    const events = challengeOnInput(challengeSession, { wordDelta: delta, inserted }, Date.now());
    handleChallengeEvents(events);
    renderChallengeHud();
    if (events.includes('won') || events.includes('failed')) finishChallenge();
  }
}

function formatChallengeDuration(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return `${h} ${t('ч')} ${rm} ${t('мин')}`;
  }
  if (m > 0 && s > 0) return `${m} ${t('мин')} ${s} ${t('с')}`;
  if (m > 0) return `${m} ${t('мин')}`;
  return `${s} ${t('с')}`;
}

function renderChallengeDialog() {
  const kindsBox = $('#chKindList');
  kindsBox.textContent = '';
  for (const k of CHALLENGE_ORDER) {
    const cfg = CHALLENGES[k];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ch-kind';
    b.dataset.kind = k;
    b.classList.toggle('active', k === challengeKind);
    b.setAttribute('aria-pressed', k === challengeKind ? 'true' : 'false');
    const name = document.createElement('span');
    name.className = 'ch-kind-name';
    name.textContent = t(cfg.name);
    const desc = document.createElement('span');
    desc.className = 'ch-kind-desc';
    desc.textContent = t(cfg.desc);
    b.append(name, desc);
    kindsBox.append(b);
  }

  const cfg = CHALLENGES[challengeKind];
  const presetsBox = $('#chPresetList');
  presetsBox.textContent = '';
  const selectedPresetId = challengePresetByKind[challengeKind] || cfg.defaultPreset;
  for (const p of cfg.presets) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ch-preset secondary small';
    b.dataset.preset = p.id;
    const on = p.id === selectedPresetId;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.textContent = t(p.label);
    presetsBox.append(b);
  }

  const preset = getPreset(challengeKind, selectedPresetId);
  if (challengeKind === 'marathon') {
    $('#chRuleHint').textContent = t('Паузы нет: остановка дольше 60 секунд завершает вызов. Таймер запустится с первой набранной буквы.');
  } else {
    const workMs = challengeKind === 'pomodoro' ? preset.workSec * preset.rounds * 1000 : preset.durationSec * 1000;
    const bankMs = Math.round(workMs * cfg.pauseRatio);
    $('#chRuleHint').textContent = t('Общий запас паузы (шахматные часы): {0}. Таймер запустится с первой набранной буквы.', formatClock(bankMs));
  }

  const hasChapter = !!(project && project.chapters && project.chapters.length > 0);
  $('#chChapterWarn').hidden = hasChapter;
  $('#chStartBtn').disabled = !hasChapter;
}

function openChallengeDialog() {
  if (!project || isChallengeActive()) return;
  closeStreakPop();
  closeSettings();
  if (typeof closeGoalPop === 'function') closeGoalPop();
  if (typeof closeProjPop === 'function') closeProjPop();
  if (typeof closeBoard === 'function') closeBoard();
  renderChallengeDialog();
  const dlg = $('#challengeDialog');
  dlg.returnValue = '';
  dlg.showModal();
}

function handleChallengeEvents(events) {
  if (!events || !events.length) return;
  if (events.includes('pause-expired')) {
    if (settings.goalChime) sounds.chime();
    setStatus('ok', t('Запас паузы исчерпан — таймер продолжил отсчёт'));
  } else if (events.includes('phase-break') || events.includes('phase-work')) {
    if (settings.goalChime) sounds.chime();
  }
}

function layoutChallengeHud() {
  const hud = $('#challengeHud');
  if (!hud || hud.hidden) {
    document.body.classList.remove('ch-top');
    return;
  }
  const mob = document.body.classList.contains('mob');
  const paper = $('#paper');
  const paperW = paper && paper.offsetWidth ? paper.offsetWidth : (settings ? settings.width : 720);
  const sideMargin = (window.innerWidth - paperW) / 2;
  // Для боковых рельсов нужно: 168px рельс + 22px от края + 18px зазор до текста = 208px с каждой стороны
  const topBar = mob || sideMargin < 208;
  const changed = document.body.classList.contains('ch-top') !== topBar;
  document.body.classList.toggle('ch-top', topBar);
  if (changed && challengeSession) renderChallengeHud();
}

function renderChallengeHud() {
  if (!challengeSession) return;
  const snap = challengeSnapshot(challengeSession, Date.now());
  const hud = $('#challengeHud');
  const cfg = CHALLENGES[snap.kind];
  const isTopBar = document.body.classList.contains('ch-top');

  let phase = t(cfg.name);
  if (snap.status === 'waiting') phase = `${t(cfg.name)} · ${t('готовность')}`;
  else if (snap.status === 'paused') phase = t('Пауза');
  else if (snap.kind === 'pomodoro') {
    phase = snap.status === 'break'
      ? t('Отдых · раунд {0}/{1}', snap.round, snap.rounds)
      : t('Письмо · раунд {0}/{1}', snap.round, snap.rounds);
  }
  $('#chPhase').textContent = phase;
  // В «Марафонце» слева идёт секундомер вверх, в остальных режимах — обратный отсчёт.
  $('#chTimer').textContent = snap.kind === 'marathon'
    ? formatElapsed(snap.elapsedWorkMs)
    : formatClock(snap.remainingMs);

  let subTime = '';
  if (snap.status === 'waiting' && isTopBar) {
    subTime = t('Начните печатать — таймер пойдёт сам');
  } else if (snap.kind === 'marathon') {
    subTime = snap.status === 'waiting'
      ? t('Без паузы · лимит 60 с')
      : t('Простой до сброса: {0} с', Math.ceil(snap.idleRemainingMs / 1000));
  } else if (snap.allowPause) {
    subTime = t('Пауза: {0}', formatClock(snap.pauseRemainingMs));
  }
  $('#chSubTime').textContent = subTime;

  const n = (v) => v.toLocaleString(LOCALE);
  if (snap.kind === 'sprint') {
    $('#chMetric').textContent = `${n(snap.words)} / ${n(snap.targetWords)}`;
    $('#chSubMetric').textContent = t('{0}% цели', Math.round(snap.progress * 100));
  } else if (snap.kind === 'marathon') {
    $('#chMetric').textContent = t('Цель: {0}', formatClock(snap.durationMs));
    $('#chSubMetric').textContent = `${n(snap.words)} ${wordsForm(snap.words)} · ${Math.round(snap.progress * 100)}%`;
  } else {
    $('#chMetric').textContent = `${n(snap.words)} ${wordsForm(snap.words)}`;
    $('#chSubMetric').textContent = t('Раунд {0} из {1}', snap.round, snap.rounds);
  }
  $('#chProgFill').style.width = `${Math.round(snap.progress * 100)}%`;

  $('#chWaitHint').hidden = snap.status !== 'waiting' || isTopBar;
  const pauseBtn = $('#chPauseBtn');
  pauseBtn.hidden = !snap.allowPause || snap.status === 'waiting' || snap.status === 'break';
  pauseBtn.disabled = !snap.canPause;
  pauseBtn.textContent = snap.status === 'paused' ? t('Продолжить') : t('Пауза');
  $('#chSkipBreakBtn').hidden = !(snap.kind === 'pomodoro' && snap.status === 'break');

  hud.classList.toggle('is-waiting', snap.status === 'waiting');
  hud.classList.toggle('is-paused', snap.status === 'paused');
  hud.classList.toggle('is-break', snap.status === 'break');
  hud.classList.toggle('idle-warn', snap.kind === 'marathon' && snap.idleWarn);
  hud.classList.toggle('idle-danger', snap.kind === 'marathon' && snap.status === 'running' && snap.idleRemainingMs <= 5000);
}

function tickChallenge() {
  if (!challengeSession || challengeFinishing) return;
  const events = challengeTick(challengeSession, Date.now());
  handleChallengeEvents(events);
  renderChallengeHud();
  if (events.includes('won') || events.includes('failed')) finishChallenge();
}

async function startSelectedChallenge() {
  if (!project || isChallengeActive()) return;
  const dlg = $('#challengeDialog');
  if (dlg.open) dlg.close('ok');

  if (currentKind !== 'chapter' || !currentId) {
    if (!project.chapters || !project.chapters.length) {
      showError(t('Чтобы начать вызов, сначала создайте главу.'));
      return;
    }
    await openDoc('chapter', project.chapters[0].id);
  }
  if (currentKind !== 'chapter' || !currentId || !editor || !editor.isEditable) {
    showError(t('Не удалось открыть главу для вызова.'));
    return;
  }

  closeSettings();
  if (typeof closeSearch === 'function') closeSearch(false);
  if (typeof closeBoard === 'function') closeBoard();
  if (typeof closeGoalPop === 'function') closeGoalPop();
  if (typeof closeProjPop === 'function') closeProjPop();
  closeStreakPop();
  if (p2.id && !(await closePane2())) return;

  challengePrevFocus = document.body.classList.contains('focus-mode');
  const presetId = challengePresetByKind[challengeKind] || CHALLENGES[challengeKind].defaultPreset;
  challengeSession = createSession(challengeKind, presetId);
  challengeFinishing = false;

  document.body.classList.add('challenge-mode');
  $('#challengeHud').hidden = false;
  layoutChallengeHud();
  renderChallengeHud();
  clearInterval(challengeTimer);
  challengeTimer = setInterval(tickChallenge, 250);
  editor.commands.focus();
  setTimeout(() => { layoutChallengeHud(); updateTwPad(); if (settings.typewriter) recenterNow(); }, 0);
}

function teardownChallengeShell() {
  clearInterval(challengeTimer);
  challengeTimer = null;
  challengeSession = null;
  document.body.classList.remove('challenge-mode', 'ch-top');
  const hud = $('#challengeHud');
  if (hud) {
    hud.hidden = true;
    hud.classList.remove('is-waiting', 'is-paused', 'is-break', 'idle-warn', 'idle-danger');
  }
  document.body.classList.toggle('focus-mode', !!challengePrevFocus);
}

async function confirmAbortChallengeIfActive() {
  if (!challengeSession || challengeFinishing) return true;
  if (challengeSession.status === 'waiting') {
    exitChallengeQuiet();
    return true;
  }
  const ok = await askConfirm(
    t('Прервать вызов и выйти? Написанный текст и слова дня сохранятся.'),
    t('Выйти'),
    t('Выйти из вызова?'),
  );
  if (!ok) return false;
  exitChallengeQuiet();
  return true;
}

function exitChallengeQuiet() {
  if (!challengeSession) return;
  teardownChallengeShell();
  refreshBar();
  refreshStreakBadge();
  setTimeout(() => { updateTwPad(); layoutGoal(); }, 0);
}

async function finishChallenge() {
  if (!challengeSession || challengeFinishing) return;
  challengeFinishing = true;
  const snap = challengeSnapshot(challengeSession, Date.now());
  teardownChallengeShell();
  if (snap.status === 'won' && settings.goalChime) sounds.chime();
  try { await flush(); } catch { /* сохранится по таймеру */ }
  challengeFinishing = false;
  refreshBar();
  refreshStreakBadge();
  setTimeout(() => { updateTwPad(); layoutGoal(); }, 0);
  showChallengeSummary(snap);
}

async function requestChallengeExit() {
  if (!challengeSession || challengeFinishing) return;
  if (challengeSession.status === 'waiting') {
    exitChallengeQuiet();
    return;
  }
  const ok = await askConfirm(
    t('Прервать вызов и выйти? Написанный текст и слова дня сохранятся.'),
    t('Выйти'),
    t('Выйти из вызова?'),
  );
  if (!ok || !challengeSession) return;
  challengeExitSession(challengeSession, Date.now());
  await finishChallenge();
}

function showChallengeSummary(snap) {
  const cfg = CHALLENGES[snap.kind];
  let title = t('Вызов прерван');
  let sub = `${t(cfg.name)} · ${t(snap.presetLabel)}`;
  if (snap.status === 'won') {
    title = t('Вызов выполнен!');
  } else if (snap.status === 'failed') {
    title = t('Вызов не пройден');
    sub += snap.failReason === 'idle'
      ? ` — ${t('пауза в наборе превысила 60 секунд')}`
      : ` — ${t('время вышло')}`;
  }
  $('#chSumTitle').textContent = title;
  $('#chSumSub').textContent = sub;

  const box = $('#chSumStats');
  box.textContent = '';
  const n = (v) => v.toLocaleString(LOCALE);
  const streak = computeStreak(readStreakState());
  const rows = [
    [t('Написано в вызове'), `${n(snap.words)} ${wordsForm(snap.words)}`],
    [t('Время письма'), formatChallengeDuration(snap.elapsedWorkMs)],
  ];
  if (snap.allowPause) {
    rows.push([t('Потрачено паузы'), formatClock(snap.pauseUsedMs)]);
  } else {
    rows.push([t('Макс. простой'), `${Math.round(snap.maxIdleMsSeen / 1000)} ${t('с')}`]);
  }
  rows.push([
    t('Серия дней'),
    `${n(streak.current)} ${streakDaysForm(streak.current)} (${n(streak.todayWords)} / ${n(streak.goal)})`,
  ]);

  for (const [k, v] of rows) {
    const row = document.createElement('div');
    row.className = 'ch-sum-row';
    const lbl = document.createElement('span');
    lbl.textContent = k;
    const val = document.createElement('b');
    val.textContent = v;
    row.append(lbl, val);
    box.append(row);
  }

  const dlg = $('#challengeSummaryDialog');
  dlg.returnValue = '';
  dlg.showModal();
}

function wireStreakChallenge() {
  refreshStreakBadge();

  $('#barStreak').addEventListener('click', () => {
    if ($('#streakPop').hidden) openStreakPop();
    else closeStreakPop();
  });

  $('#stGoalPresets').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-goal]');
    if (!b) return;
    const res = setDailyGoal(readStreakState(), Number(b.dataset.goal), new Date());
    writeStreakState(res.state);
    refreshStreakBadge();
  });

  const goalInput = $('#stGoalInput');
  goalInput.addEventListener('change', commitStreakGoalInput);
  goalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitStreakGoalInput();
      goalInput.blur();
    }
    if (e.key !== 'Escape') e.stopPropagation();
  });

  $('#stRestDays').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-wd]');
    if (!b) return;
    const res = toggleRestDay(readStreakState(), Number(b.dataset.wd), new Date());
    if (res.limitReached) {
      setStatus('ok', t('Хотя бы один день недели должен оставаться рабочим'));
      return;
    }
    writeStreakState(res.state);
    refreshStreakBadge();
  });

  $('#btnOpenChallenge').addEventListener('click', openChallengeDialog);

  document.addEventListener('mousedown', (e) => {
    const pop = $('#streakPop');
    if (!pop || pop.hidden) return;
    if (e.target.closest('#streakPop') || e.target.closest('#barStreak')) return;
    closeStreakPop();
  });

  $('#chKindList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-kind]');
    if (!b) return;
    challengeKind = b.dataset.kind;
    renderChallengeDialog();
  });

  $('#chPresetList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-preset]');
    if (!b) return;
    challengePresetByKind[challengeKind] = b.dataset.preset;
    renderChallengeDialog();
  });

  $('#chStartBtn').addEventListener('click', startSelectedChallenge);

  $('#chPauseBtn').addEventListener('click', () => {
    if (!challengeSession) return;
    const ev = challengeTogglePause(challengeSession, Date.now());
    handleChallengeEvents(ev);
    renderChallengeHud();
    if (challengeSession.status === 'running' && editor) editor.commands.focus();
  });

  $('#chSkipBreakBtn').addEventListener('click', () => {
    if (!challengeSession) return;
    const ev = challengeSkipBreak(challengeSession, Date.now());
    handleChallengeEvents(ev);
    renderChallengeHud();
    if (editor) editor.commands.focus();
  });

  $('#chExitBtn').addEventListener('click', () => { requestChallengeExit(); });

  $('#chSumAgain').addEventListener('click', () => {
    const dlg = $('#challengeSummaryDialog');
    if (dlg.open) dlg.close();
    openChallengeDialog();
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) tickChallenge(); });
  window.addEventListener('focus', tickChallenge);
  window.addEventListener('resize', layoutChallengeHud);
  if (typeof ResizeObserver === 'function' && $('#paper')) {
    new ResizeObserver(layoutChallengeHud).observe($('#paper'));
  }
}
