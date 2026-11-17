import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { createVaultService, pairingQr, MINTED_CODE_LIFETIME_MS, DEFAULT_LAN_PORT } from '../src/service.mjs';
import { findBackupRoot, isPrivateIPv4 } from '../src/discovery.mjs';

test('phones use port 7443 by default', () => assert.equal(DEFAULT_LAN_PORT, 7443));
test('only home-network addresses count as LAN', () => {
  for (const ip of ['192.168.1.108', '10.0.0.4', '172.20.1.1']) assert.ok(isPrivateIPv4(ip));
  for (const ip of ['8.8.8.8', '172.32.0.1', '127.0.0.1']) assert.ok(!isPrivateIPv4(ip));
});
test('QR carries host, port, fingerprint, code and account', () => {
  const u = new URL(pairingQr({ host: '192.168.1.108', port: 7443, fingerprint: 'ab', code: '123456', email: 'a@b.co', profile: 'Vinay', phone: 'Pixel' }));
  assert.equal(u.protocol, 'homesafe:'); assert.equal(u.searchParams.get('code'), '123456'); assert.equal(u.searchParams.get('port'), '7443'); assert.equal(u.searchParams.get('fp'), 'ab');
});
test('existing HomeSafeBckup wins, else the drive with most free space', async () => {
  const a = await fs.mkdtemp(path.join(os.tmpdir(), 'da-')), b = await fs.mkdtemp(path.join(os.tmpdir(), 'db-'));
  assert.equal((await findBackupRoot([{ root: a, freeBytes: 1 }, { root: b, freeBytes: 9 }])).root, path.join(b, 'HomeSafeBckup'));
  await fs.mkdir(path.join(a, 'HomeSafeBckup'));
  assert.deepEqual(await findBackupRoot([{ root: a, freeBytes: 1 }, { root: b, freeBytes: 9 }]), { root: path.join(a, 'HomeSafeBckup'), existing: true });
});
test('dashboard mints a single 120-second pairing code with QR', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mint-')), root = path.join(dir, 'HomeSafeBckup'); await fs.mkdir(root);
  const admin = randomBytes(32).toString('base64url');
  const s = await createVaultService({ root, stateDir: dir, identityKey: randomBytes(32).toString('base64'), adminToken: admin, origins: ['http://localhost:8080'], testOnly: true, monitorPort: 0, lanPort: 0, lanHost: '192.168.1.108' });
  const ws = new WebSocket(`ws://127.0.0.1:${s.monitorPort}/v1/transfer-events`, { origin: 'http://localhost:8080' }), events = [];
  ws.on('message', b => events.push(JSON.parse(b)));
  await new Promise(r => ws.once('open', r));
  const wait = async f => { for (let i = 0; i < 200; i++) { const e = events.filter(f).at(-1); if (e) return e; await new Promise(r => setTimeout(r, 10)); } throw Error('missing'); };
  ws.send(JSON.stringify({ type: 'authenticate', token: admin })); await wait(e => e.type === 'service_ready');
  ws.send(JSON.stringify({ type: 'select_destination', profile: 'Vinay', phone: 'Pixel', email: 'v@x.co' }));
  const first = await wait(e => e.type === 'pairing_code');
  assert.ok(first.expiresAt - Date.now() <= 30000);
  const before = events.length; ws.send(JSON.stringify({ type: 'mint_pairing' }));
  const minted = await wait(e => e.type === 'pairing_code' && events.indexOf(e) >= before);
  assert.ok(minted.expiresAt - Date.now() > 100000 && minted.expiresAt - Date.now() <= MINTED_CODE_LIFETIME_MS);
  assert.equal(new URL(minted.qr).searchParams.get('code'), minted.code);
  assert.equal(new URL(minted.qr).searchParams.get('host'), '192.168.1.108');
  ws.close(); await s.close();
});
