import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonical, MANIFEST_PAGE_LIMIT, MANIFEST_TOTAL_LIMIT, ERROR_MESSAGES } from '../src/native-protocol.mjs';
import { harness, today } from './helpers.mjs';
const vectors = JSON.parse(readFileSync(new URL('../protocol/test-vectors.json', import.meta.url), 'utf8')).vectors;
for (const v of vectors) test(`canonical JSON vector: ${v.name}`, () => assert.equal(canonical(v.input), v.canonical));
test('code-point order differs from UTF-16 order for astral keys', () => assert.equal(canonical({ '😀': 1, '｡': 2 }), '{"｡":2,"😀":1}'));
test('manifest limits are 5,000 per page and 500,000 per backup', () => { assert.equal(MANIFEST_PAGE_LIMIT, 5000); assert.equal(MANIFEST_TOTAL_LIMIT, 500000); });
test('the nine phone error codes exist', () => { for (const c of ['code_expired', 'wrong_account', 'phone_revoked', 'drive_unavailable', 'name_exists', 'no_space', 'transfer_active', 'too_many_files', 'rate_limited']) assert.ok(ERROR_MESSAGES[c]); });

test('error codes: wrong account, expired code, too many files, name exists, transfer active, revoked', async () => {
  const h = await harness();
  try {
    h.select();
    const code = (await h.wait(e => e.type === 'pairing_code')).code;
    const wrong = { email: 'someone@else.com', code, deviceId: h.deviceId, publicKey: 'x' };
    const r1 = await h.call('/v1/pair/begin', { ...wrong, signature: 'x' }); assert.equal(r1.body.code, 'wrong_account'); assert.equal(JSON.stringify(r1.body).includes('someone'), false);
    const r2 = await h.call('/v1/pair/begin', { email: 'owner@example.com', code: code === '000000' ? '111111' : '000000', deviceId: h.deviceId, publicKey: 'x', signature: 'x' }); assert.equal(r2.body.code, 'code_expired');
    await h.pair();
    const name = 'Custom_Bckup_' + today(), many = Array.from({ length: MANIFEST_PAGE_LIMIT + 1 }, (_, i) => ({ path: `f${i}`, bytes: 0 }));
    let c = await h.challenge();
    const big = await h.call('/v1/backup/start', { deviceId: h.deviceId, challenge: c, name, kind: 'Custom', files: many, signature: 'x' }); assert.equal(big.body.code, 'too_many_files');
    c = await h.challenge();
    const files = [{ path: 'a.txt', bytes: 1 }];
    const started = await h.post('/v1/backup/start', { deviceId: h.deviceId, challenge: c, name, kind: 'Custom', files, signature: h.signature({ deviceId: h.deviceId, challenge: c, action: 'backup', name, kind: 'Custom', files: 1, bytes: 1 }) });
    c = await h.challenge();
    const busy = await h.call('/v1/backup/start', { deviceId: h.deviceId, challenge: c, name: name + '_2', kind: 'Custom', files, signature: h.signature({ deviceId: h.deviceId, challenge: c, action: 'backup', name: name + '_2', kind: 'Custom', files: 1, bytes: 1 }) });
    assert.equal(busy.status, 409); assert.equal(busy.body.code, 'transfer_active');
    const data = Buffer.from('z');
    await fetch(h.base + '/v1/backup/chunk', { method: 'POST', headers: { 'X-Transfer-Id': started.transferId, 'X-Transfer-Token': started.token, 'X-File-Index': '0', 'X-Offset': '0', 'X-Sha256': createHash('sha256').update(data).digest('hex') }, body: data });
    await h.post('/v1/backup/finish', { transferId: started.transferId, token: started.token });
    c = await h.challenge();
    const dup = await h.call('/v1/backup/start', { deviceId: h.deviceId, challenge: c, name, kind: 'Custom', files, signature: h.signature({ deviceId: h.deviceId, challenge: c, action: 'backup', name, kind: 'Custom', files: 1, bytes: 1 }) });
    assert.equal(dup.body.code, 'name_exists'); assert.equal(JSON.stringify(dup.body).includes(name), false);
    h.ws.send(JSON.stringify({ type: 'revoke_phone', profile: 'Owner', phone: 'Pixel' })); await h.wait(e => e.type === 'phone_revoked');
    assert.equal(JSON.parse(await fs.readFile(path.join(h.dir, 'phones.json')))[0].revoked, true);
    const revoked = await h.call('/v1/device/challenge', { deviceId: h.deviceId }); assert.equal(revoked.body.code, 'phone_revoked');
    const log = await fs.readFile(path.join(h.dir, 'events.jsonl'), 'utf8'); assert.equal(log.includes('Owner'), false); assert.equal(log.includes('owner@example.com'), false);
  } finally { await h.close(); }
});

test('rate limit after five pairing attempts per minute', async () => {
  const h = await harness();
  try { h.select(); await h.wait(e => e.type === 'pairing_code'); let last; for (let i = 0; i < 6; i++) last = await h.call('/v1/pair/begin', { email: 'owner@example.com', code: 'nope', deviceId: h.deviceId, publicKey: 'x', signature: 'x' }); assert.equal(last.status, 429); assert.equal(last.body.code, 'rate_limited'); }
  finally { await h.close(); }
});

