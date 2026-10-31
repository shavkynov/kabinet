// Запуск Кабинета на Android: загружает файлы из хранилища, поднимает «главный процесс» (backend.js)
// и только потом подключает окно (dist/app.js), которое ждёт готовый window.kabinet.
import './polyfill.js';
import fs from 'fs';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { zipSync, unzipSync } from 'fflate';
import { createIdbStore } from './shim/idbstore.js';
import { confirmBox, chooseBox, menuBox, toast, pickFiles } from './ui.js';
import { createBackend } from './backend.js';
import i18n from '../src/i18n.js';

const VERSION = __APP_VERSION__;
const native = Capacitor.isNativePlatform();
const HwKeyboard = registerPlugin('HwKeyboard');

// ---------- физическая клавиатура ----------
// Основной источник — маленький плагин на Java (HwKeyboardPlugin): он видит подключённые устройства ввода.
// Если его нет (запуск в браузере), клавиатура считается подключённой после первой настоящей клавиши.
function createHw() {
  const subs = new Set();
  let viaNative = null;
  let seen = false;
  let cur = false;
  const update = () => {
    const v = viaNative !== null ? viaNative : seen;
    if (v === cur) return;
    cur = v;
    subs.forEach((cb) => { try { cb(v); } catch (e) { console.error(e); } });
  };
  async function poll() {
    try { viaNative = !!(await HwKeyboard.status()).connected; } catch { viaNative = null; }
    update();
  }
  if (native) {
    poll();
    setInterval(poll, 1500);
    window.addEventListener('focus', poll);
    window.addEventListener('resize', poll);
    document.addEventListener('visibilitychange', poll);
  }
  window.addEventListener('keydown', (e) => {
    if (viaNative === null && !seen && e.code && e.key !== 'Unidentified' && e.keyCode !== 229 && !e.isComposing) { seen = true; update(); }
  }, true);
  return { connected: () => cur, onChange: (cb) => { subs.add(cb); } };
}

// ---------- выдача файлов ----------
function toBase64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

async function deliver({ name, mime, data }) {
  const safe = String(name).replace(/[\\/:*?"<>|]/g, '-');
  if (native) {
    const res = await Filesystem.writeFile({ path: `export/${safe}`, data: toBase64(data), directory: Directory.Cache, recursive: true });
    try {
      await Share.share({ title: safe, dialogTitle: safe, files: [res.uri] });
    } catch (e) {
      if (!/cancel/i.test(String((e && e.message) || e))) throw e;
    }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: mime }));
  a.download = safe;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

const host = {
  version: VERSION,
  platform: 'android',
  confirm: confirmBox,
  choose: chooseBox,
  pickFiles,
  deliver,
  openUrl: (url) => { if (native) Browser.open({ url }); else window.open(url, '_blank'); },
  zip: (entries) => {
    const o = {};
    for (const e of entries) o[e.path] = e.data;
    return zipSync(o, { level: 6 });
  },
  unzip: (bytes) => Object.entries(unzipSync(new Uint8Array(bytes))).map(([path, data]) => ({ path, data })),
};

// ---------- меню («☰») ----------
const GITHUB = 'https://github.com/shavkynov/kabinet';

function buildMenu(be, hw) {
  const t = i18n.t;
  const has = be.hasProject();
  const go = (ch) => () => be.emit(ch);
  return [
    { head: t('Файл') },
    { label: t('Новый проект…'), run: go('ui:newProject') },
    { label: t('Открыть проект…'), run: go('ui:openProject') },
    { label: t('Импорт глав…'), run: go('ui:importFiles'), disabled: !has },
    { label: t('Экспорт проекта…'), run: go('ui:export'), disabled: !has },
    { label: t('Сохранить проект в ZIP'), run: () => be.exportZip().catch((e) => toast(e.message)), disabled: !has },
    { label: t('Шаблоны карточек…'), run: go('ui:openTemplates'), disabled: !has },
    { label: t('Сделать копию сейчас'), run: go('ui:backupNow'), disabled: !has },
    { label: t('Закрыть проект'), run: go('ui:closeProject'), disabled: !has },
    { sep: true },
    { head: t('Вид') },
    { label: t('Поиск по проекту…'), run: go('ui:openSearch'), disabled: !has },
    { label: t('Показать / скрыть панель глав'), run: go('ui:toggleSidebar'), disabled: !has },
    { label: t('Только лист'), run: go('ui:toggleFocus'), disabled: !has },
    { label: t('Режим «печатная машинка»'), run: go('ui:toggleTypewriter'), disabled: !has },
    { label: t('Скрытые символы'), run: go('ui:toggleMarks'), disabled: !has },
    { label: t('Фоновый эмбиент вкл / выкл'), run: go('ui:toggleAmbient'), disabled: !has },
    ...(hw.connected() ? [{ label: t('Звуки клавиш вкл / выкл'), run: go('ui:toggleSound'), disabled: !has }] : []),
    { label: t('Текст и оформление…'), run: go('ui:openSettings'), disabled: !has },
    { sep: true },
    { head: t('Правка') },
    { label: t('Проверить текст главы…'), run: go('ui:openCheck'), disabled: !has },
    { label: t('Орфография при наборе вкл / выкл'), run: go('ui:toggleSpell') },
    { sep: true },
    { head: t('Язык интерфейса') },
    { label: 'Русский', run: () => be.emit('ui:setLang', 'ru') },
    { label: 'English', run: () => be.emit('ui:setLang', 'en') },
    { sep: true },
    { label: t('О программе «Кабинет»'), run: () => be.call('app:about') },
    { label: t('Где взять новые версии…'), run: () => host.openUrl(GITHUB) },
  ];
}

// ---------- горячие клавиши (как в меню на компьютере; Ctrl, а не ⌘) ----------
function wireShortcuts(be) {
  const map = {
    KeyN: ['ui:newProject'], KeyO: ['ui:openProject'], KeyE: ['ui:export'], KeyF: ['ui:openSearch', 'ui:toggleFocus'],
    Comma: ['ui:openSettings'], Backslash: ['ui:toggleSidebar'], KeyT: [null, 'ui:toggleTypewriter'],
    Digit8: [null, 'ui:toggleMarks'], KeyM: [null, 'ui:toggleSound'], KeyA: [null, 'ui:toggleAmbient'],
    KeyL: [null, 'ui:openCheck'], KeyW: [null, 'ui:closeProject'],
  };
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const entry = map[e.code];
    const ch = entry && entry[e.shiftKey ? 1 : 0];
    if (!ch) return;
    e.preventDefault();
    e.stopPropagation();
    be.emit(ch);
  }, true);
}

