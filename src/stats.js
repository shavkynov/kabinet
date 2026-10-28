'use strict';

// Статистика письма по дням (файл stats.json в папке проекта) и расчёт «сколько слов в день до срока».
// Слова считаются как прибавка за день: стирание итог не уменьшает.

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./fsutil');

const FILE = 'stats.json';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEEP_DAYS = 400;
const DAY_MS = 86400000;

function validDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const dayNum = (s) => Math.round(new Date(`${s}T00:00:00Z`).getTime() / DAY_MS);
const dayStr = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);

function readDays(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    const out = {};
    for (const [k, v] of Object.entries(raw && raw.days && typeof raw.days === 'object' ? raw.days : {})) {
      const n = Math.floor(Number(v));
      if (validDate(k) && Number.isFinite(n) && n > 0) out[k] = Math.min(n, 1_000_000);
    }
    return out;
  } catch {
    return {};
  }
}

/** Записывает слова за день. При записи с другого устройства берём большее значение. */
function setDayWords(dir, date, words) {
  if (!validDate(date)) throw new Error('Неверная дата.');
  const n = Math.floor(Number(words));
  if (!Number.isFinite(n) || n < 0) throw new Error('Неверное число слов.');
  const days = readDays(dir);
  days[date] = Math.max(days[date] || 0, Math.min(n, 1_000_000));
  const keys = Object.keys(days).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete days[k];
  writeFileAtomic(path.join(dir, FILE), JSON.stringify({ days }, null, 2));
  return days;
}

/** Серия подряд идущих дней с текстом; если сегодня ещё пусто, считаем до вчера. */
function streak(days, today) {
  let n = dayNum(today);
  if (!(days[dayStr(n)] > 0)) n -= 1;
  let s = 0;
  while (days[dayStr(n)] > 0) { s += 1; n -= 1; }
  return s;
}

function lastDays(days, today, count) {
  const end = dayNum(today);
  const out = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = dayStr(end - i);
    out.push({ date: d, words: days[d] || 0 });
  }
  return out;
}

/** Сколько слов в день нужно до срока. null, если нет цели или срока. */
function dailyPlan(goal, total, deadline, today) {
  if (!goal || !validDate(deadline || '')) return null;
  const left = Math.max(0, goal - total);
  const daysLeft = dayNum(deadline) - dayNum(today) + 1; // сегодня и день срока включены
  if (left === 0) return { left, daysLeft: Math.max(0, daysLeft), perDay: 0, overdue: false, done: true };
  if (daysLeft < 1) return { left, daysLeft: 0, perDay: left, overdue: true, done: false };
  return { left, daysLeft, perDay: Math.ceil(left / daysLeft), overdue: false, done: false };
}

/** Всё для окна цели проекта. todayWords: счёт за сегодня из окна (может быть свежее файла). */
function summary(dir, { today, todayWords = 0, goal = null, deadline = null, total = 0 }) {
  if (!validDate(today)) throw new Error('Неверная дата.');
  const days = readDays(dir);
  const tw = Math.max(0, Math.floor(Number(todayWords) || 0));
  if (tw > (days[today] || 0)) days[today] = tw;
  const last = lastDays(days, today, 14);
  const week = last.slice(-7).reduce((a, d) => a + d.words, 0);
  return {
    last,
    streak: streak(days, today),
    avg7: Math.round(week / 7),
    plan: dailyPlan(goal, total, deadline, today),
  };
}

module.exports = { readDays, setDayWords, streak, lastDays, dailyPlan, summary, validDate };
