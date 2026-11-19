'use strict';

// Feature entries supplement the base dictionary; existing translations take precedence.
module.exports = {
  ...require('./i18n-sync-en'),
  ...require('./i18n-en'),
  'chancery rule вернул не массив.': 'The chancery rule returned a non-array.',
  'which rule вернул не массив.': 'The which rule returned a non-array.',
  'chain rule вернул не массив.': 'The chain rule returned a non-array.',
  'Rust-команда style:parse недоступна.': 'The Rust command style:parse is unavailable.',
  'Некорректный ответ style:parse.': 'Invalid response from style:parse.',
  'Нумеровать главы при экспорте': 'Number chapters on export',
  'Не удалось прочитать настройки места экспорта. Будет предложена папка «Документы».': 'Could not read the export destination settings. The Documents folder will be suggested.',
  'Файл экспортирован, но запомнить папку и формат не удалось.': 'The file was exported, but the folder and format could not be remembered.',
  'Не удалось сохранить изменения. Удаление отменено, текст остался на экране': 'Could not save changes. Deletion was canceled; the text remains on screen.',
  'Копия в «Конфликты» уже существует и была изменена. Сохранение остановлено, чтобы не затереть её.': 'A copy in “Conflicts” already exists and has been modified. Saving was stopped to avoid overwriting it.',
  'Режим письма': 'Writing mode',
  'Не удалось прочитать «{0}»: {1}. Синхронизация остановлена, чтобы не принять файл за удалённый.': 'Could not read “{0}”: {1}. Sync stopped so that the file is not mistaken for deleted.',
  'папку проекта': 'the project folder',
  'На этом устройстве не видно файлов проекта (папка пуста или диск не подключён). Синхронизация остановлена, в облаке ничего не удалено.': 'No project files are visible on this device (the folder is empty or the disk is not connected). Sync stopped; nothing was deleted in the cloud.',
};
