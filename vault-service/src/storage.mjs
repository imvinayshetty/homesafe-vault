import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';

export const segment = z.string().min(1).max(80).refine(s => s === s.trim() && !/[\\/<>:"|?*\x00-\x1f]/.test(s) && !/[. ]$/.test(s) && !/^(\.|\.\.|con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(s), 'Invalid folder name');
export const filePath = z.string().max(1024).refine(s => s.split('/').every(p => segment.safeParse(p).success && !p.startsWith('.homesafe')), 'Invalid file path');
const manifestFiles = z.array(z.object({ path: filePath, bytes: z.number().int().nonnegative().max(1024 ** 4), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).max(10000);
export const manifestSchema = z.object({ kind: z.enum(['Full', 'Custom']), name: segment.optional(), files: manifestFiles.min(1) });
const pagedManifestSchema = manifestSchema.extend({ files: manifestFiles.length(0) });
export function dateCode(d = new Date()) { return [d.getDate(), d.getMonth() + 1, d.getFullYear() % 100].map(v => String(v).padStart(2, '0')).join(''); }
// `sameFolderIgnoringCase` is for folders INSIDE a backup (DCIM vs dcim, Download vs download): phones can hold both
// spellings, but drives are usually case-insensitive, so they are one folder here. Identity, profile, phone and backup
// folders stay strict.
export async function directory(parent, name, create = false, sameFolderIgnoringCase = false) {
  segment.parse(name);
  const names = await fs.readdir(parent);
  const collision = names.find(n => n.toLowerCase() === name.toLowerCase());
  if (collision && collision !== name && !sameFolderIgnoringCase) throw new Error('Folder spelling collision');
  if (collision && sameFolderIgnoringCase) name = collision;
  const target = path.join(parent, name);
  if (!collision && create) await fs.mkdir(target, { mode: 0o700 });
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Storage folder is not a real directory');
  return target;
}
export async function phoneFolder(root, profile, phone, create = false) { return directory(await directory(root, profile, create), phone, create); }
export function seal(key, identity) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${identity.profile}/${identity.phone}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(identity)), cipher.final()]);
  return { version: 1, algorithm: 'AES-256-GCM', iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
export async function verifyIdentity(root, key, identity) {
  const folder = await phoneFolder(root, identity.profile, identity.phone);
  const handle = await fs.open(path.join(folder, '.homesafe-daemon-identity.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const value = JSON.parse(await handle.readFile('utf8'));
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
    decipher.setAAD(Buffer.from(`${identity.profile}/${identity.phone}`)); decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    const plain = JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString());
    if (JSON.stringify(plain) !== JSON.stringify(identity)) throw new Error('Phone identity mismatch');
    return folder;
  } finally { await handle.close(); }
}
export async function enrollIdentity(root, key, identity) {
  const profileFolder = await directory(root, identity.profile, true);
  if ((await fs.readdir(profileFolder)).some(n => n.toLowerCase() === identity.phone.toLowerCase())) throw new Error('Phone folder already exists; it will not be replaced');
  const folder = await directory(profileFolder, identity.phone, true);
  await fs.writeFile(path.join(folder, '.homesafe-daemon-identity.json'), JSON.stringify(seal(key, identity)), { flag: 'wx', mode: 0o600 });
}
export async function createTransfer(root, key, identity, input, now = new Date()) {
  const manifest = (input.paged ? pagedManifestSchema : manifestSchema).parse(input), date = dateCode(now), base = `${manifest.kind}_Bckup_${date}`, name = manifest.name ?? base;
  if (name !== base && !name.startsWith(`${base}_`)) throw new Error(`Keep ${base} at the start of the backup name`);
  const unique = new Set(manifest.files.map(f => f.path.toLowerCase()));
  if (unique.size !== manifest.files.length) throw new Error('Duplicate file paths');
  const folder = await verifyIdentity(root, key, identity), names = await fs.readdir(folder);
  if (names.some(n => n.toLowerCase() === name.toLowerCase())) throw new Error('Backup exists; rename it without overwriting');
  if (names.some(n => /^(Full|Custom)_Bckup_/.test(n) && n.includes(`_Bckup_${date}`)) && name === base) throw new Error('A backup exists for this date; add a unique suffix');
  const space = await fs.statfs(folder), bytes = manifest.files.reduce((n, f) => n + f.bytes, 0);
  if (Math.max(bytes, Number(input.declaredBytes) || 0) > space.bavail * space.bsize) throw new Error('Insufficient drive space');
  const destination = await directory(folder, name, true);
  const transfer = { ...manifest, name, date, bytes, destination, completed: new Set(), createdAt: now.toISOString() };
  await writeManifest(transfer, false);
  return transfer;
}
export async function writeManifest(t, complete) {
  const data = { name: t.name, date: t.date, kind: t.kind, files: t.files.length, bytes: t.bytes, complete, createdAt: t.createdAt, entries: t.files };
  const filename = path.join(t.destination, '.homesafe-backup.json');
  const handle = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(data)); await handle.sync(); } finally { await handle.close(); }
}
export async function receiveFile(root, key, identity, t, index, stream) {
  await verifyIdentity(root, key, identity);
  const entry = t.files[index];
  if (!entry || t.completed.has(index)) throw new Error('Unknown or already received file');
  // Recheck every ancestor, including the mounted root, before each write.
  const phone = await phoneFolder(root, identity.profile, identity.phone);
  let parent = await directory(phone, t.name);
  const parts = entry.path.split('/');
  for (const part of parts.slice(0, -1)) parent = await directory(parent, part, true, true);
  const target = path.join(parent, parts.at(-1));
  const names = await fs.readdir(parent);
  if (names.some(n => n.toLowerCase() === parts.at(-1).toLowerCase())) throw new Error('File collision');
  const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let bytes = 0; const hash = createHash('sha256');
  try {
    for await (const chunk of stream) {
      bytes += chunk.length; if (bytes > entry.bytes) throw new Error('File exceeded declared size');
      hash.update(chunk); let offset = 0;
      while (offset < chunk.length) { const result = await handle.write(chunk, offset, chunk.length - offset); offset += result.bytesWritten; }
    }
    if (bytes !== entry.bytes || hash.digest('hex') !== entry.sha256) throw new Error('File size or SHA-256 validation failed');
    await handle.sync(); t.completed.add(index);
  } finally { await handle.close(); }
}
export async function finishTransfer(root, key, identity, t) {
  await verifyIdentity(root, key, identity);
  if (t.completed.size !== t.files.length) throw new Error('Not all files have arrived');
  const integrity = await verifyBackupFiles(root, key, identity, t, t.onVerificationProgress);
  if (integrity.status !== 'verified') throw Object.assign(new Error('Disk readback failed: backup integrity mismatch'), { vaultCode: 'integrity_mismatch', integrity });
  await writeManifest(t, true);
  return integrity;
}