// Правая кнопка мыши (планшет с мышью): то же контекстное меню, что и на компьютере. Долгое нажатие пальцем не трогаем:
// там работает системное меню выделения.
function wireContextMenu(be) {
  let lastType = 'touch';
  window.addEventListener('pointerdown', (e) => { lastType = e.pointerType; }, true);
  document.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented || (e.pointerType || lastType) !== 'mouse') return;
    const sel = String(window.getSelection() || '');
    const a = document.activeElement;
    const editable = !!(e.target.closest && e.target.closest('.ProseMirror[contenteditable="true"], textarea, input'));
    if (!editable && !sel) return;
    e.preventDefault();
    be.emit('ui:contextMenu', { x: e.clientX, y: e.clientY, misspelledWord: '', suggestions: [], selectionText: sel.slice(0, 2000), isEditable: editable || !!(a && a.isContentEditable), editFlags: {} });
  });
}

function showFatal(err) {
  const d = document.createElement('div');
  d.style.cssText = 'padding:24px;font:16px/1.5 sans-serif;color:#b00020;white-space:pre-wrap';
  d.textContent = `Не удалось запустить Кабинет.\n\n${(err && err.stack) || err}`;
  document.body.replaceChildren(d);
}

(async () => {
  try {
    const store = createIdbStore();
    let persistent = true;
    try {
      fs.setStore(store);
      await fs.loadAll();
    } catch (e) {
      persistent = false;
      fs.setStore(null);
      console.error('storage unavailable:', e);
    }
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch { /* не критично */ }

    const hw = createHw();
    const be = createBackend(host, {
      session: {
        get: (k) => { try { return sessionStorage.getItem(`kabinet.mobile.${k}`) || null; } catch { return null; } },
        set: (k, v) => { try { if (v) sessionStorage.setItem(`kabinet.mobile.${k}`, v); else sessionStorage.removeItem(`kabinet.mobile.${k}`); } catch { /* не критично */ } },
      },
    });
    host.popupMenu = () => { menuBox(i18n.t('Кабинет'), buildMenu(be, hw)); };
    window.kabinet = Object.assign({}, be.api, { hw });
    window.kabinetBackend = be;

    wireShortcuts(be);
    wireContextMenu(be);

    // Всё, что ещё не записано, уходит на диск при любом уходе из приложения.
    const save = () => { fs.flush(); };
    window.addEventListener('pagehide', save);
    window.addEventListener('beforeunload', save);
    document.addEventListener('visibilitychange', () => { if (document.hidden) { save(); be.autoBackup(); } });
    setInterval(() => be.autoBackup(), 20 * 60 * 1000);

    if (native) {
      App.addListener('pause', save);
      App.addListener('backButton', () => {
        const handled = window.kabinetMobile && window.kabinetMobile.back();
        if (!handled) App.minimizeApp();
      });
    }

    const s = document.createElement('script');
    s.src = 'dist/app.js';
    s.onerror = () => showFatal(new Error('Не загрузился dist/app.js'));
    document.body.append(s);
    if (!persistent) setTimeout(() => toast('Хранилище недоступно: проекты не сохранятся после закрытия. Сохраняйте ZIP.'), 800);
  } catch (err) {
    showFatal(err);
  }
})();
