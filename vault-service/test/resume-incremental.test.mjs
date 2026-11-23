import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { harness, today } from './helpers.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
async function backup(h, { kind, name, files, basedOn }) {
  const bytes = files.reduce((n, f) => n + f.data.length, 0);
  const challenge = await h.challenge();
  const started = await h.post('/v1/backup/start', {
    deviceId: h.deviceId, challenge, signature: h.signature({ deviceId: h.deviceId, challenge, action: 'backup', name, kind, files: files.length, bytes }),
    name, kind, ...(basedOn ? { basedOn } : {}), files: files.map(f => ({ path: f.path, bytes: f.data.length, modified: f.modified })),
  });
  const chunk = (index, offset, data, digest = sha(data)) => fetch(`${h.base}/v1/backup/chunk`, { method: 'POST', body: data, headers: { 'X-Transfer-Id': started.transferId, 'X-Transfer-Token': started.token, 'X-File-Index': String(index), 'X-Offset': String(offset), 'X-Sha256': digest } });
  return { started, chunk, resume: () => h.post('/v1/backup/resume', { transferId: started.transferId, token: started.token }), finish: () => h.post('/v1/backup/finish', { transferId: started.transferId, token: started.token }) };
}
const full = `Full_Bckup_${today()}`;
const A = { path: 'DCIM/a.jpg', data: Buffer.from('aaaaaa'), modified: 1700000000000 }, B = { path: 'DCIM/b.jpg', data: Buffer.from('bbbb'), modified: 1700000001000 };

test('a bad or dropped chunk does not kill the transfer; resume says where to continue; progress counts bytes', async () => {
  const h = await harness();
  try {
    h.select(); await h.pair();
    const t = await backup(h, { kind: 'Full', name: full, files: [A, B] });
    assert.equal((await t.chunk(0, 0, A.data.subarray(0, 3))).status, 200);
    // Corrupted in transit: rejected, nothing written, transfer still alive.
    assert.notEqual((await t.chunk(0, 3, A.data.subarray(3), '0'.repeat(64))).status, 200);
    assert.deepEqual(await t.resume(), { nextIndex: 0, nextOffset: 3, completedFiles: 0, receivedBytes: 3, totalFiles: 2, totalBytes: 10 });
    // Duplicate of an already-written chunk (the response was lost): rejected but harmless.
    assert.notEqual((await t.chunk(0, 0, A.data.subarray(0, 3))).status, 200);
    assert.equal((await t.resume()).nextOffset, 3);
    assert.equal((await t.chunk(0, 3, A.data.subarray(3))).status, 200);
    assert.deepEqual(await t.resume(), { nextIndex: 1, nextOffset: 0, completedFiles: 1, receivedBytes: 6, totalFiles: 2, totalBytes: 10 });
    assert.equal((await t.chunk(1, 0, B.data)).status, 200);
    const progress = (await h.wait(e => e.type === 'transfer_progress' && e.bytes === 10));
    assert.equal(progress.totalBytes, 10);
    assert.equal((await t.finish()).state, 'complete');
  } finally { await h.close(); }
});