/** Read-only SHA-256 + size verification; collect all mismatches, show at most 50 paths. */
export async function verifyBackupFiles(root, key, identity, t, onProgress) {
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Drive unavailable');
  const issues = []; let checkedFiles = 0, mismatchCount = 0;
  for (const entry of t.files) {
    const currentRoot = await fs.lstat(root);
    if (currentRoot.dev !== rootStat.dev || currentRoot.ino !== rootStat.ino || currentRoot.isSymbolicLink()) throw new Error('Drive changed');
    await verifyIdentity(root, key, identity);
    filePath.parse(entry.path);
    let issue;
    try {
    let parent = await directory(await phoneFolder(root, identity.profile, identity.phone), t.name);
    const parts = entry.path.split('/'); for (const p of parts.slice(0, -1)) parent = await directory(parent, p, false, true);
    const h = await fs.open(path.join(parent, parts.at(-1)), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await h.stat();
      if (!stat.isFile()) throw new Error('Not a regular file');
      if (stat.size !== entry.bytes) issue = { path: entry.path, reason: 'size', expectedBytes: entry.bytes, actualBytes: stat.size };
      else { const hash = createHash('sha256'); for await (const chunk of h.createReadStream({ autoClose: false })) hash.update(chunk); if (hash.digest('hex') !== entry.sha256) issue = { path: entry.path, reason: 'checksum', expectedBytes: entry.bytes, actualBytes: stat.size }; }
    } finally { await h.close(); }
    } catch (e) { issue = { path: entry.path, reason: e.code === 'ENOENT' ? 'missing' : 'unreadable', expectedBytes: entry.bytes }; }
    if (issue) { mismatchCount++; if (issues.length < 50) issues.push(issue); }
    checkedFiles++;
    if (onProgress && (checkedFiles % 100 === 0 || checkedFiles === t.files.length)) await onProgress(checkedFiles);
  }
  return { status: mismatchCount ? 'mismatch' : 'verified', checkedFiles, mismatchCount, issues, checkedAt: new Date().toISOString() };
}
