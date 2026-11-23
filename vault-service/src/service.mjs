import http from 'node:http';
import https from 'node:https';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomInt, timingSafeEqual, createHash, X509Certificate } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { segment } from './storage.mjs';
import { buildLibrary } from './library.mjs';
import { createNativeProtocol, vaultError, errorCode, ERROR_MESSAGES } from './native-protocol.mjs';
import { createTransferHistory } from './transfer-history.mjs';
export const CODE_LIFETIME_MS = 30000;
export const MINTED_CODE_LIFETIME_MS = 120000;
export const DEFAULT_LAN_PORT = 7443;
/** Phone protocol v1 QR: profile and phone are NOT included; the phone learns them from /v1/pair/begin. */
export function pairingQr({ host, port, fingerprint, code, email }) { const q = new URLSearchParams({ v: '1', host: host ?? '', port: String(port), fp: fingerprint ?? '', code, email: email ?? '' }); return `homesafe://pair?${q}`; }
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function validCode(pairing, code, now = Date.now()) { return Boolean(pairing && now < pairing.expiresAt && equal(pairing.code, code)); }
const STATUS = { rate_limited: 429, transfer_active: 409, name_exists: 409, drive_unavailable: 503, no_space: 507 };
export async function createVaultService(config) {
  const root = await fs.realpath(config.root); // Must already exist: never silently recreate a disconnected mount.
  const rootStat = await fs.lstat(root);
  if (config.driveIdentity && (rootStat.dev !== config.driveIdentity.dev || rootStat.ino !== config.driveIdentity.ino)) throw new Error('Configured drive changed; reconnect the original drive');
  if (!rootStat.isDirectory()) throw new Error('Select an existing HomeSafeBckup directory');
  const assertRoot = async () => { const s = await fs.lstat(root).catch(() => null); if (!s || !s.isDirectory() || s.isSymbolicLink() || s.dev !== rootStat.dev || s.ino !== rootStat.ino) throw vaultError('drive_unavailable'); };
  const key = Buffer.from(config.identityKey, 'base64');
  if (key.length !== 32 || !/^[\w-]{43}$/.test(config.adminToken)) throw new Error('Invalid local service keys');
  const recordsFile = path.join(config.stateDir, 'phones.json');
  let records = JSON.parse(await fs.readFile(recordsFile, 'utf8').catch(e => { if (e.code === 'ENOENT') return '[]'; throw e; }));
  const monitors = new Set(), attempts = new Map();
  let selected = null, pairing = null, history = [], closed = false;
  let queue = Promise.resolve();
  const serialize = work => { const result = queue.then(work); queue = result.catch(() => {}); return result; };
  const audit = async (type, stage) => {
    const file = path.join(config.stateDir, 'events.jsonl');
    const s = await fs.stat(file).catch(() => null); if (s && s.size > 1024 * 1024) await fs.rename(file, `${file}.previous`);
    await fs.appendFile(file, JSON.stringify({ at: new Date().toISOString(), type, ...(stage ? { stage } : {}) }) + '\n', { mode: 0o600 });
  };
  // Diagnostic log: the phone only ever sees a generic "Request rejected" message, so record the real cause here.
  const logFailure = async (route, e, v) => {
    try {
      const file = path.join(config.stateDir, 'vault.log');
      const s = await fs.stat(file).catch(() => null); if (s && s.size > 2 * 1024 * 1024) await fs.rename(file, `${file}.previous`);
      const entry = { at: new Date().toISOString(), route, code: errorCode(e), error: String(e?.message ?? e).slice(0, 300), ...(e?.code ? { sysCode: e.code } : {}) };
      if (Array.isArray(e?.issues)) entry.issues = e.issues.slice(0, 5).map(i => { const idx = i.path?.[0] === 'files' ? i.path[1] : undefined, name = typeof idx === 'number' ? v?.files?.[idx]?.path : undefined; return { at: i.path?.join('.'), message: i.message, ...(name !== undefined ? { filePath: String(name).slice(0, 160), length: String(name).length } : {}) }; });
      await fs.appendFile(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
    } catch { /* logging must never break a request */ }
  };
  const send = (ws, event) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event)); };
  const emit = event => { if (event.type === 'transfer_progress' && history.at(-1)?.type === 'transfer_progress') history.pop(); history.push(event); for (const ws of monitors) send(ws, event); };
  const x509 = config.tls ? new X509Certificate(config.tls.cert) : null;
  const fingerprint = x509 ? createHash('sha256').update(x509.raw).digest('hex') : null, certExpiresAt = x509 ? Date.parse(x509.validTo) : null;
  let lanPort = config.lanPort ?? DEFAULT_LAN_PORT;
  const codeEvent = () => ({ type: 'pairing_code', ...pairing, fingerprint, host: config.lanHost ?? null, port: lanPort, certExpiresAt, qr: pairingQr({ host: config.lanHost, port: lanPort, fingerprint, code: pairing.code, email: selected.email }) });
  const rotate = (lifetime = CODE_LIFETIME_MS) => {
    if (!selected || native.active() || history.length) return;
    pairing = { code: String(randomInt(0, 1000000)).padStart(6, '0'), expiresAt: Date.now() + lifetime, single: lifetime === MINTED_CODE_LIFETIME_MS };
    for (const ws of monitors) send(ws, codeEvent());
  };
  const reply = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const body = async req => { let size = 0, chunks = []; for await (const c of req) { size += c.length; if (size > 2 * 1024 * 1024) throw new Error('Request too large'); chunks.push(c); } return JSON.parse(Buffer.concat(chunks).toString()); };
  const sendHistory = ws => send(ws, { type: 'transfer_history', backups: transferHistory.list(selected) });
  const transferHistory = await createTransferHistory({ stateDir: config.stateDir, root, key, assertRoot, onChange: () => { for (const ws of monitors) sendHistory(ws); } });
  const native = createNativeProtocol({ root, key, selected: () => selected, pairing: () => pairing, consumeCode: () => { pairing = null; }, records: () => records, saveRecords: async next => { await fs.writeFile(`${recordsFile}.tmp`, JSON.stringify(next), { mode: 0o600 }); await fs.rename(`${recordsFile}.tmp`, recordsFile); records = next; }, emit, audit, assertRoot, validCode, history: transferHistory });
  const reject = (res, e) => { const code = errorCode(e); reply(res, STATUS[code] ?? 400, { error: ERROR_MESSAGES[code], code }); };
  const ROUTES = ['/v1/pair/begin', '/v1/pair/confirm', '/v1/device/challenge', '/v1/backups', '/v1/backup/start', '/v1/backup/files', '/v1/backup/chunk', '/v1/backup/resume', '/v1/backup/baseline', '/v1/status', '/v1/backup/abort', '/v1/backup/problem', '/v1/backup/replace', '/v1/backup/finish'];
  const handler = (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Native clients do not send Origin. Reject browser LAN calls; monitoring uses its own authenticated loopback socket.
    if (req.headers.origin) return reject(res, vaultError('invalid_request'));
    void serialize(async () => {
      const url = new URL(req.url, 'https://vault.local');
      if (req.method === 'GET' && url.pathname === '/v1/info') return reply(res, 200, { name: 'HomeSafe Vault', version: 1 });
      if (req.method !== 'POST' || !ROUTES.includes(url.pathname)) return reject(res, vaultError('invalid_request'));
      if (url.pathname === '/v1/pair/begin') { const ip = req.socket.remoteAddress, limit = attempts.get(ip), live = limit && limit.until > Date.now(); if (live && limit.count >= 5) return reject(res, vaultError('rate_limited')); attempts.set(ip, { count: live ? limit.count + 1 : 1, until: live ? limit.until : Date.now() + 60000 }); }
      let v = {};
      try { if (url.pathname !== '/v1/backup/chunk') v = await body(req); return reply(res, 200, await native.handle(url.pathname, v, req)); }
      catch (e) { await logFailure(url.pathname, e, v); if (!e.retryableManifest && !e.retryable && native.ownsRequest(url.pathname, v, req)) await native.fail(e); return reject(res, e); }
    }).catch(e => { if (!res.headersSent) reject(res, e); else res.destroy(); });
  };
  const monitorServer = http.createServer((req, res) => { if (req.url === '/v1/ready' && !req.headers.origin) { void assertRoot().then(() => reply(res,200,{service:'homesafe-vault',instanceId:config.instanceId,driveReady:true})).catch(() => reply(res,503,{driveReady:false})); } else reply(res,404,{error:'Use the authenticated monitor socket'}); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  monitorServer.on('upgrade', (req, socket, head) => {
    const address = req.socket.remoteAddress;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address) || !config.origins.includes(req.headers.origin) || new URL(req.url, 'http://localhost').pathname !== '/v1/transfer-events') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      const timeout = setTimeout(() => ws.close(1008, 'Authentication required'), 5000); let authenticated = false;
      ws.on('message', raw => { void serialize(async () => {
        const v = JSON.parse(raw.toString());
        if (!authenticated) { if (v.type !== 'authenticate' || !equal(v.token, config.adminToken)) return ws.close(1008, 'Unauthorized'); authenticated = true; clearTimeout(timeout); send(ws, { type: 'service_ready' }); return; }
        if (v.type === 'list_library') { await assertRoot(); send(ws, await buildLibrary({ root, records, email: z.string().email().max(254).parse(v.email).toLowerCase(), profile: v.profile === undefined ? undefined : segment.parse(v.profile) })); return; }
        if (v.type === 'select_destination' && v.email && records.some(r => r.profile.toLowerCase() === String(v.profile).toLowerCase() && r.email !== String(v.email).toLowerCase())) throw Object.assign(new Error('This profile belongs to another account'), { userMessage: 'This profile belongs to another account. Sign in with that account and its Authy code, or choose your own profile.' });
        if (v.type === 'select_destination' || v.type === 'reset') {
          if (v.type === 'select_destination' && selected?.profile === v.profile && selected?.phone === v.phone && (selected?.email ?? '') === (v.email ?? '').toLowerCase()) { monitors.add(ws); sendHistory(ws); for (const e of history) send(ws, e); if (pairing && !history.length) send(ws, codeEvent()); return; }
          // A transfer the phone abandoned (it crashed or lost Wi-Fi for good) must not block the owner for the full 20 minutes.
          if (native.active() && native.idleMs() > 120000) await native.fail(vaultError('phone_stopped'));
          if (native.active()) throw Object.assign(new Error('A transfer is active'), { userMessage: 'A backup is still running for another phone. Wait for it to finish, or stop it on the phone, then try again.' });
          if (v.type === 'select_destination' && [...monitors].some(m => m !== ws && m.readyState === WebSocket.OPEN)) throw Object.assign(new Error('Another dashboard owns the selected destination'), { userMessage: 'Another Vault window is already open on this PC. Close it, then try again.' });
          monitors.add(ws);
          native.reset();
          if (v.type === 'select_destination') selected = { profile: segment.parse(v.profile), phone: segment.parse(v.phone), ...(v.email ? { email: z.string().email().max(254).parse(v.email).toLowerCase() } : {}) };
          history = []; sendHistory(ws); rotate(); await audit('profile_selected');
        }
        if (v.type === 'verify_backup') {
          if (!selected || !monitors.has(ws) || native.active()) throw new Error('Wait for the current transfer to finish');
          await transferHistory.recheck(z.string().parse(v.id), selected, records); return;
        }
        if (v.type === 'mint_pairing') {
          // Owner-authenticated loopback replacement for the old terminal `pair` command: single-use, 120 seconds.
          if (!selected || !monitors.has(ws) || native.active() || history.length) throw new Error('Choose a phone and wait for any transfer to finish');
          rotate(MINTED_CODE_LIFETIME_MS); await audit('pairing_minted'); return;
        }
        if (v.type === 'revoke_phone') {
          const profile = segment.parse(v.profile), phone = segment.parse(v.phone);
          records = records.map(r => r.profile === profile && r.phone === phone ? { ...r, revoked: true } : r);
          await fs.writeFile(`${recordsFile}.tmp`, JSON.stringify(records), { mode: 0o600 }); await fs.rename(`${recordsFile}.tmp`, recordsFile);
          const owner = native.activeIdentity(); if (owner?.profile === profile && owner.phone === phone) await native.fail();
          send(ws, { type: 'phone_revoked', profile, phone }); await audit('phone_revoked');
        }
      }).catch(async e => { await logFailure('ws', e, undefined); send(ws, { type: 'service_error', reason: e?.userMessage ?? `Could not select that phone: ${String(e?.message ?? e).slice(0, 120)}` }); }); });
      ws.on('close', () => { clearTimeout(timeout); monitors.delete(ws); });
    });
  });
  const lanServer = config.tls ? https.createServer(config.tls, handler) : config.testOnly ? http.createServer(handler) : null;
  if (!lanServer) throw new Error('TLS certificate and key required for phone connections');
  lanServer.requestTimeout = 120000; lanServer.headersTimeout = 15000;
  const listen = (server, port, host) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  await listen(monitorServer, config.monitorPort ?? 7878, '127.0.0.1');
  try { await listen(lanServer, lanPort, config.testOnly ? '127.0.0.1' : config.lanHost ?? '0.0.0.0'); } catch (e) { monitorServer.close(); throw e; }
  lanPort = lanServer.address().port;
  const timer = setInterval(() => { if (!pairing || pairing.expiresAt <= Date.now()) rotate(); if (native.expired()) void serialize(() => native.fail()); for (const [ip, a] of attempts) if (a.until <= Date.now()) attempts.delete(ip); }, 500);
  return { monitorPort: monitorServer.address().port, lanPort, fingerprint, certExpiresAt, async close() { if (closed) return; closed = true; clearInterval(timer); for (const ws of wss.clients) ws.terminate(); await Promise.all([new Promise(r => monitorServer.close(r)), new Promise(r => lanServer.close(r))]); } };
}
