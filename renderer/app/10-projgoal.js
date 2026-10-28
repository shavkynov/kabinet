// ---------- цель по словам для всего проекта ----------

let projReached = false;

function projectTotal() {
  let total = 0;
  for (const v of (goalMetric() === 'chars' ? chapterChars : chapterWords).values()) total += v;
  return total;
}

// Сводка сборника рассказов: число рассказов, знаки с пробелами, авторские листы (40 000 знаков).
function storiesSummary() {
  let chars = 0;
  for (const v of chapterChars.values()) chars += v;
  return { count: chapterChars.size, chars, sheets: authorSheets(chars) };
}
const fmtSheets = (v) => v.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function celebrateProject() {
  if (settings.goalChime) sounds.chime();
  const el = $('#barTotal');
  el.classList.remove('hit');
  void el.offsetWidth;
  el.classList.add('hit');
  setTimeout(() => el.classList.remove('hit'), 1400);
}

// fromUser = true: слова добавил пользователь, и пересечение цели даёт сигнал.
function checkProjectGoal(fromUser) {
  const goal = project && project.projectGoal;
  const reached = !!goal && projectTotal() >= goal;
  if (fromUser && settings.projectGoalOn && reached && !projReached) {
    const key = `project:${goal}`;
    if (!chimedGoals.has(key)) {
      chimedGoals.add(key);
      celebrateProject();
    }
  }
  projReached = reached;
}

// Рисует счётчик проекта в нижней панели: с целью и полоской или обычным текстом.
function renderTotal() {
  const el = $('#barTotal');
  const n = (v) => v.toLocaleString(LOCALE);
  el.textContent = '';
  el.classList.remove('pgoal');
  const has = !!project && chapterWords.size > 0;
  el.classList.toggle('clickable', has && settings.projectGoalOn);
  el.removeAttribute('title');
  if (!has) return;
  const total = projectTotal();
  const goal = project.projectGoal;
  if (settings.projectGoalOn && goal) {
    const p = Math.min(1, total / goal);
    const reached = total >= goal;
    el.classList.add('pgoal');
    el.style.setProperty('--pgoal-color', `hsl(${reached ? 212 : Math.round(p * 125)} 85% 50%)`);
    const main = document.createElement('span');
    main.className = 'pmain';
    const b = document.createElement('b');
    b.textContent = n(total);
    main.append('Проект: ', b, ` / ${n(goal)}`);
    const bar = document.createElement('span');
    bar.className = 'pbar';
    const fill = document.createElement('i');
    fill.style.width = `${total > 0 ? Math.max(3, p * 100) : 0}%`;
    bar.append(fill);
    const pct = document.createElement('span');
    pct.className = 'ppct';
    pct.textContent = reached ? (total > goal ? `✓ +${n(total - goal)}` : '✓') : `${Math.floor(p * 100)}%`;
    el.append(main, bar, pct);
    el.title = reached ? 'Цель проекта взята. Нажмите, чтобы изменить' : 'Цель проекта. Нажмите, чтобы изменить';
  } else {
    if (project.mode === 'stories') {
      const s = storiesSummary();
      el.textContent = `${t('Рассказов: {0}', n(s.count))} · ${t('{0} а. л.', fmtSheets(s.sheets))}`;
    } else {
      el.textContent = `Проект: ${n(total)} ${wordsForm(total)}`;
    }
    if (settings.projectGoalOn) el.title = 'Нажмите, чтобы задать цель для всего проекта';
  }
}

