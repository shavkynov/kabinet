'use strict';

// Общие имена для замка «проект открыт на другом устройстве». Сам замок пишет и читает связь с Яндекс Диском
// (davlink на ПК, backend на телефоне) в папку синхронизации.

const os = require('os');

const LOCK_FILE = 'kabinet.lock';
const LOCK_FRESH_MS = 3 * 60 * 1000;
const deviceName = () => os.hostname();

module.exports = { LOCK_FILE, LOCK_FRESH_MS, deviceName };
