// Syntax check (node --check) for every .js file in server.js, src/, scripts/ and test/. No build step.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = [path.join(root, 'server.js')];
const walk = dir => {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
};
['src', 'scripts', 'test'].forEach(d => walk(path.join(root, d)));
let failed = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (err) { failed++; process.stderr.write(`${path.relative(root, f)}\n${err.stderr}\n`); }
}
console.log(`lint: ${files.length - failed}/${files.length} files passed`);
process.exit(failed ? 1 : 0);
