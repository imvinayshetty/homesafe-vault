// electron-packager copies ../dist/client as resources/client; main.cjs expects resources/dashboard.
const fs = require('node:fs'), path = require('node:path');
const dir = process.argv[2];
fs.rmSync(path.join(dir, 'dashboard'), { recursive: true, force: true });
fs.renameSync(path.join(dir, 'client'), path.join(dir, 'dashboard'));
