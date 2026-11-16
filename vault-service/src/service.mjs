import http from 'node:http';
import https from 'node:https';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomInt, timingSafeEqual, createPublicKey, verify } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { segment, enrollIdentity, verifyIdentity, createTransfer, receiveFile, finishTransfer } from './storage.mjs';
export const CODE_LIFETIME_MS = 30000;
const token = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const pairSchema = z.object({ profile: segment, phone: segment, code: z.string().regex(/^\d{6}$/), publicKey: z.string().max(200), challenge: z.string().max(100), signature: z.string().max(200) });
export function pairingMessage(v) { return JSON.stringify(['homesafe-pair-v1', v.challenge, v.code, v.profile, v.phone, v.publicKey]); }
export function validCode(pairing, code, now = Date.now()) { return Boolean(pairing && now < pairing.expiresAt && equal(pairing.code, code)); }
export async function createVaultService(config) {
  const root = await fs.realpath(config.root); // Must already exist: never silently recreate a disconnected mount.
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory()) throw new Error('Select an existing HomeSafeBckup directory');
  const assertRoot = async () => { const s = await fs.lstat(root); if (!s.isDirectory() || s.isSymbolicLink() || s.dev !== rootStat.dev || s.ino !== rootStat.ino) throw new Error('Selected drive disconnected or changed'); };
  const key = Buffer.from(config.identityKey, 'base64');
  if (key.length !== 32 || !/^[\w-]{43}$/.test(config.adminToken)) throw new Error('Invalid local service keys');
  const recordsFile = path.join(config.stateDir, 'phones.json');
  let records = JSON.parse(await fs.readFile(recordsFile, 'utf8').catch(e => { if (e.code === 'ENOENT') return '[]'; throw e; }));
  const monitors = new Set(), sessions = new Map(), challenges = new Map(), attempts = new Map();
  let selected = null, pairing = null, history = [], active = null, closed = false;
  let queue = Promise.resolve();
  const serialize = work => { const result = queue.then(work); queue = result.catch(() => {}); return result; };
  const audit = async (type, stage) => {
    const file = path.join(config.stateDir, 'events.jsonl');
    const s = await fs.stat(file).catch(() => null); if (s && s.size > 1024 * 1024) await fs.rename(file, `${file}.previous`);
    await fs.appendFile(file, JSON.stringify({ at: new Date().toISOString(), type, ...(stage ? { stage } : {}) }) + '\n', { mode: 0o600 });
  };
  const send = (ws, event) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event)); };
  const emit = event => { if (event.type === 'transfer_progress' && history.at(-1)?.type === 'transfer_progress') history.pop(); history.push(event); for (const ws of monitors) send(ws, event); };
  const rotate = () => {
    if (!selected || active || history.length) return;
    pairing = { code: String(randomInt(0, 1000000)).padStart(6, '0'), expiresAt: Date.now() + CODE_LIFETIME_MS };
    for (const ws of monitors) send(ws, { type: 'pairing_code', ...pairing });
  };
  const fail = async () => { if (active) active.failed = true; emit({ type: 'transfer_failed', reason: 'Local transfer failed. Check the drive and phone connection, then reconnect.' }); await audit('failure', 'transfer'); };
  const reply = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const body = async req => { let size = 0, chunks = []; for await (const c of req) { size += c.length; if (size > 2 * 1024 * 1024) throw new Error('Request too large'); chunks.push(c); } return JSON.parse(Buffer.concat(chunks).toString()); };
  const handler = (req, res) => {
    let authorizedActivity = false;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Native clients do not send Origin. Reject browser LAN calls; monitoring uses its own authenticated loopback socket.
    if (req.headers.origin) { reply(res, 403, { error: 'Native phone client required' }); return; }
    void serialize(async () => {
      const url = new URL(req.url, 'https://vault.local');
      if (req.method === 'GET' && url.pathname === '/v1/info') return reply(res, 200, { name: 'HomeSafe Vault', version: 1 });
      if (req.method === 'POST' && url.pathname === '/v1/challenge') {
        const ip = req.socket.remoteAddress, limit = attempts.get(ip);
        if (limit && limit.until > Date.now() && limit.count >= 5) return reply(res, 429, { error: 'Try again in one minute' });
        attempts.set(ip, { count: limit && limit.until > Date.now() ? limit.count + 1 : 1, until: limit && limit.until > Date.now() ? limit.until : Date.now() + 60000 });
        if (challenges.size > 1000) challenges.clear();
        const challenge = token(); challenges.set(challenge, { expiresAt: Date.now() + 30000, ip }); return reply(res, 200, { challenge });
      }
      if (req.method === 'POST' && url.pathname === '/v1/pair') {
        const v = pairSchema.parse(await body(req)), challenge = challenges.get(v.challenge); challenges.delete(v.challenge);
        if (!challenge || challenge.ip !== req.socket.remoteAddress || challenge.expiresAt <= Date.now() || !selected || selected.profile !== v.profile || selected.phone !== v.phone || !validCode(pairing, v.code)) return reply(res, 401, { error: 'Pairing expired or not authorized' });
        const publicKey = createPublicKey({ key: Buffer.from(v.publicKey, 'base64'), format: 'der', type: 'spki' });
        if (publicKey.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(pairingMessage(v)), publicKey, Buffer.from(v.signature, 'base64'))) return reply(res, 401, { error: 'Device signature rejected' });
        authorizedActivity = true; await assertRoot(); emit({ type: 'phone_connecting' });
        const identity = { profile: v.profile, phone: v.phone, publicKey: v.publicKey };
        const record = records.find(r => r.profile === v.profile && r.phone === v.phone);
        if (record) { if (record.publicKey !== v.publicKey || record.revoked) throw new Error('Phone identity mismatch or revoked'); await verifyIdentity(root, key, identity); }
        else { await enrollIdentity(root, key, identity); records.push(identity); await fs.writeFile(`${recordsFile}.tmp`, JSON.stringify(records), { mode: 0o600 }); await fs.rename(`${recordsFile}.tmp`, recordsFile); }
        pairing = null; sessions.clear(); const session = token(); sessions.set(session, { identity, expiresAt: Date.now() + 3600000 });
        emit({ type: 'pairing_verified', profile: v.profile, phone: v.phone }); await audit('phone_paired'); return reply(res, 200, { token: session, expiresIn: 3600 });
      }
      const session = sessions.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (!session || session.expiresAt <= Date.now() || !selected || session.identity.profile !== selected.profile || session.identity.phone !== selected.phone) return reply(res, 401, { error: 'Pair again on the Vault' });
      authorizedActivity = true;
      await assertRoot();
      if (req.method === 'POST' && url.pathname === '/v1/backups') {
        if (active || history.at(-1)?.type !== 'pairing_verified') return reply(res, 409, { error: 'Reconnect before starting another backup' });
        const t = await createTransfer(root, key, session.identity, await body(req));
        active = { ...t, id: token(), identity: session.identity, failed: false, lastActivity: Date.now() }; emit({ type: 'transfer_started' }); emit({ type: 'transfer_progress', files: 0, total: t.files.length }); await audit('transfer_started'); return reply(res, 201, { id: active.id, name: t.name });
      }
      const match = url.pathname.match(/^\/v1\/backups\/([\w-]+)\/(files\/(\d+)|complete|cancel)$/);
      if (!match || !active || active.id !== match[1] || active.failed) return reply(res, 404, { error: 'Transfer not found' });
      if (req.method === 'PUT' && match[3] !== undefined) { active.lastActivity = Date.now(); await receiveFile(root, key, session.identity, active, Number(match[3]), req); active.lastActivity = Date.now(); emit({ type: 'transfer_progress', files: active.completed.size, total: active.files.length }); return reply(res, 200, { saved: true }); }
      if (req.method === 'POST' && match[2] === 'complete') { await finishTransfer(root, key, session.identity, active); emit({ type: 'transfer_completed' }); active = null; sessions.clear(); await audit('transfer_completed'); return reply(res, 200, { complete: true }); }
      if (req.method === 'POST' && match[2] === 'cancel') { await fail(); return reply(res, 200, { cancelled: true }); }
      reply(res, 404, { error: 'Unknown operation' });
    }).catch(async () => { if (authorizedActivity) await fail().catch(() => {}); if (!res.headersSent) reply(res, 400, { error: 'Request rejected; check pairing, file manifest, and storage. Existing backups are never replaced.' }); else res.destroy(); });
  };
  const monitorServer = http.createServer((req, res) => reply(res, 404, { error: 'Use the authenticated monitor socket' }));
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  monitorServer.on('upgrade', (req, socket, head) => {
    const address = req.socket.remoteAddress;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address) || !config.origins.includes(req.headers.origin) || new URL(req.url, 'http://localhost').pathname !== '/v1/transfer-events') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      const timeout = setTimeout(() => ws.close(1008, 'Authentication required'), 5000); let authenticated = false;
      ws.on('message', raw => { void serialize(async () => {
        const v = JSON.parse(raw.toString());
        if (!authenticated) { if (v.type !== 'authenticate' || !equal(v.token, config.adminToken)) return ws.close(1008, 'Unauthorized'); authenticated = true; clearTimeout(timeout); monitors.add(ws); for (const e of history) send(ws, e); if (pairing) send(ws, { type: 'pairing_code', ...pairing }); send(ws, { type: 'service_ready' }); return; }
        if (v.type === 'select_destination' || v.type === 'reset') {
          if (v.type === 'select_destination' && selected?.profile === v.profile && selected?.phone === v.phone) return;
          if (active && !active.failed) throw new Error('A transfer is active');
          if (v.type === 'select_destination') selected = { profile: segment.parse(v.profile), phone: segment.parse(v.phone) };
          active = null; history = []; sessions.clear(); rotate(); await audit('profile_selected');
        }
        if (v.type === 'revoke_phone') {
          const profile = segment.parse(v.profile), phone = segment.parse(v.phone);
          records = records.map(r => r.profile === profile && r.phone === phone ? { ...r, revoked: true } : r);
          await fs.writeFile(`${recordsFile}.tmp`, JSON.stringify(records), { mode: 0o600 }); await fs.rename(`${recordsFile}.tmp`, recordsFile);
          for (const [id, s] of sessions) if (s.identity.profile === profile && s.identity.phone === phone) sessions.delete(id);
          if (active?.identity.profile === profile && active.identity.phone === phone) await fail();
          send(ws, { type: 'phone_revoked', profile, phone }); await audit('phone_revoked');
        }
      }).catch(() => send(ws, { type: 'service_error', reason: 'Destination unavailable or transfer still active' })); });
      ws.on('close', () => { clearTimeout(timeout); monitors.delete(ws); });
    });
  });
  const lanServer = config.tls ? https.createServer(config.tls, handler) : config.testOnly ? http.createServer(handler) : null;
  if (!lanServer) throw new Error('TLS certificate and key required for phone connections');
  lanServer.requestTimeout = 120000; lanServer.headersTimeout = 15000;
  const listen = (server, port, host) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  await listen(monitorServer, config.monitorPort ?? 7878, '127.0.0.1');
  try { await listen(lanServer, config.lanPort ?? 7879, config.testOnly ? '127.0.0.1' : config.lanHost ?? '0.0.0.0'); } catch (e) { monitorServer.close(); throw e; }
  const timer = setInterval(() => { if (!pairing || pairing.expiresAt <= Date.now()) rotate(); if (active && !active.failed && Date.now() - active.lastActivity > 180000) { active.failed = true; void serialize(fail); } for (const [t, s] of sessions) if (s.expiresAt <= Date.now()) sessions.delete(t); for (const [t, c] of challenges) if (c.expiresAt <= Date.now()) challenges.delete(t); for (const [ip, a] of attempts) if (a.until <= Date.now()) attempts.delete(ip); }, 500);
  return { monitorPort: monitorServer.address().port, lanPort: lanServer.address().port, async close() { if (closed) return; closed = true; clearInterval(timer); for (const ws of wss.clients) ws.terminate(); await Promise.all([new Promise(r => monitorServer.close(r)), new Promise(r => lanServer.close(r))]); } };
}