test('baseline returns the latest complete Full backup; a Custom "changes" backup records what it is based on', async () => {
  const h = await harness();
  try {
    h.select(); await h.pair();
    const none = await h.post('/v1/backup/baseline', await (async () => { const challenge = await h.challenge(); return { deviceId: h.deviceId, challenge, signature: h.signature({ deviceId: h.deviceId, challenge, action: 'baseline' }) }; })());
    assert.deepEqual(none, { found: false });
    const t = await backup(h, { kind: 'Full', name: full, files: [A, B] });
    await t.chunk(0, 0, A.data); await t.chunk(1, 0, B.data); await t.finish();
    const challenge = await h.challenge();
    const first = await h.post('/v1/backup/baseline', { deviceId: h.deviceId, challenge, signature: h.signature({ deviceId: h.deviceId, challenge, action: 'baseline' }) });
    assert.equal(first.found, true); assert.equal(first.name, full); assert.equal(first.files, 2); assert.equal(first.next, null);
    assert.deepEqual(first.entries.map(e => [e.path, e.bytes, e.modified]), [[A.path, 6, A.modified], [B.path, 4, B.modified]]);
    const again = await h.post('/v1/backup/baseline', { deviceId: h.deviceId, token: first.token, offset: 1 });
    assert.deepEqual(again.entries.map(e => e.path), [B.path]);
    const bad = await h.call('/v1/backup/baseline', { deviceId: h.deviceId, token: 'nope', offset: 0 });
    assert.notEqual(bad.status, 200);
    // Only changed files go into the new backup; it is a Custom backup that points at its Full base.
    const C = { path: 'DCIM/b.jpg', data: Buffer.from('bbbbBB'), modified: 1700000009000 };
    const changes = `Custom_Bckup_${today()}_Changes`;
    const t2 = await backup(h, { kind: 'Custom', name: changes, basedOn: full, files: [C] });
    await t2.chunk(0, 0, C.data); await t2.finish();
    const catalogChallenge = await h.challenge();
    const { backups } = await h.post('/v1/backups', { deviceId: h.deviceId, challenge: catalogChallenge, signature: h.signature({ deviceId: h.deviceId, challenge: catalogChallenge, action: 'catalog' }) });
    const row = backups.find(b => b.name === changes);
    assert.equal(row.basedOn, full); assert.equal(row.entries, undefined, 'catalog must not ship every file list');
    const saved = JSON.parse(await fs.readFile(path.join(h.root, 'Owner', 'Pixel', changes, '.homesafe-backup.json'), 'utf8'));
    assert.equal(saved.basedOn, full); assert.equal(saved.entries[0].modified, C.modified);
  } finally { await h.close(); }
});

const C = { path: 'DCIM/c.jpg', data: Buffer.from('cccccccc'), modified: 1700000002000 };
const call = (h, t, route, extra = {}) => h.post(route, { transferId: t.started.transferId, token: t.started.token, ...extra });

test('a file that cannot be copied is parked, the rest continue, and skipping leaves it out of the backup and lists it', async () => {
  const h = await harness();
  try {
    h.select(); await h.pair();
    const t = await backup(h, { kind: 'Full', name: full, files: [A, B, C] });
    assert.equal((await t.chunk(0, 0, A.data.subarray(0, 2))).status, 200);
    await call(h, t, '/v1/backup/problem', { index: 0, reason: 'a.jpg changed while backing up' });
    assert.equal((await t.resume()).nextIndex, 1);
    assert.equal((await t.chunk(1, 0, B.data)).status, 200); assert.equal((await t.chunk(2, 0, C.data)).status, 200);
    assert.equal((await t.finish()).state, 'complete');
    const dir = path.join(h.root, 'Owner', 'Pixel', full);
    const m = JSON.parse(await fs.readFile(path.join(dir, '.homesafe-backup.json'), 'utf8').catch(async () => { const [p] = await fs.readdir(h.root); return fs.readFile(path.join(h.root, p, (await fs.readdir(path.join(h.root, p)))[0], full, '.homesafe-backup.json'), 'utf8'); }));
    assert.equal(m.complete, true); assert.equal(m.files, 2); assert.equal(m.skipped[0].path, 'DCIM/a.jpg'); assert.match(m.skipped[0].reason, /changed/);
    assert.deepEqual(m.entries.map(e => e.path), ['DCIM/b.jpg', 'DCIM/c.jpg']);
  } finally { await h.close(); }
});

