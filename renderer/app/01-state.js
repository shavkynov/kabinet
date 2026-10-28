// ---------- состояние ----------

let project = null;   // { name, chapters: [{ id, title }] }
let currentId = null; // открытый документ
let currentKind = null; // 'chapter' | 'character' | 'place' | 'note'
let editor = null;
let loading = false;  // true, пока мы сами подставляем текст (это не правка пользователя)
let dirty = false;    // есть несохранённые изменения
let dirtyId = null;   // в каком документе
let dirtyKind = null;
let saveTimer = null;
let openToken = 0;    // защита от гонок при быстром переключении глав
let busy = false;     // защита от двойного создания
let statusTimer = null;

function showError(message) {
  alert(tdom(message));
}

// ---------- комментарии к фрагментам (логика в 34-comments.js) ----------
const CMT_CTX = 30;
const CMT_MAX_QUOTE = 2000;
let cmtList = [];        // комментарии открытой главы
let cmtChapter = null;   // глава, которой они принадлежат
let cmtDirty = false;
let cmtTimer = null;
let cmtRefreshTimer = null;
let cmtPending = null;   // выделение, к которому пишется новый комментарий
let cmtEditing = null;   // id комментария, который правится в списке
let cmtActive = null;
