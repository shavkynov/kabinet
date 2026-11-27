'use strict';

// Ежедневная серия (стрик): считается локально на одном устройстве, по всем проектам,
// учитываются только слова, набранные вручную. Новый день наступает в 4:00 по местному времени.

const DEFAULT_GOAL = 1000;
const MIN_GOAL = 50;
const MAX_GOAL = 50000;
const DAY_CUTOFF_HOUR = 4;
const KEEP_DAYS = 400;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function toIsoDate(d) {
  const y = String(d.getFullYear()).padStart(4, '0');
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseIsoDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Дата «писательского дня» в формате YYYY-MM-DD: до 04:00 считается вчерашним днём. */
function writingDay(now = new Date()) {
  const src = now instanceof Date ? now : new Date(now);
  const d = Number.isNaN(src.getTime()) ? new Date() : src;
  const shift = d.getHours() < DAY_CUTOFF_HOUR ? -1 : 0;
  return toIsoDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + shift));
}

function addDays(iso, delta) {
  const d = parseIsoDate(iso);
  d.setDate(d.getDate() + delta);
  return toIsoDate(d);
}

/** День недели по местному календарю: 0 = Вс, 1 = Пн … 6 = Сб. */
function weekdayOf(iso) {
  return parseIsoDate(iso).getDay();
}

function clampGoal(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_GOAL;
  return Math.max(MIN_GOAL, Math.min(MAX_GOAL, n));
}

function normalizeDays(rawDays, fallbackGoal) {
  const days = {};
  if (!rawDays || typeof rawDays !== 'object') return days;
  for (const [iso, entry] of Object.entries(rawDays)) {
    if (!ISO_RE.test(iso) || !entry || typeof entry !== 'object') continue;
    const words = Math.max(0, Math.floor(Number(entry.words) || 0));
    const goal = clampGoal(entry.goal || fallbackGoal);
    const clean = { words, goal };
    if (entry.rest === true) clean.rest = true;
    days[iso] = clean;
  }
  return days;
}

function normalizeState(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const goal = clampGoal(src.goal);
  const restDays = Array.isArray(src.restDays)
    ? [...new Set(src.restDays.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))].sort((a, b) => a - b).slice(0, 6)
    : [];
  const restEffectiveFrom = typeof src.restEffectiveFrom === 'string' && ISO_RE.test(src.restEffectiveFrom)
    ? src.restEffectiveFrom : null;
  const days = normalizeDays(src.days, goal);
  const best = Math.max(0, Math.floor(Number(src.best) || 0));
  return { version: 1, goal, restDays, restEffectiveFrom, days, best };
}

function loadStreak(raw) {
  if (!raw) return normalizeState(null);
  if (typeof raw === 'string') {
    try { return normalizeState(JSON.parse(raw)); } catch { return normalizeState(null); }
  }
  return normalizeState(raw);
}

function pruneDays(days, today) {
  const minIso = addDays(today, -KEEP_DAYS);
  const out = {};
  for (const [iso, entry] of Object.entries(days)) {
    if (iso >= minIso) out[iso] = entry;
  }
  return out;
}

function isRestDay(state, iso) {
  if (state.restEffectiveFrom && iso >= state.restEffectiveFrom) {
    return state.restDays.includes(weekdayOf(iso));
  }
  return !!(state.days[iso] && state.days[iso].rest === true);
}

function dayGoal(state, iso, today) {
  if (iso === today) return state.goal;
  return state.days[iso] ? clampGoal(state.days[iso].goal || state.goal) : state.goal;
}

function computeStreak(rawState, now = new Date()) {
  const state = normalizeState(rawState);
  const today = writingDay(now);
  const todayEntry = state.days[today];
  const todayWords = todayEntry ? todayEntry.words : 0;
  const goal = state.goal;
  const metToday = todayWords >= goal;

  let current = metToday ? 1 : 0;
  for (let i = 1; i <= KEEP_DAYS; i += 1) {
    const iso = addDays(today, -i);
    const words = state.days[iso] ? state.days[iso].words : 0;
    const met = words >= dayGoal(state, iso, today);
    if (met) {
      current += 1;
    } else if (isRestDay(state, iso)) {
      continue;
    } else {
      break;
    }
  }

  const best = Math.max(state.best || 0, current);
  const last14 = [];
  for (let i = 13; i >= 0; i -= 1) {
    const iso = addDays(today, -i);
    const words = state.days[iso] ? state.days[iso].words : 0;
    const g = dayGoal(state, iso, today);
    last14.push({
      date: iso,
      words,
      goal: g,
      met: words >= g,
      rest: isRestDay(state, iso),
      today: i === 0,
      weekday: weekdayOf(iso),
    });
  }

  return {
    today,
    todayWords,
    goal,
    metToday,
    remaining: Math.max(0, goal - todayWords),
    current,
    best,
    restDays: [...state.restDays],
    last14,
  };
}

