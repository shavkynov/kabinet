'use strict';

// Feature entries supplement the base dictionary; existing translations take precedence.
module.exports = {
  ...require('./i18n-sync-en'),
  ...require('./i18n-en'),
  'Нумеровать главы при экспорте': 'Number chapters on export',
  'Не удалось прочитать настройки места экспорта. Будет предложена папка «Документы».': 'Could not read the export destination settings. The Documents folder will be suggested.',
  'Файл экспортирован, но запомнить папку и формат не удалось.': 'The file was exported, but the folder and format could not be remembered.',
  'Не удалось сохранить изменения. Удаление отменено, текст остался на экране': 'Could not save changes. Deletion was canceled; the text remains on screen.',
  'Копия в «Конфликты» уже существует и была изменена. Сохранение остановлено, чтобы не затереть её.': 'A copy in “Conflicts” already exists and has been modified. Saving was stopped to avoid overwriting it.',
};
