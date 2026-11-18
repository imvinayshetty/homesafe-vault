import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, generateKeyPairSync, sign } from 'node:crypto';
import { WebSocket } from 'ws';
import { createVaultService } from '../src/service.mjs';
import { canonical } from '../src/native-protocol.mjs';
/** Real service on random ports plus a signed native phone client. */
export async function harness(extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-')), root = path.join(dir, 'HomeSafeBckup'); await fs.mkdir(root);
  const admin = randomBytes(32).toString('base64url');
  const s = await createVaultService({ root, stateDir: dir, identityKey: randomBytes(32).toString('base64'), adminToken: admin, origins: ['http://localhost:8080'], testOnly: true, monitorPort: 0, lanPort: 0, lanHost: '192.168.1.108', ...extra });
  const ws = new WebSocket(`ws://127.0.0.1:${s.monitorPort}/v1/transfer-events`, { origin: 'http://localhost:8080' }), events = [];
  ws.on('message', b => events.push(JSON.parse(b)));
  const wait = async f => { for (let i = 0; i < 200; i++) { const e = events.filter(f).at(-1); if (e) return e; await new Promise(r => setTimeout(r, 10)); } throw Error('Event missing'); };
  const base = `http://127.0.0.1:${s.lanPort}`;
  const call = async (p, b) => { const r = await fetch(base + p, { method: 'POST', body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
  const post = async (p, b) => { const r = await call(p, b); if (r.status !== 200) throw Error(JSON.stringify(r.body)); return r.body; };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
  const signature = v => sign(null, Buffer.from(canonical(v)), privateKey).toString('base64');
  const deviceId = 'native-device-' + randomBytes(6).toString('hex');
  await new Promise(r => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'authenticate', token: admin })); await wait(e => e.type === 'service_ready');
  const select = (profile = 'Owner', phone = 'Pixel', email = 'owner@example.com') => ws.send(JSON.stringify({ type: 'select_destination', profile, phone, email }));
  const pair = async (email = 'owner@example.com') => {
    const code = (await wait(e => e.type === 'pairing_code')).code, begin = { email, code, deviceId, publicKey: pub };
    const offer = await post('/v1/pair/begin', { ...begin, signature: signature(begin) });
    return post('/v1/pair/confirm', { requestId: offer.requestId, signature: signature({ requestId: offer.requestId, challenge: offer.challenge, profile: offer.profile, phone: offer.phone }) });
  };
  const challenge = async () => (await post('/v1/device/challenge', { deviceId })).challenge;
  const close = async () => { ws.terminate(); await s.close(); await fs.rm(dir, { recursive: true }); };
  return { dir, root, admin, s, ws, events, wait, base, call, post, signature, deviceId, select, pair, challenge, close };
}
export const today = () => { const d = new Date(); return [d.getDate(), d.getMonth() + 1, d.getFullYear() % 100].map(n => String(n).padStart(2, '0')).join(''); };
