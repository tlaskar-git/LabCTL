// Throwaway LabCTL server for run_linux_setup.js. Runs inside a test container, never on a real host.
// Prints one line "READY {port, token}" when it listens. The data dir and the master key are random and temporary.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../../../server/src/app');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labctl-test-data-'));
const inst = createApp({ dataDir, masterKey: crypto.randomBytes(32).toString('base64'), quiet: true });
const token = inst.ctx.tokens.create('container test', 'test');
inst.listen(Number(process.env.PORT) || 7700, '0.0.0.0').then(port => {
  console.log('READY ' + JSON.stringify({ port, token: token.value }));
});
