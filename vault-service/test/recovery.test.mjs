import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { enrollIdentity, adoptOrphanIdentity, verifyIdentity } from '../src/storage.mjs';
import { speedOf } from '../src/native-protocol.mjs';

test('a reinstalled Vault (new key) can re-pair a phone folder, keeping the old seals', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hs-')); const id = { email: 'a@b.test', profile: 'Owner', phone: 'Pixel', deviceId: 'd'.repeat(20), publicKey: 'k' };
  const oldKey = randomBytes(32), newKey = randomBytes(32);
  await enrollIdentity(root, oldKey, id);
  await assert.rejects(() => verifyIdentity(root, newKey, id));
  await adoptOrphanIdentity(root, newKey, id);
  await verifyIdentity(root, newKey, id);
  const names = await fs.readdir(path.join(root, 'Owner', 'Pixel'));
  assert.ok(names.some(n => n.startsWith('.homesafe-daemon-identity.replaced-')));
  await adoptOrphanIdentity(root, newKey, id); // re-pairing a readable folder works too; the older seals are kept as .replaced files
  assert.ok((await fs.readdir(path.join(root, 'Owner', 'Pixel'))).filter(n => n.includes('.replaced-')).length >= 1);
});
test('speed is bytes per second over a short window', () => {
  const t = { receivedBytes: 0 }; speedOf(t, 1000); t.receivedBytes = 8_000_000;
  assert.equal(speedOf(t, 2000), 8_000_000);
});

import { harness } from './helpers.mjs';
import { RECOVERY_FILE, readRecovery, openVault } from '../src/recovery.mjs';
test('recovery file lists phones without secrets, and the passphrase-protected vault block opens only with the right passphrase', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-')), cert = path.join(dir, 'c.pem'), key = path.join(dir, 'k.pem');
  await fs.writeFile(cert, 'CERT-PEM'); await fs.writeFile(key, 'KEY-PEM');
  const h = await harness({ cert, key });
  try {
    h.select(); await h.pair();
    let rec = await readRecovery(h.root);
    assert.equal(rec.phones.length, 1); assert.equal(rec.phones[0].profile, 'Owner'); assert.equal(rec.phones[0].email, 'owner@example.com');
    assert.ok(!JSON.stringify(rec).includes('identityKey'));
    h.ws.send(JSON.stringify({ type: 'set_recovery_passphrase', passphrase: 'short' }));
    assert.match((await h.wait(e => e.type === 'service_error')).reason, /at least 12/);
    h.ws.send(JSON.stringify({ type: 'set_recovery_passphrase', passphrase: 'correct horse battery staple' }));
    assert.equal((await h.wait(e => e.type === 'recovery_status' && e.fullEnabled)).phones, 1);
    rec = await readRecovery(h.root);
    assert.deepEqual({ ...openVault(rec.vault, 'correct horse battery staple') }.cert, 'CERT-PEM');
    assert.throws(() => openVault(rec.vault, 'wrong passphrase here'));
    assert.ok((await fs.readFile(path.join(h.root, RECOVERY_FILE), 'utf8')).includes('"vault"'));
  } finally { await h.close(); await fs.rm(dir, { recursive: true }); }
});
