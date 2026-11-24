import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { harness, today } from './helpers.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
async function backup(h, { name, files }, mode = 'staged') {
  const bytes = files.reduce((n, f) => n + f.data.length, 0), challenge = await h.challenge();
  const started = await h.post('/v1/backup/start', { deviceId: h.deviceId, challenge, signature: h.signature({ deviceId: h.deviceId, challenge, action: 'backup', name, kind: 'Full', files: files.length, bytes }), name, kind: 'Full', mode, files: files.map(f => ({ path: f.path, bytes: f.data.length })) });
  const chunk = (index, offset, data) => fetch(`${h.base}/v1/backup/chunk`, { method: 'POST', body: data, headers: { 'X-Transfer-Id': started.transferId, 'X-Transfer-Token': started.token, 'X-File-Index': String(index), 'X-Offset': String(offset), 'X-Sha256': sha(data), 'Content-Type': 'application/octet-stream' } });
  return { started, chunk, finish: () => h.post('/v1/backup/finish', { transferId: started.transferId, token: started.token }) };
}
const name = `Full_Bckup_${today()}`;
const A = { path: 'DCIM/a.jpg', data: Buffer.from('aaaaaa') }, B = { path: 'Docs/b.txt', data: Buffer.from('bbbb') }, E = { path: 'empty.bin', data: Buffer.alloc(0) };

test('with staging, the phone is finished once files reach the PC; the drive copy is verified and the staged copy removed', async () => {
  const h = await harness({ rootExternal: true, stagingAnyDisk: true });
  try {
    h.select(); await h.pair();
    const t = await backup(h, { name, files: [A, B, E] });
    // Chunks land in the staging folder, not on the drive.
    assert.equal((await t.chunk(0, 0, A.data)).status, 200);
    const staged = path.join(h.dir, 'staging', t.started.transferId, 'data', 'DCIM', 'a.jpg');
    assert.equal(await fs.readFile(staged, 'utf8'), 'aaaaaa');
    assert.equal((await t.chunk(1, 0, B.data)).status, 200); assert.equal((await t.chunk(2, 0, E.data)).status, 200);
    const done = await t.finish();
    assert.equal(done.state, 'complete'); assert.equal(done.staged, true);
    await h.wait(e => e.type === 'sync_completed');
    const find = async dir => { for (const e of await fs.readdir(dir, { withFileTypes: true })) { if (!e.isDirectory()) continue; const p = path.join(dir, e.name); if (e.name === name) return p; const r = await find(p); if (r) return r; } return null; };
    const folder = await find(h.root); assert.ok(folder, 'backup folder on the drive');
    assert.equal(await fs.readFile(path.join(folder, 'DCIM', 'a.jpg'), 'utf8'), 'aaaaaa');
    assert.equal(await fs.readFile(path.join(folder, 'Docs', 'b.txt'), 'utf8'), 'bbbb');
    assert.equal(JSON.parse(await fs.readFile(path.join(folder, '.homesafe-backup.json'), 'utf8')).complete, true);
    await assert.rejects(fs.stat(path.join(h.dir, 'staging', t.started.transferId)));
  } finally { await h.close(); }
});

test('speed test: data is discarded and the Vault reports drive and staging write speeds', async () => {
  const h = await harness({ rootExternal: true, stagingAnyDisk: true });
  try {
    h.select(); await h.pair();
    const challenge = await h.challenge();
    const { token } = await h.post('/v1/speedtest/start', { deviceId: h.deviceId, challenge, signature: h.signature({ deviceId: h.deviceId, challenge, action: 'speedtest' }) });
    const r = await fetch(`${h.base}/v1/speedtest/chunk`, { method: 'POST', body: Buffer.alloc(1024 * 1024, 7), headers: { 'X-Speedtest-Token': token, 'Content-Type': 'application/octet-stream' } });
    assert.equal(r.status, 200); assert.equal((await r.json()).received, 1024 * 1024);
    const out = await h.post('/v1/speedtest/finish', { token });
    assert.ok(out.driveBytesPerSecond > 0); assert.ok(out.stagingBytesPerSecond > 0); assert.equal(out.staging, true);
    assert.deepEqual((await fs.readdir(h.root)).filter(n => n.startsWith('.homesafe-speedtest')), []);
    assert.notEqual((await h.call('/v1/speedtest/finish', { token })).status, 200);
  } finally { await h.close(); }
});

const startPlain = async (h, files, mode = 'staged') => {
  const bytes = files.reduce((n, f) => n + f.data.length, 0), challenge = await h.challenge();
  return h.call('/v1/backup/start', { deviceId: h.deviceId, challenge, signature: h.signature({ deviceId: h.deviceId, challenge, action: 'backup', name, kind: 'Full', files: files.length, bytes }), name, kind: 'Full', ...(mode ? { mode } : {}), files: files.map(f => ({ path: f.path, bytes: f.data.length })) });
};
const adminSend = (h, msg) => h.ws.send(JSON.stringify(msg));

