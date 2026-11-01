'use strict';
// Тестовая сборка: отчёт в sync-metrics.txt в папке данных приложения.
require('./sync-diag').install({
  file: () => require('path').join(require('electron').app.getPath('userData'), 'sync-metrics.txt'),
});
require('./yandex-desktop').installYandexDesktop();
require('../main');
