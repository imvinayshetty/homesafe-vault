import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createPublicKey, verify, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { segment, filePath, directory, verifyIdentity, enrollIdentity, createTransfer, finishTransfer, writeManifest } from './storage.mjs';
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
const entrySchema = z.object({ path: filePath, bytes: z.number().int().nonnegative().max(1024 ** 4) });
export function createNativeProtocol({ root, key, selected, pairing, consumeCode, records, saveRecords, emit, audit, assertRoot, validCode, history }) {
 const pending = new Map(), challenges = new Map(); let transfer = null;
 const random = () => randomBytes(32).toString('base64url');
 const identity = r => ({ profile: r.profile, phone: r.phone, publicKey: r.publicKey });
 const device = id => { const all = records().filter(r => r.deviceId === id), r = all.find(r => !r.revoked), s = selected(); if (!r) throw vaultError(all.length ? 'phone_revoked' : 'wrong_account'); if (!s || r.profile !== s.profile || r.phone !== s.phone || r.email !== s.email) throw vaultError('wrong_account'); return r; };
 const proof = (v, action, extra = {}) => {
  const r = device(v.deviceId), c = challenges.get(v.challenge); challenges.delete(v.challenge);
  if (!c || c.deviceId !== v.deviceId || c.expiresAt <= Date.now()) throw vaultError('code_expired');
  nativeSignature(r.publicKey, v.signature, { deviceId: v.deviceId, challenge: v.challenge, action, ...extra }); return r;
 };
 const authorizedTransfer = v => { if (!transfer || transfer.failed || transfer.id !== v.transferId || transfer.token !== v.token) throw vaultError('invalid_request'); device(transfer.deviceId); return transfer; };
 // Incomplete manifests reject data/completion before any write without poisoning the transfer.
 const requireManifest = t => { if (t.files.length !== t.totalFiles || t.bytes !== t.totalBytes) throw Object.assign(vaultError('too_many_files'), { retryableManifest: true }); };
 return {
  ownsRequest(route,v,req) { return Boolean(transfer && !transfer.failed && !transfer.finished && (route === '/v1/backup/chunk' ? req.headers['x-transfer-id'] === transfer.id && req.headers['x-transfer-token'] === transfer.token : route === '/v1/backup/finish' && v.transferId === transfer.id && v.token === transfer.token)); },
  active: () => Boolean(transfer && !transfer.failed && !transfer.finished),
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
   if (route === '/v1/pair/confirm') {
    const p = pending.get(v.requestId); pending.delete(v.requestId); if (!p || p.expiresAt <= Date.now()) throw vaultError('code_expired');
    nativeSignature(p.publicKey, v.signature, { requestId: v.requestId, challenge: p.challenge, profile: p.profile, phone: p.phone });
    await assertRoot(); const r = records().find(r => r.profile === p.profile && r.phone === p.phone);
    if (r) { if (r.revoked) throw vaultError('phone_revoked'); if (r.deviceId !== p.deviceId || r.publicKey !== p.publicKey) throw new Error('Phone identity mismatch'); await verifyIdentity(root, key, identity(r)); }
    else { if (records().some(r => r.deviceId === p.deviceId)) throw new Error('Device already enrolled elsewhere'); await enrollIdentity(root, key, identity(p)); await saveRecords([...records(), { email: p.email, profile: p.profile, phone: p.phone, deviceId: p.deviceId, publicKey: p.publicKey }]); }
    emit({ type: 'pairing_verified', profile: p.profile, phone: p.phone }); await audit('phone_paired'); return { connected: true, email: p.email, profile: p.profile, phone: p.phone };
   }
   if (route === '/v1/device/challenge') { device(v.deviceId); const challenge = random(); for (const [id, c] of challenges) if (c.deviceId === v.deviceId) challenges.delete(id); challenges.set(challenge, { deviceId: v.deviceId, expiresAt: Date.now() + 30000 }); return { challenge, expiresAt: (Date.now() + 30000) / 1000 }; }
   if (route === '/v1/backups') {
    const r = proof(v, 'catalog'); await assertRoot(); const folder = await verifyIdentity(root, key, identity(r)), backups = [];
    for (const name of await fs.readdir(folder)) { if (!/^(Full|Custom)_Bckup_/.test(name)) continue; const dir = await directory(folder, name); const m = JSON.parse(await fs.readFile(path.join(dir, '.homesafe-backup.json'), 'utf8')); backups.push({ ...m, date: `20${m.date.slice(4,6)}-${m.date.slice(2,4)}-${m.date.slice(0,2)}` }); }
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
    const t = await createTransfer(root, key, identity(r), { kind: v.kind, name: v.name, declaredBytes: totalBytes, paged, files: page.map(f => ({ ...f, sha256: '0'.repeat(64) })) });
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
    if (!Number.isInteger(index) || !Number.isInteger(offset) || !entry || t.completed.has(index) || offset !== (t.offsets.get(index) ?? 0)) throw new Error('Invalid offset');
    let bytes = 0, chunks = []; for await (const c of req) { bytes += c.length; if (bytes > 4194304 || offset + bytes > entry.bytes) throw new Error('Chunk too large'); chunks.push(c); }
    const data = Buffer.concat(chunks); if (createHash('sha256').update(data).digest('hex') !== h['x-sha256']) throw new Error('Chunk digest mismatch');
    await assertRoot(); await verifyIdentity(root, key, t.identity); let parent = await directory(await verifyIdentity(root, key, t.identity), t.name); const parts = entry.path.split('/'); for (const p of parts.slice(0,-1)) parent = await directory(parent,p,true);
    const target = path.join(parent, parts.at(-1));
    const handle = await fs.open(target, constants.O_WRONLY | constants.O_NOFOLLOW | (offset === 0 ? constants.O_CREAT | constants.O_EXCL : 0), 0o600);
    try { if ((await handle.stat()).size !== offset) throw new Error('File offset changed'); let written=0; while(written<data.length) {const result=await handle.write(data,written,data.length-written,offset+written);written+=result.bytesWritten;} await handle.sync(); } finally { await handle.close(); }
    const hash = t.hashes.get(index) ?? createHash('sha256'); hash.update(data); t.hashes.set(index,hash); t.offsets.set(index,offset+bytes); t.lastActivity=Date.now();
    t.receivedBytes += bytes;
    if (offset+bytes === entry.bytes) { entry.sha256=hash.digest('hex'); t.completed.add(index); emit({ type: 'transfer_progress', files: t.completed.size, total: t.totalFiles }); }
    await history.update(t.id, { receivedFiles: t.completed.size, receivedBytes: t.receivedBytes });
    return { received: offset+bytes };
   }
   if (route === '/v1/backup/finish') {
    const t = authorizedTransfer(v); requireManifest(t); await assertRoot();
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
  expired: () => transfer && !transfer.failed && !transfer.finished && Date.now()-transfer.lastActivity>180000,
 };
}
