import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createPublicKey, verify, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { segment, filePath, directory, verifyIdentity, enrollIdentity, adoptOrphanIdentity, discardPartial, createTransfer, finishTransfer, writeManifest } from './storage.mjs';
export const MANIFEST_PAGE_LIMIT = 5000, MANIFEST_TOTAL_LIMIT = 500000;
/** Stable, personal-data-free error codes for phone clients. */
export const ERROR_MESSAGES = {
  code_expired: 'Pairing code or challenge expired; use the current code on the Vault.',
  wrong_account: 'This phone is not paired with the Vault account and phone currently selected.',
  phone_revoked: 'This phone was removed from the Vault; pair it again.',
  drive_unavailable: 'The Vault backup drive is not connected.',
  name_exists: 'A backup with this name already exists.',
  no_space: 'Not enough free space on the Vault drive.',
  transfer_active: 'Another backup is already in progress.',
  too_many_files: 'This backup has too many files for one request or one backup.',
  rate_limited: 'Too many attempts; wait one minute.',
  invalid_request: 'Request rejected; check the signature and request fields.',
  phone_stopped: 'The phone stopped the backup.',
  vault_cancelled: 'The backup was cancelled on the Vault.',
  transfer_stopped: 'The Vault has stopped this backup.',
  integrity_mismatch: 'Backup verification found files that do not match the transferred data.',
};
export const vaultError = code => Object.assign(new Error(code), { vaultCode: code });
export function errorCode(e) {
  if (e?.vaultCode && ERROR_MESSAGES[e.vaultCode]) return e.vaultCode;
  if (e?.code === 'ENOSPC' || /Insufficient drive space/.test(e?.message ?? '')) return 'no_space';
  if (/Backup exists|A backup exists for this date/.test(e?.message ?? '')) return 'name_exists';
  if (['ENOENT', 'ENODEV', 'EIO', 'ENXIO'].includes(e?.code) && /HomeSafeBckup|drive/i.test(e?.message ?? '') ) return 'drive_unavailable';
  return 'invalid_request';
}
/** Canonical JSON for signatures: flat object, keys sorted by Unicode code point (= UTF-8 byte order), no whitespace, UTF-8 not escaped. */
export const compareCodePoints = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
export const canonical = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => compareCodePoints(a, b))));
export function nativeSignature(publicKey, signature, value) {
  const raw = Buffer.from(z.string().parse(publicKey), 'base64'); if (raw.length !== 32) throw new Error('Invalid native public key');
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
  if (!verify(null, Buffer.from(canonical(value)), key, Buffer.from(z.string().parse(signature), 'base64'))) throw vaultError('invalid_request');
}
const entrySchema = z.object({ path: filePath, bytes: z.number().int().nonnegative().max(1024 ** 4), modified: z.number().int().nonnegative().optional() });
// A transfer that sees no traffic for this long is abandoned; until then a phone that lost Wi-Fi can resume it.
/** Bytes per second over roughly the last five seconds of received data. */
/** Data is flushed to the drive at the end of every file and after this many bytes; the finished backup is still re-read and hash-checked before it is reported complete. */
const SYNC_EVERY_BYTES = 64 * 1024 * 1024;
export const speedOf = (t, now = Date.now()) => { const s = (t.samples ??= []); s.push([now, t.receivedBytes]); while (s.length > 2 && now - s[0][0] > 5000) s.shift(); const [t0, b0] = s[0]; return now > t0 ? Math.max(0, Math.round((t.receivedBytes - b0) * 1000 / (now - t0))) : 0; };
export const TRANSFER_IDLE_MS = 20 * 60 * 1000;
const BASELINE_PAGE = 5000, BASELINE_TTL_MS = 10 * 60 * 1000;
const notBefore = (e, retryable) => Object.assign(e instanceof Error ? e : new Error(String(e)), { retryable });
export function createNativeProtocol({ root, key, selected, pairing, consumeCode, records, saveRecords, emit, audit, assertRoot, validCode, history }) {
 const pending = new Map(), challenges = new Map(), baselines = new Map(); let transfer = null;
 const random = () => randomBytes(32).toString('base64url');
 const identity = r => ({ profile: r.profile, phone: r.phone, publicKey: r.publicKey });
 const device = id => { const all = records().filter(r => r.deviceId === id), r = all.find(r => !r.revoked), s = selected(); if (!r) throw vaultError(all.length ? 'phone_revoked' : 'wrong_account'); if (!s || r.profile !== s.profile || r.phone !== s.phone || r.email !== s.email) throw vaultError('wrong_account'); return r; };
 const proof = (v, action, extra = {}) => {
  const r = device(v.deviceId), c = challenges.get(v.challenge); challenges.delete(v.challenge);
  if (!c || c.deviceId !== v.deviceId || c.expiresAt <= Date.now()) throw vaultError('code_expired');
  nativeSignature(r.publicKey, v.signature, { deviceId: v.deviceId, challenge: v.challenge, action, ...extra }); return r;
 };
 const authorizedTransfer = v => { if (transfer?.failed && transfer.id === v.transferId && transfer.token === v.token) throw vaultError('transfer_stopped'); if (!transfer || transfer.failed || transfer.id !== v.transferId || transfer.token !== v.token) throw vaultError('invalid_request'); device(transfer.deviceId); return transfer; };
 // Incomplete manifests reject data/completion before any write without poisoning the transfer.
 const requireManifest = t => { if (t.files.length !== t.totalFiles || t.bytes !== t.totalBytes) throw Object.assign(vaultError('too_many_files'), { retryableManifest: true }); };
 return {
  ownsRequest(route,v,req) { return Boolean(transfer && !transfer.failed && !transfer.finished && (route === '/v1/backup/chunk' ? req.headers['x-transfer-id'] === transfer.id && req.headers['x-transfer-token'] === transfer.token : route === '/v1/backup/finish' && v.transferId === transfer.id && v.token === transfer.token)); },
  active: () => Boolean(transfer && !transfer.failed && !transfer.finished),
  /** Milliseconds since the running transfer last heard from the phone, or null when none is running. */
  idleMs: () => (transfer && !transfer.failed && !transfer.finished ? Date.now() - transfer.lastActivity : null),
  activeIdentity: () => transfer && !transfer.failed && !transfer.finished ? transfer.identity : null,
  reset() { if (transfer && !transfer.failed && !transfer.finished) throw vaultError('transfer_active'); transfer = null; pending.clear(); challenges.clear(); },
  async handle(route, v, req) {
   for (const [id, p] of pending) if (p.expiresAt <= Date.now()) pending.delete(id);
   for (const [id, c] of challenges) if (c.expiresAt <= Date.now()) challenges.delete(id);
   if (route === '/v1/pair/begin') {
    const email = z.string().email().max(254).parse(v.email).toLowerCase(), s = selected();
    z.string().regex(/^[\w-]{16,128}$/).parse(v.deviceId);
    if (!s || s.email !== email) throw vaultError('wrong_account'); if (!validCode(pairing(), v.code)) throw vaultError('code_expired');
    nativeSignature(v.publicKey, v.signature, { email: v.email, code: v.code, deviceId: v.deviceId, publicKey: v.publicKey });
    if (pending.size >= 100) throw vaultError('rate_limited');
    const requestId = random(), p = { ...s, deviceId: v.deviceId, publicKey: v.publicKey, challenge: random(), expiresAt: Date.now() + 30000 };
    consumeCode(); pending.set(requestId, p); emit({ type: 'phone_connecting' });
    return { requestId, challenge: p.challenge, expiresAt: p.expiresAt / 1000, email, profile: p.profile, phone: p.phone };
   }
   if (route === '/v1/pair/confirm') try {
    const p = pending.get(v.requestId); pending.delete(v.requestId); if (!p || p.expiresAt <= Date.now()) throw vaultError('code_expired');
    nativeSignature(p.publicKey, v.signature, { requestId: v.requestId, challenge: p.challenge, profile: p.profile, phone: p.phone });
    await assertRoot(); const r = records().find(r => r.profile === p.profile && r.phone === p.phone);
    if (r) {
     if (r.revoked) throw vaultError('phone_revoked');
     if (r.deviceId !== p.deviceId || r.publicKey !== p.publicKey) {
      // The same account pairing a phone of the same name again (app reinstalled, new phone): the owner approved it on this Vault, so it replaces the old identity.
      if (r.email !== p.email || records().some(o => o !== r && o.deviceId === p.deviceId)) throw new Error('Phone identity mismatch');
      await adoptOrphanIdentity(root, key, identity(p)); await saveRecords(records().map(o => o === r ? { ...o, deviceId: p.deviceId, publicKey: p.publicKey } : o)); await audit('phone_repaired');
     } else {
      // Same phone and key, but its seal on the drive was made by a Vault whose key is gone (names-only recovery): the owner is pairing it again, so seal it anew.
      try { await verifyIdentity(root, key, identity(r)); } catch { await adoptOrphanIdentity(root, key, identity(r)); await audit('phone_resealed'); }
     }
    }
    else { if (records().some(r => r.deviceId === p.deviceId)) throw new Error('Device already enrolled elsewhere');
    // The phone folder exists but this Vault has no record of it (app data was reset or the key was lost): the phone being paired now takes it over. Another account's profile was already refused when the profile was selected.
    if (records().some(o => o.profile.toLowerCase() === p.profile.toLowerCase() && o.email !== p.email)) throw new Error('Profile belongs to another account');
    try { await enrollIdentity(root, key, identity(p)); } catch (e) { if (!/already exists/.test(e.message)) throw e; await adoptOrphanIdentity(root, key, identity(p)); } await saveRecords([...records(), { email: p.email, profile: p.profile, phone: p.phone, deviceId: p.deviceId, publicKey: p.publicKey }]); }
    emit({ type: 'pairing_verified', profile: p.profile, phone: p.phone }); await audit('phone_paired'); return { connected: true, email: p.email, profile: p.profile, phone: p.phone };
   } catch (e) { emit({ type: 'pairing_failed' }); throw e; }
   if (route === '/v1/device/challenge') { device(v.deviceId); const challenge = random(); for (const [id, c] of challenges) if (c.deviceId === v.deviceId) challenges.delete(id); challenges.set(challenge, { deviceId: v.deviceId, expiresAt: Date.now() + 30000 }); return { challenge, expiresAt: (Date.now() + 30000) / 1000 }; }
   if (route === '/v1/backups') {
    const r = proof(v, 'catalog'); await assertRoot(); const folder = await verifyIdentity(root, key, identity(r)), backups = [];
    for (const name of await fs.readdir(folder)) { if (!/^(Full|Custom)_Bckup_/.test(name)) continue; const dir = await directory(folder, name); const m = JSON.parse(await fs.readFile(path.join(dir, '.homesafe-backup.json'), 'utf8')); const { entries, ...summary } = m; backups.push({ ...summary, date: `20${m.date.slice(4,6)}-${m.date.slice(2,4)}-${m.date.slice(0,2)}` }); }
    return { backups };
   }
   if (route === '/v1/backup/start') {
    // Two modes: inline manifest (files non-empty, no fileCount) or paged (files: [] with fileCount + bytes).
    if (!Array.isArray(v.files) || v.files.length > MANIFEST_PAGE_LIMIT) throw vaultError('too_many_files');
    const paged = v.files.length === 0;
    if (!paged && v.fileCount !== undefined) throw vaultError('invalid_request');
    if (paged && (!Number.isInteger(v.fileCount) || v.fileCount < 1)) throw vaultError('invalid_request');
    if (paged && v.fileCount > MANIFEST_TOTAL_LIMIT) throw vaultError('too_many_files');
    const page = paged ? [] : z.array(entrySchema).min(1).parse(v.files), pageBytes = page.reduce((n, f) => n + f.bytes, 0);
    const totalFiles = paged ? v.fileCount : page.length, totalBytes = paged ? v.bytes : (v.bytes ?? pageBytes);
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || (!paged && totalBytes !== pageBytes)) throw vaultError('invalid_request');
    const r = proof(v, 'backup', { name: v.name, kind: v.kind, files: totalFiles, bytes: totalBytes });
    if (transfer && !transfer.failed && !transfer.finished) throw vaultError('transfer_active'); await assertRoot();
    const t = await createTransfer(root, key, identity(r), { kind: v.kind, name: v.name, ...(v.basedOn !== undefined ? { basedOn: v.basedOn } : {}), declaredBytes: totalBytes, paged, files: page.map(f => ({ ...f, sha256: '0'.repeat(64) })) });
    transfer = { ...t, id: random(), token: random(), deviceId: r.deviceId, identity: identity(r), totalFiles, totalBytes, receivedBytes: 0, seen: new Set(t.files.map(f => f.path.toLowerCase())), offsets: new Map(), hashes: new Map(), failed: false, lastActivity: Date.now() };
    await history.start(transfer, { email: r.email, profile: r.profile, phone: r.phone });
    emit({ type: 'phone_connecting' }); emit({ type: 'pairing_verified', profile: r.profile, phone: r.phone }); emit({ type: 'transfer_started' }); emit({ type: 'transfer_progress', files: 0, total: totalFiles }); await audit('transfer_started');
    return { transferId: transfer.id, token: transfer.token, manifestComplete: !paged };
   }
   if (route === '/v1/backup/files') {
    // Manifest pages: { transferId, token, offset, files }. offset must equal entries received so far; only before the first chunk.
    const t = authorizedTransfer(v);
    if (t.offsets.size || t.completed.size || t.files.length >= t.totalFiles) throw vaultError('invalid_request');
    if (!Number.isInteger(v.offset) || v.offset !== t.files.length) throw vaultError('invalid_request');
    if (!Array.isArray(v.files) || v.files.length > MANIFEST_PAGE_LIMIT || t.files.length + v.files.length > t.totalFiles) throw vaultError('too_many_files');
    const page = z.array(entrySchema).min(1).parse(v.files), keys = page.map(f => f.path.toLowerCase());
    if (new Set(keys).size !== keys.length || keys.some(k => t.seen.has(k))) throw vaultError('invalid_request');
    const bytes = t.bytes + page.reduce((n, f) => n + f.bytes, 0), complete = t.files.length + page.length === t.totalFiles;
    if (bytes > t.totalBytes || (complete && bytes !== t.totalBytes)) throw vaultError('invalid_request');
    for (const k of keys) t.seen.add(k); t.files.push(...page.map(f => ({ ...f, sha256: '0'.repeat(64) }))); t.bytes = bytes; t.lastActivity = Date.now();
    if (complete) { await assertRoot(); await writeManifest(t, false); }
    await history.update(t.id, { manifestReceived: t.files.length, status: complete ? 'transferring' : 'receiving_manifest' });
    return { received: t.files.length, manifestComplete: complete };
   }
   if (route === '/v1/backup/chunk') {
    const h = req.headers, t = authorizedTransfer({ transferId: h['x-transfer-id'], token: h['x-transfer-token'] }), index = Number(h['x-file-index']), offset = Number(h['x-offset']), entry = t.files[index];
    requireManifest(t);
    if (!Number.isInteger(index) || !Number.isInteger(offset) || !entry || t.completed.has(index) || offset !== (t.offsets.get(index) ?? 0)) throw notBefore(new Error('Invalid offset'), true);
    let bytes = 0, chunks = []; try { for await (const c of req) { bytes += c.length; if (bytes > 4194304 || offset + bytes > entry.bytes) throw new Error('Chunk too large'); chunks.push(c); } } catch (e) { throw e.message === 'Chunk too large' ? e : notBefore(e, true); } // a dropped connection writes nothing, so the phone may retry
    const data = Buffer.concat(chunks); if (createHash('sha256').update(data).digest('hex') !== h['x-sha256']) throw notBefore(new Error('Chunk digest mismatch'), true);
    await assertRoot(); const parts = entry.path.split('/'), dirKey = parts.slice(0,-1).join('/').toLowerCase();
    // Resolve the phone folder and each sub-folder once per transfer; re-reading them for every 4 MiB chunk was a large share of the time on drives with big folders.
    t.dirs ??= new Map(); let parent = t.dirs.get(dirKey);
    if (!parent) { let cur = t.baseDir ??= await directory(await verifyIdentity(root, key, t.identity), t.name); for (const p of parts.slice(0,-1)) cur = await directory(cur,p,true,true); parent = cur; t.dirs.set(dirKey, parent); }
    const target = path.join(parent, parts.at(-1));
    const handle = await fs.open(target, constants.O_WRONLY | constants.O_NOFOLLOW | (offset === 0 ? constants.O_CREAT | constants.O_EXCL : 0), 0o600);
    try { if ((await handle.stat()).size !== offset) throw new Error('File offset changed'); let written=0; while(written<data.length) {const result=await handle.write(data,written,data.length-written,offset+written);written+=result.bytesWritten;} if (offset+bytes === entry.bytes || (t.unsynced = (t.unsynced ?? 0) + bytes) >= SYNC_EVERY_BYTES) { await handle.sync(); t.unsynced = 0; } } finally { await handle.close(); }
    const hash = t.hashes.get(index) ?? createHash('sha256'); hash.update(data); t.hashes.set(index,hash); t.offsets.set(index,offset+bytes); t.lastActivity=Date.now();
    t.receivedBytes += bytes;
    if (offset+bytes === entry.bytes) { entry.sha256=hash.digest('hex'); t.completed.add(index); }
    emit({ type: 'transfer_progress', files: t.completed.size, total: t.totalFiles, bytes: t.receivedBytes, totalBytes: t.totalBytes, bytesPerSecond: speedOf(t) });
    if (Date.now() - (t.historySavedAt ?? 0) >= 2000 || t.completed.size === t.totalFiles) { t.historySavedAt = Date.now(); await history.update(t.id, { receivedFiles: t.completed.size, receivedBytes: t.receivedBytes }); }
    return { received: offset+bytes };
   }
   if (route === '/v1/backup/resume') {
    // After a dropped connection the phone asks where to continue: first unfinished file and how many bytes of it arrived.
    const t = authorizedTransfer(v); requireManifest(t); t.lastActivity = Date.now();
    let index = 0; while (index < t.files.length && (t.completed.has(index) || t.problems?.has(index))) index++;
    return { nextIndex: index, nextOffset: index < t.files.length ? (t.offsets.get(index) ?? 0) : 0, completedFiles: t.completed.size, receivedBytes: t.receivedBytes, totalFiles: t.totalFiles, totalBytes: t.totalBytes };
   }
   if (route === '/v1/backup/baseline') {
    // The latest complete Full backup of this phone, as pages of { path, bytes, modified? }, so the phone can send only what changed.
    for (const [tk, b] of baselines) if (b.expiresAt <= Date.now()) baselines.delete(tk);
    const offset = v.offset === undefined ? 0 : v.offset;
    if (!Number.isInteger(offset) || offset < 0) throw vaultError('invalid_request');
    let b;
    if (v.token === undefined) {
     const r = proof(v, 'baseline'); await assertRoot(); const folder = await verifyIdentity(root, key, identity(r)); let best = null;
     for (const name of await fs.readdir(folder)) {
      if (!/^Full_Bckup_/.test(name)) continue;
      const m = await directory(folder, name).then(dir => fs.readFile(path.join(dir, '.homesafe-backup.json'), 'utf8')).then(JSON.parse).catch(() => null);
      if (!m || m.complete !== true || m.kind !== 'Full' || !Array.isArray(m.entries) || !/^\d{6}$/.test(m.date ?? '')) continue;
      const rank = `${m.date.slice(4, 6)}${m.date.slice(2, 4)}${m.date.slice(0, 2)}${m.createdAt ?? ''}`;
      if (!best || rank > best.rank) best = { rank, name, m };
     }
     if (!best) return { found: false };
     const entries = best.m.entries.map(e => ({ path: e.path, bytes: e.bytes, ...(Number.isInteger(e.modified) ? { modified: e.modified } : {}) }));
     const tk = random(); b = { deviceId: r.deviceId, name: best.name, date: best.m.date, files: entries.length, bytes: best.m.bytes, entries, expiresAt: Date.now() + BASELINE_TTL_MS };
     for (const [other, o] of baselines) if (o.deviceId === r.deviceId) baselines.delete(other);
     baselines.set(tk, b); v = { ...v, token: tk };
    } else {
     device(v.deviceId); b = baselines.get(v.token); if (!b || b.deviceId !== v.deviceId) throw vaultError('code_expired'); b.expiresAt = Date.now() + BASELINE_TTL_MS;
    }
    const page = b.entries.slice(offset, offset + BASELINE_PAGE), next = offset + page.length < b.entries.length ? offset + page.length : null;
    return { found: true, token: v.token, name: b.name, date: `20${b.date.slice(4, 6)}-${b.date.slice(2, 4)}-${b.date.slice(0, 2)}`, files: b.files, bytes: b.bytes, entries: page, next };
   }
   if (route === '/v1/status') {
    // Which drive this Vault saves to and how much room is left. Drive name and sizes only: no folder path, no profile or phone names.
    const parent = path.dirname(root); let connected = true; try { await assertRoot(); } catch { connected = false; }
    const space = connected ? await fs.statfs(root).catch(() => null) : null;
    return { connected, driveName: path.basename(parent) || parent, ...(space ? { freeBytes: space.bavail * space.bsize, totalBytes: space.blocks * space.bsize } : {}) };
   }
   if (route === '/v1/backup/abort') {
    // The phone gave up (a fatal error or the user cancelled): stop at once instead of waiting for the idle timeout.
    authorizedTransfer(v); await this.fail(vaultError('phone_stopped')); return { stopped: true };
   }
   if (route === '/v1/backup/problem') {
    // One file could not be copied (changed while backing up, no longer on the phone...). Park it; the transfer carries on with the next file.
    const t = authorizedTransfer(v); requireManifest(t); const index = z.number().int().min(0).parse(v.index), entry = t.files[index];
    if (!entry || t.completed.has(index)) throw vaultError('invalid_request');
    const reason = z.string().max(200).parse(v.reason ?? 'Could not be copied');
    await assertRoot(); await discardPartial(root, key, t.identity, t, entry);
    t.receivedBytes -= t.offsets.get(index) ?? 0; t.offsets.delete(index); t.hashes.delete(index);
    (t.problems ??= new Map()).set(index, { path: entry.path, reason }); t.lastActivity = Date.now();
    emit({ type: 'transfer_progress', files: t.completed.size, total: t.totalFiles, bytes: t.receivedBytes, totalBytes: t.totalBytes, bytesPerSecond: speedOf(t) });
    return { problems: t.problems.size, receivedBytes: t.receivedBytes };
   }
   if (route === '/v1/backup/replace') {
    // Retry or rename a parked file: new size and/or new path inside this backup, then the phone sends it again from byte 0.
    const t = authorizedTransfer(v); requireManifest(t); const index = z.number().int().min(0).parse(v.index);
    if (!t.problems?.has(index)) throw vaultError('invalid_request');
    const entry = t.files[index], path = filePath.parse(v.path ?? entry.path), bytes = z.number().int().nonnegative().max(1024 ** 4).parse(v.bytes);
    const modified = v.modified === undefined ? undefined : z.number().int().nonnegative().parse(v.modified), was = entry.path.toLowerCase(), now = path.toLowerCase();
    if (now !== was && t.seen.has(now)) throw vaultError('invalid_request');
    t.seen.delete(was); t.seen.add(now); t.bytes += bytes - entry.bytes; t.totalBytes += bytes - entry.bytes;
    entry.path = path; entry.bytes = bytes; entry.sha256 = '0'.repeat(64); if (modified !== undefined) entry.modified = modified; else delete entry.modified;
    t.problems.delete(index); t.lastActivity = Date.now();
    return { receivedBytes: t.receivedBytes, totalBytes: t.totalBytes };
   }
   if (route === '/v1/backup/finish') {
    const t = authorizedTransfer(v); requireManifest(t); await assertRoot();
    if (t.problems?.size) {
     // Files the owner chose to skip are left out of this backup and listed in its manifest.
     t.skipped = [...(t.skipped ?? []), ...t.problems.values()];
     const dropped = new Set(t.problems.keys()), remap = new Map(); let n = 0;
     t.files.forEach((_, i) => { if (!dropped.has(i)) remap.set(i, n++); });
     const drop = t.files.filter((_, i) => dropped.has(i));
     t.files = t.files.filter((_, i) => !dropped.has(i)); t.completed = new Set([...t.completed].map(i => remap.get(i)).filter(i => i !== undefined));
     t.bytes -= drop.reduce((n, f) => n + f.bytes, 0); t.totalBytes = t.bytes; t.totalFiles = t.files.length; t.problems = new Map(); t.offsets = new Map(); t.hashes = new Map();
    }
    if (t.completed.size !== t.totalFiles) throw vaultError('invalid_request');
    await writeManifest(t, false);
    await history.update(t.id, { status: 'verifying', integrity: { status: 'checking', checkedFiles: 0, mismatchCount: 0, issues: [] } });
    emit({ type: 'transfer_verifying', checkedFiles: 0, total: t.totalFiles });
    t.onVerificationProgress = async checkedFiles => { emit({ type: 'transfer_verifying', checkedFiles, total: t.totalFiles }); await history.update(t.id, { integrity: { status: 'checking', checkedFiles, mismatchCount: 0, issues: [] } }); };
    const integrity = await finishTransfer(root,key,t.identity,t);
    t.finished=true;
    await history.update(t.id, { status: 'completed', completedAt: new Date().toISOString(), integrity });
    emit({ type:'transfer_completed' }); await audit('transfer_completed'); return { state:'complete',sentBytes:t.bytes,totalBytes:t.bytes };
   }
   throw vaultError('invalid_request');
  },
  async fail(error) {
    const code = error ? errorCode(error) : 'transfer_interrupted';
    const reason = ERROR_MESSAGES[code] ?? 'Phone transfer stopped. Check Wi-Fi and the connected drive.';
    if (transfer) { transfer.failed=true; await history.update(transfer.id, { status: 'failed', failureCode: code, failureReason: reason, ...(error?.integrity ? { integrity: error.integrity } : {}) }); }
    emit({type:'transfer_failed',reason}); await audit('failure','transfer');
  },
  expired: () => transfer && !transfer.failed && !transfer.finished && Date.now()-transfer.lastActivity>TRANSFER_IDLE_MS,
 };
}
