'use strict';

// Конфигурация и чистый автомат состояний режима вызовов («Спринт», «Марафонец», «Помодоро»).
// Всё время считается по меткам часов (now в миллисекундах), без зависимости от точности интервалов.

const PAUSE_RATIO = 1 / 6; // 10 минут паузы на каждый час вызова

const CHALLENGE_ORDER = ['sprint', 'marathon', 'pomodoro'];

const CHALLENGES = {
  sprint: {
    id: 'sprint',
    name: 'Спринт',
    desc: 'Написать цель по словам до конца таймера',
    allowPause: true,
    pauseRatio: PAUSE_RATIO,
    defaultPreset: '15m',
    presets: [
      { id: '15m', label: '500 слов · 15 мин', targetWords: 500, durationSec: 900 },
      { id: '30m', label: '1 000 слов · 30 мин', targetWords: 1000, durationSec: 1800 },
      { id: '60m', label: '2 000 слов · 60 мин', targetWords: 2000, durationSec: 3600 },
    ],
  },
  marathon: {
    id: 'marathon',
    name: 'Марафонец',
    desc: 'Писать непрерывно: пауза дольше 60 секунд завершает вызов',
    allowPause: false,
    pauseRatio: 0,
    maxIdleMs: 60000,
    warnIdleMs: 15000,
    defaultPreset: '30m',
    presets: [
      { id: '15m', label: '15 мин', durationSec: 900 },
      { id: '30m', label: '30 мин', durationSec: 1800 },
      { id: '60m', label: '60 мин', durationSec: 3600 },
    ],
  },
  pomodoro: {
    id: 'pomodoro',
    name: 'Помодоро',
    desc: 'Раунды по 25 минут письма и 5 минут отдыха',
    allowPause: true,
    pauseRatio: PAUSE_RATIO,
    defaultPreset: '4r',
    presets: [
      { id: '2r', label: '2 раунда', rounds: 2, workSec: 1500, breakSec: 300 },
      { id: '4r', label: '4 раунда', rounds: 4, workSec: 1500, breakSec: 300 },
      { id: '6r', label: '6 раундов', rounds: 6, workSec: 1500, breakSec: 300 },
    ],
  },
};

function getPreset(kind, presetId) {
  const cfg = CHALLENGES[kind] || CHALLENGES.sprint;
  const list = cfg.presets;
  return list.find((p) => p.id === presetId) || list.find((p) => p.id === cfg.defaultPreset) || list[0];
}

