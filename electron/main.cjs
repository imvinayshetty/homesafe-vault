// HomeSafe Vault desktop wrapper: starts the local Vault service automatically and
// hands the owner access key only to the trusted dashboard window.
const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net, shell } = require('electron');
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
let service = null, win = null, lastError = '', pickedSource = 'chosen';

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
    if (await confirmDrive(found.root, { ...drive, existing: found.existing })) { if (!found.existing) await fsp.mkdir(found.root); pickedSource = 'auto'; return found.root; }
  } else {
    await dialog.showMessageBox({ type: 'info', title: 'HomeSafe Vault setup', message: 'Plug in your USB backup drive, then choose it.', detail: 'This is a one-time step. Nothing is uploaded; backups stay on this drive.' });
  }
  for (;;) {
    const pick = await dialog.showOpenDialog({ title: 'Choose your backup drive or its HomeSafeBckup folder', properties: ['openDirectory'] });
    if (pick.canceled || !pick.filePaths[0]) throw new Error('No backup drive chosen. Plug in your USB drive and reopen HomeSafe Vault.');
    const picked = pick.filePaths[0], target = path.basename(picked) === 'HomeSafeBckup' ? picked : path.join(picked, 'HomeSafeBckup');
    const existing = fs.existsSync(target);
    if (await confirmDrive(target, { ...(await driveInfo(existing ? target : picked)), name: path.basename(path.dirname(target)) || path.dirname(target), existing })) { if (!existing) await fsp.mkdir(target); pickedSource = 'chosen'; return target; }
  }
}

// Resolve and prove a chosen backup folder is the real, writable HomeSafeBckup folder.
async function prepareRoot(chosen) {
  const root = await fsp.realpath(chosen);
  if (path.basename(root) !== 'HomeSafeBckup') throw new Error('Select the folder named HomeSafeBckup itself');
  const probe = path.join(root, `.homesafe-probe-${crypto.randomBytes(6).toString('hex')}`);
  await fsp.writeFile(probe, 'ok', { flag: 'wx' }); await fsp.unlink(probe); // verify drive is writable
  return { root, st: await fsp.stat(root) };
}
// Why the saved backup location cannot be used right now (null = fine). Mirrors the service's own drive check.
async function rootProblem(cfg) {
  try {
    const st = await fsp.lstat(cfg.root);
    if (!st.isDirectory() || st.isSymbolicLink()) return `The saved backup location is not a folder: ${cfg.root}`;
    if (cfg.driveIdentity && (st.dev !== cfg.driveIdentity.dev || st.ino !== cfg.driveIdentity.ino)) return `The folder at ${cfg.root} is not the backup folder this Vault was set up with (a different drive has taken its place).`;
    return null;
  } catch { return `The backup drive is not connected. Expected the backup folder at: ${cfg.root}`; }
}
// Never show a pairing code while the backup folder is missing: the service only starts once the location is valid.
async function ensureBackupLocation(cfg, interactive) {
  let problem = await rootProblem(cfg);
  while (problem) {
    if (!interactive) throw new Error(problem);
    const r = await dialog.showMessageBox({ type: 'warning', title: 'HomeSafe Vault', message: 'Backup drive not found', detail: `${problem}\n\nPlug in your USB drive and press Retry, or choose the HomeSafeBckup folder yourself.`, buttons: ['Retry', 'Choose folder…', 'Quit'], defaultId: 0, cancelId: 2, noLink: true });
    if (r.response === 2) throw new Error('The backup drive is not available. Plug it in and reopen HomeSafe Vault.');
    if (r.response === 1) { try { await adoptRoot(cfg, await chooseBackupRoot()); } catch (e) { await dialog.showMessageBox({ type: 'warning', title: 'HomeSafe Vault', message: 'That folder cannot be used', detail: e.message }); } }
    problem = await rootProblem(cfg);
  }
  return cfg;
}
// Point config.json at a (new) backup folder. Phones keep their identity inside their folder on the drive;
// any paired phone that is not in the new folder must pair again, so list them and ask first.
async function adoptRoot(cfg, chosen) {
  const { root, st } = await prepareRoot(chosen);
  const phonesFile = path.join(stateDir, 'phones.json');
  const records = JSON.parse(await fsp.readFile(phonesFile, 'utf8').catch(() => '[]'));
  const missing = records.filter(r => !fs.existsSync(path.join(root, r.profile, r.phone, '.homesafe-daemon-identity.json')));
  if (missing.length && root !== cfg.root) {
    const ok = await dialog.showMessageBox({ type: 'question', title: 'HomeSafe Vault', buttons: ['Use this folder', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
      message: `${missing.length} paired phone${missing.length > 1 ? 's are' : ' is'} not in this folder`,
      detail: `${missing.map(r => `${r.profile} / ${r.phone}`).join('\n')}\n\nThey will need to pair again. Existing backups in the old folder are not touched or moved.` });
    if (ok.response !== 0) throw new Error('Backup location not changed.');
    await fsp.writeFile(`${phonesFile}.bak`, JSON.stringify(records), { mode: 0o600 });
    await fsp.writeFile(phonesFile, JSON.stringify(records.filter(r => !missing.includes(r))), { mode: 0o600 });
  }
  cfg.root = root; cfg.driveIdentity = { dev: st.dev, ino: st.ino }; cfg.locationSource = pickedSource;
  await fsp.writeFile(configPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
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
  const { root, st } = await prepareRoot(chosen);
  const ip = await lanIP(); if (!ip) throw new Error('Connect this PC to your home Wi-Fi first');
  await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const selfsigned = require('selfsigned');
  const pems = selfsigned.generate([{ name: 'commonName', value: 'HomeSafe Vault' }], { days: 1825, keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip }] }] });
  const cert = path.join(stateDir, 'vault.crt'), key = path.join(stateDir, 'vault.key');
  await fsp.writeFile(cert, pems.cert, { flag: 'wx' }); await fsp.writeFile(key, pems.private, { flag: 'wx', mode: 0o600 });
  const config = { root, locationSource: pickedSource, driveIdentity: { dev: st.dev, ino: st.ino }, instanceId: crypto.randomBytes(16).toString('hex'), origins: [ORIGIN], adminToken: crypto.randomBytes(32).toString('base64url'), identityKey: crypto.randomBytes(32).toString('base64'), cert, key, lanHost: ip };
  await fsp.writeFile(configPath, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
  return config;
}

