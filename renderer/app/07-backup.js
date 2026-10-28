// ---------- резервные копии ----------

async function backupNow() {
  try {
    await flush();
    const name = await api.backupNow();
    setStatus('ok', name ? 'Копия создана' : 'С прошлой копии ничего не изменилось');
  } catch (err) {
    showError(err.message);
  }
}

