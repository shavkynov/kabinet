'use strict';
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

// Explicitly opt-in ad-hoc signer (no Apple developer account): used for macOS test builds and for release DMGs.
// It is not Developer ID signing or notarization: macOS still asks the user to confirm the first launch, but the app
// is no longer reported as "damaged" (an unsigned or broken-sealed bundle with the quarantine flag is).
exports.default = async function signMacTest(options) {
  if (process.platform !== 'darwin' || process.env.KABINET_TEST_ADHOC !== '1' && process.env.KABINET_ADHOC !== '1') {
    throw new Error('The ad-hoc signer is restricted to explicit macOS test builds.');
  }
  if (!options || typeof options.app !== 'string') throw new Error('Missing test app path.');
  const builderRequire = createRequire(require.resolve('electron-builder'));
  const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'));
  const { signAsync } = appBuilderRequire('@electron/osx-sign');
  await signAsync({ ...options, identity: '-', identityValidation: false,
    preAutoEntitlements: false, gatekeeperAssess: false, type: 'development' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', options.app], { stdio: 'inherit' });
};
