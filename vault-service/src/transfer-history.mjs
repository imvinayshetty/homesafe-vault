import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { segment, filePath, directory, verifyIdentity, verifyBackupFiles } from './storage.mjs';

export const HISTORY_LIMIT = 100;
const count = z.number().int().nonnegative().safe();
const issue = z.object({ path: filePath, reason: z.enum(['missing', 'size', 'checksum', 'unreadable']), expectedBytes: count, actualBytes: count.optional() });
const report = z.object({ status: z.enum(['pending', 'checking', 'verified', 'mismatch', 'unreadable']), checkedFiles: count, mismatchCount: count, issues: z.array(issue).max(50), checkedAt: z.string().optional() });
const record = z.object({ id: z.string(), email: z.string(), profile: segment, phone: segment, name: segment, kind: z.enum(['Full', 'Custom']), startedAt: z.string(), updatedAt: z.string(), completedAt: z.string().optional(), status: z.enum(['receiving_manifest', 'transferring', 'saving', 'verifying', 'completed', 'failed', 'interrupted']), manifestReceived: count, totalFiles: count, receivedFiles: count, receivedBytes: count, totalBytes: count, failureCode: z.string().optional(), failureReason: z.string().optional(), integrity: report });

/** Owner-only local metadata; no tokens or pairing codes and never cloud analytics. */
export async function createTransferHistory({ stateDir, root, key, assertRoot, onChange }) {
  const filename = path.join(stateDir, 'transfer-history.json');
  let rows = z.array(record).max(HISTORY_LIMIT).parse(JSON.parse(await fs.readFile(filename, 'utf8').catch(e => { if (e.code === 'ENOENT') return '[]'; throw e; })));
  const save = async () => { await fs.writeFile(`${filename}.tmp`, JSON.stringify(rows), { mode: 0o600 }); await fs.rename(`${filename}.tmp`, filename); onChange?.(); };
  if (rows.some(r => ['receiving_manifest', 'transferring', 'verifying'].includes(r.status))) {
    rows = rows.map(r => ['receiving_manifest', 'transferring', 'verifying'].includes(r.status) ? { ...r, status: 'interrupted', failureCode: 'service_stopped', failureReason: 'Vault stopped before this backup was completed.', integrity: { ...r.integrity, status: 'pending' } } : r);
    await save();
  }
  const list = selected => selected ? rows.filter(r => r.email === selected.email && r.profile === selected.profile && r.phone === selected.phone).map(({ email, ...r }) => r) : [];
  const update = async (id, patch) => { rows = rows.map(r => r.id === id ? record.parse({ ...r, ...patch, updatedAt: new Date().toISOString() }) : r); await save(); };
  return {
    list,
    async start(t, owner) {
      const now = new Date().toISOString();
      rows = [record.parse({ id: t.id, ...owner, name: t.name, kind: t.kind, startedAt: t.createdAt, updatedAt: now, status: t.files.length === t.totalFiles ? 'transferring' : 'receiving_manifest', manifestReceived: t.files.length, totalFiles: t.totalFiles, receivedFiles: 0, receivedBytes: 0, totalBytes: t.totalBytes, integrity: { status: 'pending', checkedFiles: 0, mismatchCount: 0, issues: [] } }), ...rows].slice(0, HISTORY_LIMIT);
      await save();
    },
    update,
    async recheck(id, selected, devices) {
      const r = rows.find(r => r.id === id && r.email === selected?.email && r.profile === selected?.profile && r.phone === selected?.phone);
      if (!r?.completedAt) throw new Error('Select a completed backup for verification.');
      const device = devices.find(d => !d.revoked && d.email === r.email && d.profile === r.profile && d.phone === r.phone);
      if (!device) throw new Error('The backup phone is no longer authorized.');
      await update(id, { status: 'verifying', integrity: { status: 'checking', checkedFiles: 0, mismatchCount: 0, issues: [] } });
      try {
        await assertRoot();
        const identity = { profile: device.profile, phone: device.phone, publicKey: device.publicKey };
        const folder = await directory(await verifyIdentity(root, key, identity), r.name);
        const h = await fs.open(path.join(folder, '.homesafe-backup.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
        let manifest;
        try { if (!(await h.stat()).isFile()) throw new Error('Invalid manifest'); manifest = JSON.parse(await h.readFile('utf8')); } finally { await h.close(); }
        const files = z.array(z.object({ path: filePath, bytes: count.max(1024 ** 4), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).min(1).max(500000).parse(manifest.entries);
        if (!manifest.complete || manifest.name !== r.name || files.length !== r.totalFiles || files.reduce((n, f) => n + f.bytes, 0) !== r.totalBytes || new Set(files.map(f => f.path.toLowerCase())).size !== files.length) throw new Error('Invalid manifest');
        const integrity = await verifyBackupFiles(root, key, identity, { name: r.name, files }, async checkedFiles => update(id, { integrity: { status: 'checking', checkedFiles, mismatchCount: 0, issues: [] } }));
        await update(id, { status: integrity.status === 'verified' ? 'completed' : 'failed', failureCode: integrity.status === 'verified' ? '' : 'integrity_mismatch', failureReason: integrity.status === 'verified' ? '' : 'Backup files do not match the saved manifest.', integrity });
      } catch {
        await update(id, { status: 'failed', failureCode: 'verification_unavailable', failureReason: 'Could not verify this backup. Check the original drive, phone identity and backup manifest.', integrity: { status: 'unreadable', checkedFiles: 0, mismatchCount: 0, issues: [], checkedAt: new Date().toISOString() } });
      }
    },
  };
}