const pagedStart = async (h, name, fileCount, bytes) => { const c = await h.challenge(); return h.post('/v1/backup/start', { deviceId: h.deviceId, challenge: c, name, kind: 'Full', files: [], fileCount, bytes, signature: h.signature({ deviceId: h.deviceId, challenge: c, action: 'backup', name, kind: 'Full', files: fileCount, bytes }) }); };
const sendChunk = (h, s, index, text) => { const b = Buffer.from(text); return fetch(h.base + '/v1/backup/chunk', { method: 'POST', headers: { 'X-Transfer-Id': s.transferId, 'X-Transfer-Token': s.token, 'X-File-Index': String(index), 'X-Offset': '0', 'X-Sha256': createHash('sha256').update(b).digest('hex') }, body: b }); };
const page = (h, s, offset, files) => h.call('/v1/backup/files', { transferId: s.transferId, token: s.token, offset, files });

test('paged manifest: files [] with fileCount, offset-ordered pages, chunks only once complete', async () => {
  const h = await harness();
  try {
    h.select(); await h.pair();
    const name = 'Full_Bckup_' + today(), s = await pagedStart(h, name, 2, 6);
    assert.equal(s.manifestComplete, false);
    const early = await sendChunk(h, s, 0, 'one'); assert.equal(early.status, 400); assert.equal((await early.json()).code, 'too_many_files');
    assert.deepEqual((await page(h, s, 0, [{ path: 'one.txt', bytes: 3 }])).body, { received: 1, manifestComplete: false });
    assert.equal((await page(h, s, 1, [{ path: 'ONE.txt', bytes: 3 }])).status, 400);
    assert.deepEqual((await page(h, s, 1, [{ path: 'two.txt', bytes: 3 }])).body, { received: 2, manifestComplete: true });
    assert.equal((await sendChunk(h, s, 0, 'one')).status, 200); assert.equal((await sendChunk(h, s, 1, 'two')).status, 200);
    assert.equal((await page(h, s, 2, [{ path: 'three.txt', bytes: 0 }])).status, 400);
    assert.equal((await h.post('/v1/backup/finish', { transferId: s.transferId, token: s.token })).state, 'complete');
    assert.equal(await fs.readFile(path.join(h.root, 'Owner', 'Pixel', name, 'two.txt'), 'utf8'), 'two');
  } finally { await h.close(); }
});

test('paged manifest: out-of-order offsets (gaps and repeats) are rejected', async () => {
  const h = await harness();
  try {
    h.select(); await h.pair();
    const s = await pagedStart(h, 'Full_Bckup_' + today(), 3, 3);
    assert.equal((await page(h, s, 1, [{ path: 'a', bytes: 1 }])).body.code, 'invalid_request');
    assert.equal((await page(h, s, 0, [{ path: 'a', bytes: 1 }])).status, 200);
    assert.equal((await page(h, s, 0, [{ path: 'b', bytes: 1 }])).body.code, 'invalid_request');
    assert.equal((await page(h, s, 2, [{ path: 'b', bytes: 1 }])).body.code, 'invalid_request');
  } finally { await h.close(); }
});

test('paged manifest: overflow beyond fileCount and fileCount above 500,000 are rejected', async () => {
  const h = await harness();
  try {
    h.select(); await h.pair();
    const name = 'Full_Bckup_' + today(), c = await h.challenge();
    const huge = await h.call('/v1/backup/start', { deviceId: h.deviceId, challenge: c, name, kind: 'Full', files: [], fileCount: MANIFEST_TOTAL_LIMIT + 1, bytes: 0, signature: 'x' }); assert.equal(huge.body.code, 'too_many_files');
    const c2 = await h.challenge();
    const both = await h.call('/v1/backup/start', { deviceId: h.deviceId, challenge: c2, name, kind: 'Full', files: [{ path: 'a', bytes: 1 }], fileCount: 1, bytes: 1, signature: 'x' }); assert.equal(both.body.code, 'invalid_request');
    const s = await pagedStart(h, name, 1, 2);
    assert.equal((await page(h, s, 0, [{ path: 'a', bytes: 1 }, { path: 'b', bytes: 1 }])).body.code, 'too_many_files');
  } finally { await h.close(); }
});

test('paged manifest: byte sum must equal signed bytes', async () => {
  const h = await harness();
  try {
    h.select(); await h.pair();
    const s = await pagedStart(h, 'Full_Bckup_' + today(), 2, 10);
    assert.equal((await page(h, s, 0, [{ path: 'a', bytes: 11 }])).body.code, 'invalid_request');
    assert.equal((await page(h, s, 0, [{ path: 'a', bytes: 4 }])).status, 200);
    assert.equal((await page(h, s, 1, [{ path: 'b', bytes: 5 }])).body.code, 'invalid_request');
    assert.equal((await sendChunk(h, s, 0, 'abcd')).status, 400);
  } finally { await h.close(); }
});

test('legacy API is gone', async () => {
  const h = await harness();
  try { for (const p of ['/v1/challenge', '/v1/pair']) assert.equal((await h.call(p, {})).body.code, 'invalid_request'); const r = await fetch(h.base + '/v1/backups/abc/complete', { method: 'POST', headers: { Authorization: 'Bearer x' } }); assert.equal((await r.json()).code, 'invalid_request'); }
  finally { await h.close(); }
});
