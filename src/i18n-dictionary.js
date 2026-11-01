'use strict';

// Feature entries supplement the base dictionary; existing translations take precedence.
module.exports = { ...require('./i18n-sync-en'), ...require('./i18n-en') };
