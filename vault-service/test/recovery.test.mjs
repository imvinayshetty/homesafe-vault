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
