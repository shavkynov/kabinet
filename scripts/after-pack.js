'use strict';

// Вписывает значок в .exe после упаковки. Нужно, когда Windows-сборка идёт без инструментов подписи
// (npm run dist:win-nosign): electron-builder тогда не правит .exe, и у программы остаётся значок Electron.
// Работает только при сборке на Windows (rcedit запускает .exe). При любой ошибке сборка не падает.

const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  if (process.platform !== 'win32') {
    console.log('  • значок .exe вписывается только при сборке на Windows, пропускаю');
    return;
  }
  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const icon = path.join(context.packager.projectDir, 'build', 'icon.ico');
  if (!fs.existsSync(exe) || !fs.existsSync(icon)) {
    console.warn('  • значок .exe: не нашёл файл программы или build/icon.ico, пропускаю');
    return;
  }
  try {
    const mod = require('rcedit');
    const rcedit = typeof mod === 'function' ? mod : (mod.rcedit || mod.default);
    await rcedit(exe, {
      icon,
      'version-string': {
        ProductName: 'Кабинет',
        FileDescription: 'Кабинет',
        LegalCopyright: 'Редактор Александра Шавкунова',
      },
    });
    console.log('  • значок вписан в', path.basename(exe));
  } catch (err) {
    console.warn('  • не удалось вписать значок в .exe:', err.message);
  }
};
