'use strict';

function createSingleFlight() {
  let busy = false;
  return {
    get busy() { return busy; },
    async run(action) {
      if (busy) {
        const error = new Error('Идёт обмен…');
        error.code = 'OPERATION_IN_PROGRESS';
        throw error;
      }
      busy = true;
      try { return await action(); } finally { busy = false; }
    },
  };
}

module.exports = { createSingleFlight };