let restarts = 0, restartTimer = null, config = null, suspended = false;
function ensureRunning() {
  if (service || restartTimer || !config || suspended) return;
  restartTimer = setTimeout(async () => { restartTimer = null; try { config = await firstRunSetup(); await ensureBackupLocation(config, false); startService(); } catch (e) { lastError = e.message; ensureRunning(); } }, Math.min(30000, 1000 * 2 ** Math.min(restarts++, 5)));
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
  try { config = await firstRunSetup(); await ensureBackupLocation(config, true); startService(); }
  catch (e) { lastError = e.message; await dialog.showMessageBox({ type: 'warning', title: 'HomeSafe Vault', message: 'Vault service not started', detail: e.message }); ensureRunning(); }
  ipcMain.handle('vault:get-access-key', ev => {
    if (originOf(ev.senderFrame.url) !== ORIGIN) throw new Error('Untrusted page');
    return config && service ? config.adminToken : null;
  });
  ipcMain.handle('vault:status', () => ({ running: !!service, error: service ? '' : lastError, location: config?.root ?? null }));
  ipcMain.handle('vault:get-location', async ev => { if (originOf(ev.senderFrame.url) !== ORIGIN) throw new Error('Untrusted page'); return locationInfo(); });
  ipcMain.handle('vault:change-location', async ev => { if (originOf(ev.senderFrame.url) !== ORIGIN) throw new Error('Untrusted page'); await changeLocation(); return locationInfo(); });
  ipcMain.handle('vault:ensure-running', () => { if (!service) { restarts = 0; ensureRunning(); } return { running: !!service, error: service ? '' : lastError }; });
  win = new BrowserWindow({ width: 1280, height: 860, title: 'HomeSafe Vault', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.webContents.on('will-navigate', (e, url) => { if (originOf(url) !== ORIGIN) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.on('page-title-updated', e => e.preventDefault()); // keep the backup location in the title
  refreshTitle();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'HomeSafe Vault', submenu: [{ label: 'Backup location…', click: () => void showLocation() }, { label: 'Change backup location…', click: () => void changeLocation() }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' },
  ]));
  win.loadURL(APP_URL);
}

async function locationInfo() {
  if (!config?.root) return { path: null, source: 'chosen', connected: false };
  const problem = await rootProblem(config);
  const space = problem ? null : await driveInfo(config.root).catch(() => null);
  return { path: config.root, source: config.locationSource === 'auto' ? 'auto' : 'chosen', connected: !problem, ...(problem ? { problem } : {}), ...(space ? { freeBytes: space.freeBytes, totalBytes: space.totalBytes } : {}) };
}
// The backup location is shown inside the app (dashboard text), not in the window's title bar.
function refreshTitle() { if (win) win.setTitle('HomeSafe Vault'); }
async function showLocation() {
  const info = await locationInfo();
  const r = await dialog.showMessageBox(win, { type: 'info', title: 'HomeSafe Vault', message: 'Backups are saved here', noLink: true, buttons: ['OK', 'Open folder', 'Change location…'], defaultId: 0, cancelId: 0,
    detail: `${info.path ?? 'No backup location set yet.'}\n\n${info.connected ? `Free space: ${gib(info.freeBytes)} of ${gib(info.totalBytes)}` : info.problem ?? ''}` });
  if (r.response === 1 && info.connected) shell.openPath(info.path);
  if (r.response === 2) await changeLocation();
}
async function changeLocation() {
  if (!config) return;
  const go = await dialog.showMessageBox(win, { type: 'question', title: 'HomeSafe Vault', message: 'Change the backup location?', noLink: true, buttons: ['Choose folder…', 'Cancel'], defaultId: 0, cancelId: 1,
    detail: 'The Vault restarts, so a backup that is in progress will stop. Existing backups are not moved or deleted.' });
  if (go.response !== 0) return;
  suspended = true;
  try {
    const next = { ...config }; await adoptRoot(next, await chooseBackupRoot()); // writes config.json and phones.json only after confirmation
    config = next;
    if (service) { const old = service; await new Promise(res => { old.once('exit', res); old.kill('SIGTERM'); }); }
  } catch (e) { if (e.message !== 'Backup location not changed.') await dialog.showMessageBox(win, { type: 'warning', title: 'HomeSafe Vault', message: 'Backup location not changed', detail: e.message }); }
  finally { suspended = false; refreshTitle(); restarts = 0; ensureRunning(); }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
  app.whenReady().then(boot);
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { if (service) service.kill('SIGTERM'); });
}
