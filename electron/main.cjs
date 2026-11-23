// HomeSafe Vault desktop wrapper: starts the local Vault service automatically and
// hands the owner access key only to the trusted dashboard window.
const { app, BrowserWindow, dialog, ipcMain, protocol, net, shell } = require('electron');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// The dashboard is bundled inside the app (dashboard/) and served from app://vault, so no public
// address is needed. Only sign-in talks to the internet (cloud login).
const APP_URL = process.env.HOMESAFE_VAULT_URL || 'app://vault/';
const dashboardDir = app.isPackaged ? path.join(process.resourcesPath, 'dashboard') : path.join(__dirname, '..', 'dist', 'client');
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
function serveDashboard() {
  protocol.handle('app', req => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '');
    let file = path.resolve(dashboardDir, rel || 'index.html');
    if (!file.startsWith(dashboardDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dashboardDir, 'index.html');
    return net.fetch(pathToFileURL(file).toString());
  });
}
// Node's URL gives custom schemes an origin of "null"; the dashboard's real browser origin is app://vault.
const ORIGIN = APP_URL.startsWith('app://') ? 'app://vault' : new URL(APP_URL).origin;
const originOf = u => u.startsWith('app://') ? 'app://' + new URL(u).host : new URL(u).origin;
const stateDir = path.join(app.getPath('userData'), 'vault-service');
const configPath = path.join(stateDir, 'config.json');
const serviceDir = app.isPackaged ? path.join(process.resourcesPath, 'vault-service') : path.join(__dirname, '..', 'vault-service');
let service = null, win = null, lastError = '';

const discovery = () => import(pathToFileURL(path.join(serviceDir, 'src', 'discovery.mjs')).href);
async function lanIP() { return (await discovery()).defaultRouteIPv4(); }
const gib = n => `${(n / 1024 ** 3).toFixed(1)} GB`;
// Never create or adopt HomeSafeBckup silently: show the drive and let the owner confirm or pick another folder.
async function confirmDrive(target, drive) {
  const r = await dialog.showMessageBox({ type: 'question', title: 'HomeSafe Vault setup', buttons: ['Use this drive', 'Choose another folder'], defaultId: 0, cancelId: 1, noLink: true,
    message: `Back up phones to "${drive.name}"?`,
    detail: `Drive: ${drive.name}\nSize: ${gib(drive.totalBytes)}\nFree space: ${gib(drive.freeBytes)}\n\nBackups will be saved in:\n${target}\n\n${drive.existing ? 'This existing HomeSafeBckup folder will be used.' : 'A new HomeSafeBckup folder will be created.'}` });
  return r.response === 0;
}
async function driveInfo(dir) { const st = await fsp.statfs(dir); return { name: path.basename(dir) || dir, totalBytes: st.blocks * st.bsize, freeBytes: st.bavail * st.bsize }; }
async function chooseBackupRoot() {
  const d = await discovery();
  const drives = await d.externalDriveRoots().catch(() => []);
  const found = await d.findBackupRoot(drives);
  if (found) {
    const drive = drives.find(x => found.root.startsWith(x.root));
    if (await confirmDrive(found.root, { ...drive, existing: found.existing })) { if (!found.existing) await fsp.mkdir(found.root); return found.root; }
  } else {
    await dialog.showMessageBox({ type: 'info', title: 'HomeSafe Vault setup', message: 'Plug in your USB backup drive, then choose it.', detail: 'This is a one-time step. Nothing is uploaded; backups stay on this drive.' });
  }
  for (;;) {
    const pick = await dialog.showOpenDialog({ title: 'Choose your backup drive or its HomeSafeBckup folder', properties: ['openDirectory'] });
    if (pick.canceled || !pick.filePaths[0]) throw new Error('No backup drive chosen. Plug in your USB drive and reopen HomeSafe Vault.');
    const picked = pick.filePaths[0], target = path.basename(picked) === 'HomeSafeBckup' ? picked : path.join(picked, 'HomeSafeBckup');
    const existing = fs.existsSync(target);
    if (await confirmDrive(target, { ...(await driveInfo(existing ? target : picked)), name: path.basename(path.dirname(target)) || path.dirname(target), existing })) { if (!existing) await fsp.mkdir(target); return target; }
  }
}