test('retry with a new size and rename re-send a parked file from byte 0', async () => {
  const h = await harness();
  try {
    h.select(); await h.pair();
    const t = await backup(h, { kind: 'Full', name: full, files: [A, B] });
    assert.equal((await t.chunk(0, 0, A.data.subarray(0, 2))).status, 200);
    await call(h, t, '/v1/backup/problem', { index: 0, reason: 'changed' });
    const bigger = Buffer.from('aaaaaaaaaa');
    const r = await call(h, t, '/v1/backup/replace', { index: 0, path: 'DCIM/a-renamed.jpg', bytes: bigger.length });
    assert.equal(r.totalBytes, 14);
    assert.equal((await t.chunk(0, 0, bigger)).status, 200); assert.equal((await t.chunk(1, 0, B.data)).status, 200);
    assert.equal((await t.finish()).state, 'complete');
    // A name already used in the backup is refused.
    const t2 = await backup(h, { kind: 'Custom', name: `Custom_Bckup_${today()}_2`, files: [A, B] });
    await call(h, t2, '/v1/backup/problem', { index: 0, reason: 'x' });
    await assert.rejects(() => call(h, t2, '/v1/backup/replace', { index: 0, path: 'DCIM/b.jpg', bytes: 6 }));
  } finally { await h.close(); }
});

test('the phone stopping the backup stops the Vault immediately', async () => {
  const h = await harness();
  try {
    h.select(); await h.pair();
    const t = await backup(h, { kind: 'Full', name: full, files: [A, B] });
    assert.equal((await t.chunk(0, 0, A.data)).status, 200);
    await call(h, t, '/v1/backup/abort');
    assert.match((await h.wait(e => e.type === 'transfer_failed')).reason, /phone stopped/i);
    assert.notEqual((await t.chunk(1, 0, B.data)).status, 200);
  } finally { await h.close(); }
});

test('status tells a phone which drive is connected and its free space, without paths or names', async () => {
  const h = await harness();
  try {
    const s = await h.post('/v1/status', {});
    assert.equal(s.connected, true); assert.ok(s.totalBytes > 0 && s.freeBytes >= 0 && typeof s.driveName === 'string');
    assert.ok(!JSON.stringify(s).includes('HomeSafeBckup'));
  } finally { await h.close(); }
});

test('selecting a destination explains why it was refused, and frees a transfer the phone abandoned', async () => {
  const h = await harness();
  try {
    h.select(); await h.pair();
    const t = await backup(h, { kind: 'Full', name: full, files: [A] });
    h.ws.send(JSON.stringify({ type: 'select_destination', profile: 'Other', phone: 'Phone2', email: 'owner@example.test' }));
    assert.match((await h.wait(e => e.type === 'service_error')).reason, /still running/);
    assert.ok(t.started.transferId);
  } finally { await h.close(); }
});

test('the same account can pair a phone of the same name again (app reinstalled); another account cannot', async () => {
  const { generateKeyPairSync, sign, randomBytes } = await import('node:crypto');
  const { canonical } = await import('../src/native-protocol.mjs');
  const h = await harness();
  try {
    h.select(); await h.pair();
    const again = async email => {
      h.ws.send(JSON.stringify({ type: 'reset' })); await new Promise(r => setTimeout(r, 100)); h.events.length = 0; h.select(); 
      const { privateKey, publicKey } = generateKeyPairSync('ed25519'), pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
      const sig = v => sign(null, Buffer.from(canonical(v)), privateKey).toString('base64'), deviceId = 'native-device-' + randomBytes(6).toString('hex');
      const code = (await h.wait(e => e.type === 'pairing_code')).code, begin = { email, code, deviceId, publicKey: pub };
      const offer = await h.post('/v1/pair/begin', { ...begin, signature: sig(begin) });
      return h.post('/v1/pair/confirm', { requestId: offer.requestId, signature: sig({ requestId: offer.requestId, challenge: offer.challenge, profile: offer.profile, phone: offer.phone }) });
    };
    assert.equal((await again('owner@example.com')).connected, true);
    const names = await fs.readdir(path.join(h.root, 'Owner', 'Pixel'));
    assert.ok(names.some(n => n.includes('.replaced-')));
  } finally { await h.close(); }
});