test('default staging folder without room for the backup plus 2 GB: the owner is asked for a HomeSafeTemp folder, nothing is created on the drive, and the choice is used', async () => {
  const GB = 1024 ** 3, roomy = { v: false };
  const h = await harness({ rootExternal: true, stagingAnyDisk: true, stagingFreeBytes: async dir => (roomy.v && dir.includes('HomeSafeTemp') ? 500 * GB : 2 * GB + 5) });
  try {
    h.select(); await h.pair();
    // 11 bytes + 2 GB needed, 2 GB + 5 free: refused.
    const refused = await startPlain(h, [A, B]);
    assert.equal(refused.status, 507); assert.equal(refused.body.code, 'staging_space');
    const asked = await h.wait(e => e.type === 'staging_needed'); assert.equal(asked.needBytes, 10 + 2 * GB);
    // No empty backup folder was left on the drive by the refused start.
    const hasBackupFolder = async dir => { for (const e of await fs.readdir(dir, { withFileTypes: true })) { if (!e.isDirectory()) continue; if (e.name === name) return true; if (await hasBackupFolder(path.join(dir, e.name))) return true; } return false; };
    assert.equal(await hasBackupFolder(h.root), false);
    // A folder with the wrong name, or without room, is refused with a reason.
    const wrong = path.join(h.dir, 'Elsewhere'); await fs.mkdir(wrong);
    adminSend(h, { type: 'set_staging', path: wrong }); assert.match((await h.wait(e => e.type === 'service_error')).reason, /HomeSafeTemp/);
    const temp = path.join(h.dir, 'big', 'HomeSafeTemp'); await fs.mkdir(temp, { recursive: true });
    h.events.length = 0; adminSend(h, { type: 'set_staging', path: temp }); assert.match((await h.wait(e => e.type === 'service_error')).reason, /needs .* GB/);
    roomy.v = true; h.events.length = 0; adminSend(h, { type: 'set_staging', path: temp }); await h.wait(e => e.type === 'staging_ready');
    // Same backup now goes through, received into the HomeSafeTemp folder.
    const t = await backup(h, { name, files: [A, B] });
    const staged = path.join(await fs.realpath(temp), t.started.transferId, 'data');
    assert.equal((await t.chunk(0, 0, A.data)).status, 200); assert.equal(await fs.readFile(path.join(staged, 'DCIM', 'a.jpg'), 'utf8'), 'aaaaaa');
    assert.equal((await t.chunk(1, 0, B.data)).status, 200); assert.equal((await t.finish()).staged, true);
    await h.wait(e => e.type === 'sync_completed');
    await assert.rejects(fs.stat(path.join(await fs.realpath(temp), t.started.transferId)));
  } finally { await h.close(); }
});

test('the owner chooses per backup: direct goes straight to the drive, staged is refused unless the drive is external, and the phone can check readiness first', async () => {
  const GB = 1024 ** 3;
  const h = await harness({ rootExternal: true, stagingAnyDisk: true, stagingFreeBytes: async () => 2 * GB + 5 });
  try {
    h.select(); await h.pair();
    // The phone asks before starting: external drive, and staging is not ready because the default folder lacks room.
    const status = await h.post('/v1/status', { bytes: 1000, ask: true });
    assert.equal(status.external, true); assert.equal(status.staging.available, true); assert.equal(status.staging.ready, false); assert.equal(status.staging.needBytes, 1000 + 2 * GB);
    assert.equal((await h.wait(e => e.type === 'staging_needed')).needBytes, 1000 + 2 * GB);
    assert.equal((await h.post('/v1/status', { bytes: 5 })).staging.ready, true);
    // Option 2 (direct) works even though staging is not ready: no staging folder is touched and the phone waits for the drive.
    const t = await backup(h, { name, files: [A] }, 'direct');
    assert.equal((await t.chunk(0, 0, A.data)).status, 200);
    assert.equal((await t.finish()).staged, undefined);
    await assert.rejects(fs.stat(path.join(h.dir, 'staging', t.started.transferId)));
  } finally { await h.close(); }
  const plain = await harness({ stagingAnyDisk: true });
  try {
    plain.select(); await plain.pair();
    const status = await plain.post('/v1/status', {});
    assert.equal(status.external, false); assert.equal(status.staging, undefined);
    const refused = await startPlain(plain, [A], 'staged'); assert.equal(refused.body.code, 'staging_unavailable');
    assert.equal((await startPlain(plain, [A], 'bogus')).status, 400);
  } finally { await plain.close(); }
});