function formatClock(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function createSession(kind, presetIdOrOverrides) {
  const cfg = CHALLENGES[kind] || CHALLENGES.sprint;
  const presetId = typeof presetIdOrOverrides === 'string'
    ? presetIdOrOverrides
    : presetIdOrOverrides && presetIdOrOverrides.presetId;
  const base = getPreset(cfg.id, presetId);
  const ov = presetIdOrOverrides && typeof presetIdOrOverrides === 'object' ? presetIdOrOverrides : {};

  const targetWords = cfg.id === 'sprint' ? Math.max(1, Number(ov.targetWords || base.targetWords)) : 0;
  const durationMs = cfg.id === 'pomodoro' ? 0 : Math.max(1000, Number(ov.durationSec || base.durationSec) * 1000);
  const rounds = cfg.id === 'pomodoro' ? Math.max(1, Number(ov.rounds || base.rounds)) : 1;
  const workMs = cfg.id === 'pomodoro' ? Math.max(1000, Number(ov.workSec || base.workSec) * 1000) : durationMs;
  const breakMs = cfg.id === 'pomodoro' ? Math.max(1000, Number(ov.breakSec || base.breakSec) * 1000) : 0;
  const maxIdleMs = cfg.id === 'marathon' ? Math.max(1000, Number(ov.maxIdleMs || cfg.maxIdleMs)) : 0;
  const warnIdleMs = cfg.id === 'marathon' ? Math.max(1000, Number(ov.warnIdleMs || cfg.warnIdleMs)) : 0;

  const totalPlannedWorkMs = cfg.id === 'pomodoro' ? workMs * rounds : durationMs;
  const pauseBankMs = cfg.allowPause ? Math.round(totalPlannedWorkMs * cfg.pauseRatio) : 0;

  return {
    kind: cfg.id,
    presetId: base.id,
    presetLabel: base.label,
    status: 'waiting', // waiting | running | paused | break | won | failed | exited
    targetWords,
    durationMs,
    rounds,
    round: 1,
    workMs,
    breakMs,
    maxIdleMs,
    warnIdleMs,
    allowPause: cfg.allowPause,
    pauseBankMs,
    pauseUsedBeforeMs: 0,
    pauseStartedAt: null,
    phaseElapsedBeforeMs: 0,
    phaseStartedAt: null,
    totalWorkMs: 0,
    words: 0,
    startedAt: null,
    endedAt: null,
    failReason: null,
    lastInputAt: null,
    maxIdleMsSeen: 0,
  };
}

function isTerminal(session) {
  return session.status === 'won' || session.status === 'failed' || session.status === 'exited';
}

function finishAt(session, status, at, failReason = null) {
  session.status = status;
  session.endedAt = at;
  session.failReason = failReason;
}

function evaluateClock(session, now, events) {
  if (isTerminal(session) || session.status === 'waiting') return;

  if (session.status === 'paused') {
    const bankLeft = Math.max(0, session.pauseBankMs - session.pauseUsedBeforeMs);
    const elapsedPause = Math.max(0, now - session.pauseStartedAt);
    if (elapsedPause < bankLeft) return;
    const expiredAt = session.pauseStartedAt + bankLeft;
    session.pauseUsedBeforeMs = session.pauseBankMs;
    session.pauseStartedAt = null;
    session.status = 'running';
    session.phaseStartedAt = expiredAt;
    events.push('pause-expired');
  }

  if (session.kind === 'sprint') {
    const elapsed = session.phaseElapsedBeforeMs + Math.max(0, now - session.phaseStartedAt);
    if (session.words >= session.targetWords) {
      session.totalWorkMs = elapsed;
      finishAt(session, 'won', now);
      events.push('won');
      return;
    }
    if (elapsed >= session.durationMs) {
      const endAt = session.phaseStartedAt + Math.max(0, session.durationMs - session.phaseElapsedBeforeMs);
      session.totalWorkMs = session.durationMs;
      finishAt(session, 'failed', endAt, 'timeout');
      events.push('failed');
    }
    return;
  }

  if (session.kind === 'marathon') {
    const remWork = Math.max(0, session.durationMs - session.phaseElapsedBeforeMs);
    const goalAt = session.phaseStartedAt + remWork;
    const failAt = session.lastInputAt + session.maxIdleMs;
    const cappedNow = Math.min(now, Math.min(goalAt, failAt));
    session.maxIdleMsSeen = Math.max(session.maxIdleMsSeen, Math.max(0, cappedNow - session.lastInputAt));

    if (now >= failAt && failAt <= goalAt) {
      session.totalWorkMs = session.phaseElapsedBeforeMs + Math.max(0, failAt - session.phaseStartedAt);
      finishAt(session, 'failed', failAt, 'idle');
      events.push('failed');
      return;
    }
    if (now >= goalAt) {
      session.totalWorkMs = session.durationMs;
      finishAt(session, 'won', goalAt);
      events.push('won');
    }
    return;
  }

  // Помодоро: поочерёдные фазы письма и отдыха, включая перехлёст при возврате из сна.
  while (session.status === 'running' || session.status === 'break') {
    const target = session.status === 'running' ? session.workMs : session.breakMs;
    const rem = Math.max(0, target - session.phaseElapsedBeforeMs);
    const phaseEndAt = session.phaseStartedAt + rem;
    if (now < phaseEndAt) break;

    if (session.status === 'running') {
      session.totalWorkMs += session.workMs;
      if (session.round >= session.rounds) {
        finishAt(session, 'won', phaseEndAt);
        events.push('won');
        break;
      }
      session.status = 'break';
      session.phaseElapsedBeforeMs = 0;
      session.phaseStartedAt = phaseEndAt;
      events.push('phase-break');
    } else {
      session.round += 1;
      session.status = 'running';
      session.phaseElapsedBeforeMs = 0;
      session.phaseStartedAt = phaseEndAt;
      events.push('phase-work');
    }
  }
}

function tick(session, now = Date.now()) {
  const events = [];
  evaluateClock(session, now, events);
  return events;
}

function onInput(session, input = {}, now = Date.now()) {
  const wordDelta = Number(input.wordDelta) || 0;
  const inserted = !!input.inserted;
  const events = [];
  if (isTerminal(session)) return events;

  evaluateClock(session, now, events);
  if (isTerminal(session)) return events;

  if (session.status === 'waiting') {
    if (!inserted && wordDelta <= 0) return events;
    session.status = 'running';
    session.startedAt = now;
    session.phaseStartedAt = now;
    session.lastInputAt = now;
    events.push('started');
  } else if (session.status === 'paused' && (inserted || wordDelta !== 0)) {
    const used = Math.max(0, now - session.pauseStartedAt);
    session.pauseUsedBeforeMs = Math.min(session.pauseBankMs, session.pauseUsedBeforeMs + used);
    session.pauseStartedAt = null;
    session.status = 'running';
    session.phaseStartedAt = now;
    events.push('resumed');
  }

  if (wordDelta !== 0) {
    session.words = Math.max(0, session.words + wordDelta);
  }
  if (inserted && session.status === 'running') {
    if (session.lastInputAt !== null) {
      session.maxIdleMsSeen = Math.max(session.maxIdleMsSeen, Math.max(0, now - session.lastInputAt));
    }
    session.lastInputAt = now;
  }

  if (session.kind === 'sprint' && session.words >= session.targetWords) {
    const elapsed = session.phaseElapsedBeforeMs + Math.max(0, now - session.phaseStartedAt);
    session.totalWorkMs = elapsed;
    finishAt(session, 'won', now);
    events.push('won');
  }

  return events;
}

function togglePause(session, now = Date.now()) {
  const events = [];
  if (!session.allowPause || isTerminal(session) || session.status === 'waiting' || session.status === 'break') {
    return events;
  }
  evaluateClock(session, now, events);
  if (isTerminal(session) || session.status === 'break') return events;

  if (session.status === 'running') {
    const bankLeft = session.pauseBankMs - session.pauseUsedBeforeMs;
    if (bankLeft <= 0) return events;
    session.phaseElapsedBeforeMs += Math.max(0, now - session.phaseStartedAt);
    session.phaseStartedAt = null;
    session.status = 'paused';
    session.pauseStartedAt = now;
    events.push('paused');
  } else if (session.status === 'paused') {
    const used = Math.max(0, now - session.pauseStartedAt);
    session.pauseUsedBeforeMs = Math.min(session.pauseBankMs, session.pauseUsedBeforeMs + used);
    session.pauseStartedAt = null;
    session.status = 'running';
    session.phaseStartedAt = now;
    events.push('resumed');
  }
  return events;
}

function skipBreak(session, now = Date.now()) {
  const events = [];
  if (session.kind !== 'pomodoro' || isTerminal(session)) return events;
  evaluateClock(session, now, events);
  if (session.status !== 'break') return events;
  session.round += 1;
  session.status = 'running';
  session.phaseElapsedBeforeMs = 0;
  session.phaseStartedAt = now;
  events.push('phase-work');
  return events;
}

function exitSession(session, now = Date.now()) {
  const events = [];
  if (isTerminal(session)) return events;
  evaluateClock(session, now, events);
  if (isTerminal(session)) return events;

  if (session.status === 'running') {
    const elapsed = session.phaseElapsedBeforeMs + Math.max(0, now - session.phaseStartedAt);
    session.totalWorkMs += elapsed;
  } else if (session.status === 'paused') {
    const used = Math.max(0, now - session.pauseStartedAt);
    session.pauseUsedBeforeMs = Math.min(session.pauseBankMs, session.pauseUsedBeforeMs + used);
    session.totalWorkMs += session.phaseElapsedBeforeMs;
  }
  finishAt(session, 'exited', now);
  events.push('exited');
  return events;
}

function snapshot(session, now = Date.now()) {
  const effNow = isTerminal(session) && session.endedAt ? session.endedAt : now;
  const activePause = session.status === 'paused' && session.pauseStartedAt !== null
    ? Math.max(0, effNow - session.pauseStartedAt) : 0;
  const pauseUsedMs = Math.min(session.pauseBankMs, session.pauseUsedBeforeMs + activePause);
  const pauseRemainingMs = Math.max(0, session.pauseBankMs - pauseUsedMs);

  let phaseElapsedMs = session.phaseElapsedBeforeMs;
  if ((session.status === 'running' || session.status === 'break') && session.phaseStartedAt !== null) {
    phaseElapsedMs += Math.max(0, effNow - session.phaseStartedAt);
  }

  let phaseDurationMs = session.durationMs;
  if (session.kind === 'pomodoro') {
    phaseDurationMs = session.status === 'break' ? session.breakMs : session.workMs;
  }
  const remainingMs = session.status === 'waiting'
    ? phaseDurationMs
    : isTerminal(session)
      ? Math.max(0, phaseDurationMs - session.phaseElapsedBeforeMs)
      : Math.max(0, phaseDurationMs - phaseElapsedMs);

  let elapsedWorkMs = session.totalWorkMs;
  if (!isTerminal(session) && session.status !== 'break') {
    elapsedWorkMs += phaseElapsedMs;
  }

  let progress = 0;
  if (session.kind === 'sprint') {
    progress = session.targetWords > 0 ? Math.min(1, session.words / session.targetWords) : 0;
  } else if (session.kind === 'marathon') {
    progress = session.durationMs > 0 ? Math.min(1, elapsedWorkMs / session.durationMs) : 0;
  } else {
    const totalGoalWork = session.workMs * session.rounds;
    progress = totalGoalWork > 0 ? Math.min(1, elapsedWorkMs / totalGoalWork) : 0;
  }

  let idleRemainingMs = 0;
  let idleWarn = false;
  if (session.kind === 'marathon') {
    if (session.status === 'waiting') {
      idleRemainingMs = session.maxIdleMs;
    } else if (session.status === 'running' && session.lastInputAt !== null) {
      const idle = Math.max(0, effNow - session.lastInputAt);
      idleRemainingMs = Math.max(0, session.maxIdleMs - idle);
      idleWarn = idleRemainingMs <= session.warnIdleMs;
    }
  }

  const canPause = session.allowPause
    && (session.status === 'paused' || (session.status === 'running' && pauseRemainingMs > 0));

  return {
    kind: session.kind,
    presetId: session.presetId,
    presetLabel: session.presetLabel,
    status: session.status,
    round: session.round,
    rounds: session.rounds,
    words: session.words,
    targetWords: session.targetWords,
    durationMs: session.durationMs,
    remainingMs,
    elapsedWorkMs,
    progress,
    pauseBankMs: session.pauseBankMs,
    pauseUsedMs,
    pauseRemainingMs,
    allowPause: session.allowPause,
    canPause,
    idleRemainingMs,
    idleWarn,
    maxIdleMs: session.maxIdleMs,
    maxIdleMsSeen: session.maxIdleMsSeen,
    failReason: session.failReason,
  };
}

module.exports = {
  PAUSE_RATIO,
  CHALLENGES,
  CHALLENGE_ORDER,
  getPreset,
  formatClock,
  createSession,
  onInput,
  togglePause,
  skipBreak,
  tick,
  exitSession,
  snapshot,
};
