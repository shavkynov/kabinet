// ---------- объём проекта ----------

const chapterWords = new Map(); // слов в каждой главе (для строки «Проект»)
const chapterChars = new Map(); // знаков с пробелами в каждой главе (рассказы: цель в знаках, сводка сборника)

async function refreshTotals() {
  if (!project) return;
  try {
    const st = await api.projectStats();
    chapterWords.clear();
    chapterChars.clear();
    for (const c of st.chapters) {
      chapterWords.set(c.id, c.words);
      chapterChars.set(c.id, c.chars);
    }
    checkProjectGoal(false);
    refreshBar();
  } catch (err) {
    console.error('stats:', err);
  }
}

