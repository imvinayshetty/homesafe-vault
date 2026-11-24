import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { harness, today } from './helpers.mjs';

test('completed backup is verified, history tracks paging and bytes, and a recheck reports mismatches', async () => {
  const h = await harness();
  try {
    h.select(); await h.pair();
    const name = 'Full_Bckup_' + today(), c = await h.challenge();
    const s = await h.post('/v1/backup/start', { deviceId: h.deviceId, challenge: c, name, kind: 'Full', files: [], fileCount: 2, bytes: 6, signature: h.signature({ deviceId: h.deviceId, challenge: c, action: 'backup', name, kind: 'Full', files: 2, bytes: 6 }) });
    await h.call('/v1/backup/files', { transferId: s.transferId, token: s.token, offset: 0, files: [{ path: 'a.txt', bytes: 3 }] });
    let row = (await h.wait(e => e.type === 'transfer_history' && e.backups[0]?.manifestReceived === 1)).backups[0];
    assert.equal(row.status, 'receiving_manifest'); assert.equal(row.totalFiles, 2); assert.equal('email' in row, false);
    await h.call('/v1/backup/files', { transferId: s.transferId, token: s.token, offset: 1, files: [{ path: 'b.txt', bytes: 3 }] });
    for (const [i, t] of [[0, 'abc'], [1, 'def']]) { const b = Buffer.from(t); await fetch(h.base + '/v1/backup/chunk', { method: 'POST', headers: { 'X-Transfer-Id': s.transferId, 'X-Transfer-Token': s.token, 'X-File-Index': String(i), 'X-Offset': '0', 'X-Sha256': createHash('sha256').update(b).digest('hex') }, body: b }); }
    await h.post('/v1/backup/finish', { transferId: s.transferId, token: s.token });
    row = (await h.wait(e => e.type === 'transfer_history' && e.backups[0]?.status === 'completed')).backups[0];
    assert.equal(row.receivedBytes, 6); assert.equal(row.integrity.status, 'verified'); assert.equal(row.integrity.checkedFiles, 2);
    assert.ok(h.events.some(e => e.type === 'transfer_verifying'));
    await fs.writeFile(path.join(h.root, 'Owner', 'Pixel', name, 'b.txt'), 'XYZ');
    await fs.rm(path.join(h.root, 'Owner', 'Pixel', name, 'a.txt'));
    h.ws.send(JSON.stringify({ type: 'verify_backup', id: row.id }));
    row = (await h.wait(e => e.type === 'transfer_history' && e.backups[0]?.integrity.status === 'mismatch')).backups[0];
    assert.equal(row.integrity.mismatchCount, 2); assert.equal(row.status, 'failed'); assert.equal(row.failureCode, 'integrity_mismatch');
    assert.deepEqual(row.integrity.issues.map(i => [i.path, i.reason]), [['a.txt', 'missing'], ['b.txt', 'checksum']]);
    const log = await fs.readFile(path.join(h.dir, 'events.jsonl'), 'utf8'); assert.equal(log.includes('b.txt'), false);
  } finally { await h.close(); }
});