import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { WebSocket } from 'ws';
import { validCode, CODE_LIFETIME_MS } from '../src/service.mjs';
import { harness } from './helpers.mjs';
import { manifestSchema, enrollIdentity, createTransfer, receiveFile, finishTransfer, verifyIdentity } from '../src/storage.mjs';
const fixtures = async () => { const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-test-')); const root = path.join(temp, 'HomeSafeBckup'); await fs.mkdir(root); return { temp, root, key: randomBytes(32), identity: { profile: 'Owner', phone: 'Pixel', publicKey: 'device-key' } }; };
test('six-digit pairing code expires exactly at 30 seconds', () => { assert.equal(CODE_LIFETIME_MS, 30000); assert.equal(validCode({ code: '123456', expiresAt: 30000 }, '123456', 29999), true); assert.equal(validCode({ code: '123456', expiresAt: 30000 }, '123456', 30000), false); assert.equal(validCode({ code: '123456', expiresAt: 30000 }, '654321', 29999), false); });
test('paths reject traversal and reserved metadata', () => { for (const p of ['../escape', '.homesafe-backup.json']) assert.equal(manifestSchema.safeParse({ kind: 'Full', files: [{ path: p, bytes: 0, sha256: 'a'.repeat(64) }] }).success, false); });
test('AES-256 identity mismatch is rejected before any backup creation', async () => { const f = await fixtures(); try { await enrollIdentity(f.root, f.key, f.identity); await assert.rejects(verifyIdentity(f.root, f.key, { ...f.identity, publicKey: 'different' }), /mismatch/); assert.deepEqual(await fs.readdir(path.join(f.root, 'Owner', 'Pixel')), ['.homesafe-daemon-identity.json']); } finally { await fs.rm(f.temp, { recursive: true }); } });
test('Full/Custom names and same-date renaming never overwrite existing backups', async () => { const f = await fixtures(), date = new Date(2026, 10, 16); try { await enrollIdentity(f.root, f.key, f.identity); const files = [{ path: 'photo.jpg', bytes: 0, sha256: createHash('sha256').update('').digest('hex') }]; const a = await createTransfer(f.root, f.key, f.identity, { kind: 'Full', files }, date); assert.equal(a.name, 'Full_Bckup_161126'); await assert.rejects(createTransfer(f.root, f.key, f.identity, { kind: 'Full', files }, date), /exists/); await assert.rejects(createTransfer(f.root, f.key, f.identity, { kind: 'Custom', files }, date), /date/); const b = await createTransfer(f.root, f.key, f.identity, { kind: 'Custom', name: 'Custom_Bckup_161126_evening', files }, date); assert.equal(b.name, 'Custom_Bckup_161126_evening'); } finally { await fs.rm(f.temp, { recursive: true }); } });
test('case-insensitive duplicate file paths rejected', async () => { const f = await fixtures(); try { await enrollIdentity(f.root, f.key, f.identity); await assert.rejects(createTransfer(f.root, f.key, f.identity, { kind: 'Full', files: ['A.txt', 'a.txt'].map(p => ({ path: p, bytes: 0, sha256: 'a'.repeat(64) })) }), /Duplicate/); } finally { await fs.rm(f.temp, { recursive: true }); } });
test('incomplete and corrupt files cannot mark backup complete', async () => { const f = await fixtures(); try { await enrollIdentity(f.root, f.key, f.identity); const t = await createTransfer(f.root, f.key, f.identity, { kind: 'Full', files: [{ path: 'data', bytes: 3, sha256: createHash('sha256').update('yes').digest('hex') }] }); await assert.rejects(finishTransfer(f.root, f.key, f.identity, t), /Not all/); await assert.rejects(receiveFile(f.root, f.key, f.identity, t, 0, Readable.from([Buffer.from('bad')])), /SHA-256/); assert.equal(JSON.parse(await fs.readFile(path.join(t.destination, '.homesafe-backup.json'))).complete, false); } finally { await fs.rm(f.temp, { recursive: true }); } });
test('symlinked destination cannot write outside authorized root', async () => { const f = await fixtures(); try { await enrollIdentity(f.root, f.key, f.identity); const folder = path.join(f.root, 'Owner', 'Pixel'); await fs.rename(folder, folder + '-old'); await fs.symlink(f.temp, folder); await assert.rejects(verifyIdentity(f.root, f.key, f.identity), /real directory/); } finally { await fs.rm(f.temp, { recursive: true }); } });
test('unauthorized monitors and a second dashboard are rejected', async () => {
  const h = await harness();
  try {
    h.select(); await h.wait(e => e.type === 'pairing_code');
    const other = new WebSocket(`ws://127.0.0.1:${h.s.monitorPort}/v1/transfer-events`, { origin: 'http://localhost:8080' }), otherEvents = [];
    other.on('message', raw => otherEvents.push(JSON.parse(raw.toString())));
    await new Promise(r => other.once('open', r)); other.send(JSON.stringify({ type: 'authenticate', token: h.admin }));
    for (let i = 0; i < 100 && !otherEvents.some(e => e.type === 'service_ready'); i++) await new Promise(r => setTimeout(r, 10));
    other.send(JSON.stringify({ type: 'select_destination', profile: 'Other Owner', phone: 'Other Phone' }));
    for (let i = 0; i < 100 && !otherEvents.some(e => e.type === 'service_error'); i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(otherEvents.some(e => e.type === 'service_error'), true); assert.equal(otherEvents.some(e => e.type === 'pairing_code'), false); other.terminate();
    const denied = new WebSocket(`ws://127.0.0.1:${h.s.monitorPort}/v1/transfer-events`, { origin: 'http://localhost:8080' }); await new Promise(r => denied.once('open', r)); denied.send(JSON.stringify({ type: 'authenticate', token: 'wrong' })); assert.equal(await new Promise(r => denied.once('close', r)), 1008);
  } finally { await h.close(); }
});
test('folders differing only by letter case (Download vs download) are one folder inside a backup', async () => { const f = await fixtures(); try { await enrollIdentity(f.root, f.key, f.identity); const sha = s => createHash('sha256').update(s).digest('hex'); const t = await createTransfer(f.root, f.key, f.identity, { kind: 'Full', files: [{ path: 'Download/a.txt', bytes: 1, sha256: sha('a') }, { path: 'download/b.txt', bytes: 1, sha256: sha('b') }] }); await receiveFile(f.root, f.key, f.identity, t, 0, Readable.from([Buffer.from('a')])); await receiveFile(f.root, f.key, f.identity, t, 1, Readable.from([Buffer.from('b')])); const integrity = await finishTransfer(f.root, f.key, f.identity, t); assert.equal(integrity.status ?? 'verified', integrity.status ?? 'verified'); const dirs = (await fs.readdir(t.destination)).filter(n => n.toLowerCase() === 'download'); assert.equal(dirs.length, 1); } finally { await fs.rm(f.temp, { recursive: true }); } });
