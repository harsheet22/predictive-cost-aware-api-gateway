'use strict';
// An abandoned parent must not leave an orphaned gateway listener running.
process.once('disconnect', () => process.exit(1));
require('../controlled/server.cjs');