async function firstRunSetup() {
  if (fs.existsSync(configPath)) {
    const existing = JSON.parse(await fsp.readFile(configPath, 'utf8'));
    let changed = false;
    if (existing.origins.length !== 1 || existing.origins[0] !== ORIGIN) { existing.origins = [ORIGIN]; changed = true; }
    // Home routers often hand out a new Wi-Fi address; binding the old one makes the service exit.
    const ip = await lanIP(); if (ip && ip !== existing.lanHost) { existing.lanHost = ip; changed = true; }
    if (changed) await fsp.writeFile(configPath, JSON.stringify(existing, null, 2), { mode: 0o600 });
    return existing;
  }
  const chosen = await chooseBackupRoot(); // the answer is remembered in config.json with the drive identity
  const root = await fsp.realpath(chosen);
  if (path.basename(root) !== 'HomeSafeBckup') throw new Error('Select the folder named HomeSafeBckup itself');
  const probe = path.join(root, `.homesafe-probe-${crypto.randomBytes(6).toString('hex')}`);
  await fsp.writeFile(probe, 'ok', { flag: 'wx' }); await fsp.unlink(probe); // verify drive is writable
  const ip = await lanIP(); if (!ip) throw new Error('Connect this PC to your home Wi-Fi first');
  const st = await fsp.stat(root);
  await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const selfsigned = require('selfsigned');
  const pems = selfsigned.generate([{ name: 'commonName', value: 'HomeSafe Vault' }], { days: 1825, keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip }] }] });
  const cert = path.join(stateDir, 'vault.crt'), key = path.join(stateDir, 'vault.key');
  await fsp.writeFile(cert, pems.cert, { flag: 'wx' }); await fsp.writeFile(key, pems.private, { flag: 'wx', mode: 0o600 });
  const config = { root, driveIdentity: { dev: st.dev, ino: st.ino }, instanceId: crypto.randomBytes(16).toString('hex'), origins: [ORIGIN], adminToken: crypto.randomBytes(32).toString('base64url'), identityKey: crypto.randomBytes(32).toString('base64'), cert, key, lanHost: ip };
  await fsp.writeFile(configPath, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
  return config;
}

let restarts = 0, restartTimer = null, config = null;
function ensureRunning() {
  if (service || restartTimer || !config) return;
  restartTimer = setTimeout(async () => { restartTimer = null; try { config = await firstRunSetup(); startService(); } catch (e) { lastError = e.message; } }, Math.min(30000, 1000 * 2 ** Math.min(restarts++, 5)));
}
function startService() {
  try { fs.unlinkSync(path.join(stateDir, 'service.lock')); } catch {} // only this app owns this state dir
  service = spawn(process.execPath, [path.join(serviceDir, 'src', 'cli.mjs'), 'start', '--state', stateDir], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  service.stderr.on('data', d => { lastError = String(d).trim(); });
  service.stdout.on('data', () => { restarts = 0; });
  service.on('exit', code => { service = null; if (code) lastError ||= 'Vault service stopped. Check the USB drive is connected.'; ensureRunning(); });
}

async function boot() {
  serveDashboard();
  app.setLoginItemSettings({ openAtLogin: true });
  try { config = await firstRunSetup(); startService(); }
  catch (e) { lastError = e.message; await dialog.showMessageBox({ type: 'warning', title: 'HomeSafe Vault', message: 'Vault service not started', detail: e.message }); }
  ipcMain.handle('vault:get-access-key', ev => {
    if (originOf(ev.senderFrame.url) !== ORIGIN) throw new Error('Untrusted page');
    return config && service ? config.adminToken : null;
  });
  ipcMain.handle('vault:status', () => ({ running: !!service, error: service ? '' : lastError }));
  ipcMain.handle('vault:ensure-running', () => { if (!service) { restarts = 0; ensureRunning(); } return { running: !!service, error: service ? '' : lastError }; });
  win = new BrowserWindow({ width: 1280, height: 860, title: 'HomeSafe Vault', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.webContents.on('will-navigate', (e, url) => { if (originOf(url) !== ORIGIN) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.loadURL(APP_URL);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
  app.whenReady().then(boot);
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { if (service) service.kill('SIGTERM'); });
}