function cloneState(state) {
  const days = {};
  for (const [k, v] of Object.entries(state.days)) days[k] = { ...v };
  return {
    version: 1,
    goal: state.goal,
    restDays: [...state.restDays],
    restEffectiveFrom: state.restEffectiveFrom,
    days,
    best: state.best,
  };
}

function recordTypedWords(rawState, count, now = new Date()) {
  const base = normalizeState(rawState);
  const add = Math.floor(Number(count) || 0);
  if (add <= 0) {
    return { state: base, reachedTodayNow: false, summary: computeStreak(base, now) };
  }
  const today = writingDay(now);
  const before = computeStreak(base, now);
  const next = cloneState(base);
  const cur = next.days[today] || { words: 0, goal: next.goal };
  cur.words += add;
  cur.goal = next.goal;
  next.days[today] = cur;
  next.days = pruneDays(next.days, today);
  const summary = computeStreak(next, now);
  next.best = Math.max(next.best, summary.current);
  summary.best = next.best;
  return {
    state: next,
    reachedTodayNow: !before.metToday && summary.metToday,
    summary,
  };
}

function setDailyGoal(rawState, goal, now = new Date()) {
  const base = normalizeState(rawState);
  const g = clampGoal(goal);
  const today = writingDay(now);
  const next = cloneState(base);
  next.goal = g;
  if (next.days[today]) next.days[today].goal = g;
  const summary = computeStreak(next, now);
  next.best = Math.max(next.best, summary.current);
  summary.best = next.best;
  return { state: next, summary };
}

function toggleRestDay(rawState, weekday, now = new Date()) {
  const base = normalizeState(rawState);
  const wd = Number(weekday);
  if (!Number.isInteger(wd) || wd < 0 || wd > 6) {
    return { state: base, changed: false, summary: computeStreak(base, now) };
  }
  const today = writingDay(now);
  const has = base.restDays.includes(wd);
  if (!has && base.restDays.length >= 6) {
    return { state: base, changed: false, limitReached: true, summary: computeStreak(base, now) };
  }

  const next = cloneState(base);
  // Закрепляем прошлые выходные до вчерашнего дня, чтобы смена расписания не ломала уже пройденные дни,
  // а новое правило действовало только с сегодняшнего дня (задним числом вчерашний пропуск не спасается).
  if (base.restEffectiveFrom && base.restDays.length) {
    const earliest = addDays(today, -KEEP_DAYS);
    const start = base.restEffectiveFrom > earliest ? base.restEffectiveFrom : earliest;
    const yesterday = addDays(today, -1);
    for (let d = start; d <= yesterday; d = addDays(d, 1)) {
      if (base.restDays.includes(weekdayOf(d))) {
        next.days[d] = { ...(next.days[d] || { words: 0, goal: next.goal }), rest: true };
      }
    }
  }
  next.days = pruneDays(next.days, today);
  if (has) next.restDays = next.restDays.filter((x) => x !== wd);
  else next.restDays = [...next.restDays, wd].sort((a, b) => a - b);
  next.restEffectiveFrom = today;

  const summary = computeStreak(next, now);
  next.best = Math.max(next.best, summary.current);
  summary.best = next.best;
  return { state: next, changed: true, summary };
}

module.exports = {
  DEFAULT_GOAL,
  MIN_GOAL,
  MAX_GOAL,
  DAY_CUTOFF_HOUR,
  KEEP_DAYS,
  writingDay,
  addDays,
  weekdayOf,
  clampGoal,
  normalizeState,
  loadStreak,
  isRestDay,
  computeStreak,
  recordTypedWords,
  setDailyGoal,
  toggleRestDay,
};
