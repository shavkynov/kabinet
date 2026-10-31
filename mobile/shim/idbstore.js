'use strict';
// Хранилище виртуальной ФС в IndexedDB: одна запись на файл или папку.

const DB = 'kabinet-fs';
const STORE = 'nodes';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'p' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function createIdbStore() {
  let dbp = null;
  const db = () => (dbp || (dbp = open()));
  return {
    async loadAll() {
      const d = await db();
      return new Promise((resolve, reject) => {
        const req = d.transaction(STORE, 'readonly').objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },
    async apply(puts, dels) {
      const d = await db();
      return new Promise((resolve, reject) => {
        const tx = d.transaction(STORE, 'readwrite');
        const os = tx.objectStore(STORE);
        for (const r of puts) os.put(r);
        for (const p of dels) os.delete(p);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    },
  };
}

module.exports = { createIdbStore };
