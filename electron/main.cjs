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
const ORIGIN = new URL(APP_URL).origin;
const stateDir = path.join(app.getPath('userData'), 'vault-service');
const configPath = path.join(stateDir, 'config.json');
const serviceDir = app.isPackaged ? path.join(process.resourcesPath, 'vault-service') : path.join(__dirname, '..', 'vault-service');
let service = null, win = null, lastError = '';

function lanIP() {
  for (const list of Object.values(os.networkInterfaces())) for (const n of list || [])
    if (n.family === 'IPv4' && !n.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(n.address)) return n.address;
  return null;
}

async function firstRunSetup() {
  if (fs.existsSync(configPath)) {
    const existing = JSON.parse(await fsp.readFile(configPath, 'utf8'));
    if (!existing.origins.includes(ORIGIN)) { existing.origins = [ORIGIN]; await fsp.writeFile(configPath, JSON.stringify(existing, null, 2), { mode: 0o600 }); }
    return existing;
  }
  await dialog.showMessageBox({ type: 'info', title: 'HomeSafe Vault setup', message: 'Choose the HomeSafeBckup folder on your USB backup drive.', detail: 'This is a one-time step. Nothing is uploaded; backups stay on this drive.' });
  const pick = await dialog.showOpenDialog({ title: 'Select HomeSafeBckup folder', properties: ['openDirectory', 'createDirectory'] });
  if (pick.canceled || !pick.filePaths[0]) throw new Error('No backup folder selected');
  const root = await fsp.realpath(pick.filePaths[0]);
  if (path.basename(root) !== 'HomeSafeBckup') throw new Error('Select the folder named HomeSafeBckup itself');
  const probe = path.join(root, `.homesafe-probe-${crypto.randomBytes(6).toString('hex')}`);
  await fsp.writeFile(probe, 'ok', { flag: 'wx' }); await fsp.unlink(probe); // verify drive is writable
  const ip = lanIP(); if (!ip) throw new Error('Connect this PC to your home Wi-Fi first');
  const st = await fsp.stat(root);
  await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const selfsigned = require('selfsigned');
  const pems = selfsigned.generate([{ name: 'commonName', value: 'HomeSafe Vault' }], { days: 365, keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip }] }] });
  const cert = path.join(stateDir, 'vault.crt'), key = path.join(stateDir, 'vault.key');
  await fsp.writeFile(cert, pems.cert, { flag: 'wx' }); await fsp.writeFile(key, pems.private, { flag: 'wx', mode: 0o600 });
  const config = { root, driveIdentity: { dev: st.dev, ino: st.ino }, instanceId: crypto.randomBytes(16).toString('hex'), origins: [ORIGIN], adminToken: crypto.randomBytes(32).toString('base64url'), identityKey: crypto.randomBytes(32).toString('base64'), cert, key, lanHost: ip };
  await fsp.writeFile(configPath, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
  return config;
}

function startService() {
  try { fs.unlinkSync(path.join(stateDir, 'service.lock')); } catch {} // only this app owns this state dir
  service = spawn(process.execPath, [path.join(serviceDir, 'src', 'cli.mjs'), 'start', '--state', stateDir], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  service.stderr.on('data', d => { lastError = String(d).trim(); });
  service.on('exit', code => { service = null; if (code) lastError ||= 'Vault service stopped. Check the USB drive is connected.'; });
}

async function boot() {
  serveDashboard();
  app.setLoginItemSettings({ openAtLogin: true });
  let config;
  try { config = await firstRunSetup(); startService(); }
  catch (e) { lastError = e.message; await dialog.showMessageBox({ type: 'warning', title: 'HomeSafe Vault', message: 'Vault service not started', detail: e.message }); }
  ipcMain.handle('vault:get-access-key', ev => {
    if (new URL(ev.senderFrame.url).origin !== ORIGIN) throw new Error('Untrusted page');
    return config && service ? config.adminToken : null;
  });
  ipcMain.handle('vault:status', () => ({ running: !!service, error: service ? '' : lastError }));
  win = new BrowserWindow({ width: 1280, height: 860, title: 'HomeSafe Vault', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.webContents.on('will-navigate', (e, url) => { if (new URL(url).origin !== ORIGIN) e.preventDefault(); });
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
