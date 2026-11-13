'use strict';
function createCloseCoordinator({ prepare, exit, cancel, report, lock = () => {}, unlock = () => {} }) {
  let tail = Promise.resolve();
  let closing = false;
  const failures = new Map();
  function write(key, run) {
    const job = tail.then(run);
    tail = job.then(() => { failures.delete(key); }, (error) => { failures.set(key, error); });
    return job;
  }
  async function drain() {
    let current;
    do { current = tail; await current; } while (current !== tail);
  }
  function forget(predicate = () => true) {
    for (const key of failures.keys()) if (predicate(key)) failures.delete(key);
  }
  async function close() {
    if (closing) return false;
    closing = true;
    let previous;
    let approved = false;
    try {
      previous = lock();
      await drain();
      const saved = await prepare();
      await drain();
      if (saved !== true || failures.size) {
        throw failures.values().next().value || new Error('Не все изменения удалось сохранить.');
      }
      await exit();
      approved = true;
      return true;
    } catch (error) {
      try { await cancel(); } catch (cancelError) { console.error('close cancel:', cancelError); }
      report(error);
      return false;
    } finally {
      if (!approved) { closing = false; unlock(previous); }
    }
  }
  return { write, drain, forget, close, isClosing: () => closing };
}
module.exports = { createCloseCoordinator };
