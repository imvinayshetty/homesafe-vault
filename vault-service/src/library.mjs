import { promises as fs } from 'node:fs';
import path from 'node:path';

const dirs = async dir => (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/**
 * What one signed-in account may see: its own profiles, the phones and past backups under the requested profile, and only the
 * NAMES of other profiles. A profile that another account has paired phones in is never opened for this one.
 */
export async function buildLibrary({ root, records, email, profile }) {
  const mine = [...new Set(records.filter(r => r.email === email).map(r => r.profile))];
  const owner = name => records.find(r => same(r.profile, name))?.email;
  const onDrive = await dirs(root);
  const everyone = [...new Set([...onDrive, ...records.map(r => r.profile)])];
  const otherProfiles = everyone.filter(n => !mine.some(m => same(m, n)) && !(profile && same(profile, n) && (owner(n) === undefined || owner(n) === email))).sort((a, b) => a.localeCompare(b));
  const out = { type: 'library', profile: profile ?? null, yourProfiles: mine, otherProfiles, owned: false, phones: [] };
  if (!profile) return out;
  const o = owner(profile);
  if (o !== undefined && o !== email) return { ...out, profile: null };
  out.owned = true;
  const profileDir = (await dirs(root)).find(n => same(n, profile));
  if (!profileDir) return out;
  for (const phone of await dirs(path.join(root, profileDir))) {
    const record = records.find(r => same(r.profile, profile) && same(r.phone, phone));
    const backups = [];
    for (const name of await dirs(path.join(root, profileDir, phone))) {
      if (!/^(Full|Custom)_Bckup_/.test(name)) continue;
      const m = await fs.readFile(path.join(root, profileDir, phone, name, '.homesafe-backup.json'), 'utf8').then(JSON.parse).catch(() => null);
      const d = typeof m?.date === 'string' && /^\d{6}$/.test(m.date) ? `20${m.date.slice(4, 6)}-${m.date.slice(2, 4)}-${m.date.slice(0, 2)}` : '';
      backups.push({ name, kind: name.startsWith('Full') ? 'Full' : 'Custom', date: d, complete: m?.complete === true, files: Array.isArray(m?.entries) ? m.entries.length : 0, bytes: Number.isFinite(m?.bytes) ? m.bytes : 0 });
    }
    backups.sort((a, b) => b.date.localeCompare(a.date) || b.name.localeCompare(a.name));
    out.phones.push({ phone, revoked: record?.revoked === true, backups: backups.slice(0, 100) });
  }
  out.phones.sort((a, b) => a.phone.localeCompare(b.phone));
  return out;
}