function openProjPop() {
  if (!project || !settings.projectGoalOn || chapterWords.size === 0) return;
  const n = (v) => v.toLocaleString(LOCALE);
  const total = projectTotal();
  $('#projGoalInput').value = project.projectGoal ? String(project.projectGoal) : '';
  const chars = goalMetric() === 'chars';
  $('#projGoalLabel').textContent = chars ? t('Знаков в рассказах') : t('Слов в главах');
  const sum = storiesSummary();
  $('#pjStoryCount').textContent = n(sum.count);
  $('#pjStoryChars').textContent = n(sum.chars);
  $('#pjStorySheets').textContent = fmtSheets(sum.sheets);
  $('#pjWords').textContent = n(total);
  $('#pjLeft').textContent = project.projectGoal ? n(Math.max(0, project.projectGoal - total)) : '—';
  $('#projDeadlineInput').value = project.deadline || '';
  fillProjStats();
  const pop = $('#projPop');
  pop.hidden = false;
  const r = $('#barTotal').getBoundingClientRect();
  const w = pop.offsetWidth;
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  pop.style.bottom = `${window.innerHeight - r.top + 8}px`;
  $('#projGoalInput').focus();
  $('#projGoalInput').select();
}

// Срок, «слов в день», график последних 14 дней и серия: считает main по файлу статистики.
async function fillProjStats() {
  const n = (v) => v.toLocaleString(LOCALE);
  const row = $('#pjPlanRow');
  row.hidden = true;
  try {
    const s = await api.statsSummary(todayStamp(), todayWords());
    $('#pjStreak').textContent = n(s.streak);
    $('#pjAvg').textContent = n(s.avg7);
    const box = $('#pjDays');
    box.textContent = '';
    const max = Math.max(1, ...s.last.map((d) => d.words));
    s.last.forEach((d, i) => {
      const bar = document.createElement('i');
      bar.style.height = `${d.words > 0 ? Math.max(8, Math.round((d.words / max) * 100)) : 0}%`;
      bar.classList.toggle('on', d.words > 0);
      bar.classList.toggle('today', i === s.last.length - 1);
      bar.title = `${d.date}: ${n(d.words)}`;
      box.append(bar);
    });
    const plan = s.plan;
    if (plan) {
      row.hidden = false;
      if (plan.done) {
        $('#pjPlanLabel').textContent = t('Цель достигнута');
        $('#pjPlan').textContent = '✓';
      } else if (plan.overdue) {
        $('#pjPlanLabel').textContent = t('Срок прошёл, осталось');
        $('#pjPlan').textContent = n(plan.left);
      } else {
        $('#pjPlanLabel').textContent = t('В день нужно (дней: {0})', plan.daysLeft);
        $('#pjPlan').textContent = `${n(plan.perDay)} ${goalMetric() === 'chars' ? t('зн.') : ''}`.trim();
      }
    }
  } catch (err) {
    console.error('stats:', err);
  }
}

async function commitProjDeadline() {
  const v = $('#projDeadlineInput').value || null;
  try {
    project = await api.setProjectDeadline(v);
  } catch (err) {
    showError(err.message);
  }
  fillProjStats();
}

function closeProjPop() {
  $('#projPop').hidden = true;
}

async function commitProjGoal() {
  const v = parseGoal($('#projGoalInput').value);
  if (v === undefined) return;
  try {
    project = await api.setProjectGoal(v);
  } catch (err) {
    showError(err.message);
  }
  checkProjectGoal(false);
  refreshBar();
}

function wireProjGoal() {
  $('#barTotal').addEventListener('click', () => {
    if ($('#projPop').hidden) openProjPop();
    else closeProjPop();
  });
  const input = $('#projGoalInput');
  input.addEventListener('change', commitProjGoal);
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      await commitProjGoal();
      closeProjPop();
    }
    if (e.key !== 'Escape') e.stopPropagation();
  });
  $('#projDeadlineInput').addEventListener('change', commitProjDeadline);
  $('#projDeadlineInput').addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
  $('#projGoalClear').addEventListener('click', async () => {
    input.value = '';
    $('#projDeadlineInput').value = '';
    await commitProjDeadline();
    await commitProjGoal();
    closeProjPop();
  });
  document.addEventListener('mousedown', (e) => {
    if ($('#projPop').hidden) return;
    if (e.target.closest('#projPop') || e.target.closest('#barTotal')) return;
    closeProjPop();
  });
}

