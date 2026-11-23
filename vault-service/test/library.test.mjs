import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildLibrary } from '../src/library.mjs';

test('an account sees its own phones and backups, and only names of other profiles', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-'));
  await fs.mkdir(path.join(root, 'Vinay', 'Pixel', 'Full_Bckup_231125'), { recursive: true });
  await fs.writeFile(path.join(root, 'Vinay', 'Pixel', 'Full_Bckup_231125', '.homesafe-backup.json'), JSON.stringify({ complete: true, date: '231125', bytes: 9, entries: [{ path: 'a', bytes: 9 }] }));
  await fs.mkdir(path.join(root, 'Asha', 'iPhone', 'Full_Bckup_010125'), { recursive: true });
  const records = [{ email: 'v@x.test', profile: 'Vinay', phone: 'Pixel' }, { email: 'a@x.test', profile: 'Asha', phone: 'iPhone' }];
  const mine = await buildLibrary({ root, records, email: 'v@x.test', profile: 'Vinay' });
  assert.deepEqual(mine.yourProfiles, ['Vinay']); assert.deepEqual(mine.otherProfiles, ['Asha']);
  assert.equal(mine.phones[0].phone, 'Pixel'); assert.deepEqual(mine.phones[0].backups[0], { name: 'Full_Bckup_231125', kind: 'Full', date: '2025-11-23', complete: true, files: 1, bytes: 9 });
  const peek = await buildLibrary({ root, records, email: 'v@x.test', profile: 'Asha' });
  assert.equal(peek.owned, false); assert.deepEqual(peek.phones, []); assert.ok(!JSON.stringify(peek).includes('iPhone'));
  const first = await buildLibrary({ root, records: [], email: 'new@x.test' });
  assert.deepEqual(first.yourProfiles, []); assert.deepEqual(first.otherProfiles, ['Asha', 'Vinay']);
});
