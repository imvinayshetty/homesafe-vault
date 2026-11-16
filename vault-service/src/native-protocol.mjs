import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createPublicKey, verify, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { segment, filePath, directory, verifyIdentity, enrollIdentity, createTransfer, finishTransfer } from './storage.mjs';
const canonical = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
export function nativeSignature(publicKey, signature, value) {
  const raw = Buffer.from(z.string().parse(publicKey), 'base64'); if (raw.length !== 32) throw new Error('Invalid native public key');
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
  if (!verify(null, Buffer.from(canonical(value)), key, Buffer.from(z.string().parse(signature), 'base64'))) throw new Error('Native signature rejected');
}
export function createNativeProtocol({ root, key, selected, pairing, consumeCode, records, saveRecords, emit, audit, assertRoot, validCode }) {
 const pending = new Map(), challenges = new Map(); let transfer = null;
 const random = () => randomBytes(32).toString('base64url');
 const identity = r => ({ profile: r.profile, phone: r.phone, publicKey: r.publicKey });
 const device = id => { const r = records().find(r => r.deviceId === id && !r.revoked), s = selected(); if (!r || !s || r.profile !== s.profile || r.phone !== s.phone || r.email !== s.email) throw new Error('Phone not selected, enrolled, or revoked'); return r; };
 const proof = (v, action, extra = {}) => {
  const r = device(v.deviceId), c = challenges.get(v.challenge); challenges.delete(v.challenge);
  if (!c || c.deviceId !== v.deviceId || c.expiresAt <= Date.now()) throw new Error('Device challenge expired');
  nativeSignature(r.publicKey, v.signature, { deviceId: v.deviceId, challenge: v.challenge, action, ...extra }); return r;
 };
 const authorizedTransfer = v => { if (!transfer || transfer.failed || transfer.id !== v.transferId || transfer.token !== v.token) throw new Error('Transfer unavailable'); device(transfer.deviceId); return transfer; };
 return {
  ownsRequest(route,v,req) { return Boolean(transfer && !transfer.failed && !transfer.finished && (route === '/v1/backup/chunk' ? req.headers['x-transfer-id'] === transfer.id && req.headers['x-transfer-token'] === transfer.token : route === '/v1/backup/finish' && v.transferId === transfer.id && v.token === transfer.token)); },
  active: () => Boolean(transfer && !transfer.failed && !transfer.finished),
  reset() { if (transfer && !transfer.failed && !transfer.finished) throw new Error('Native transfer active'); transfer = null; pending.clear(); challenges.clear(); },
  async handle(route, v, req) {
   for (const [id, p] of pending) if (p.expiresAt <= Date.now()) pending.delete(id);
   for (const [id, c] of challenges) if (c.expiresAt <= Date.now()) challenges.delete(id);
   if (route === '/v1/pair/begin') {
    const email = z.string().email().max(254).parse(v.email).toLowerCase(), s = selected();
    z.string().regex(/^[\w-]{16,128}$/).parse(v.deviceId);
    if (!s || s.email !== email || !validCode(pairing(), v.code)) throw new Error('Pairing code expired or wrong account');
    nativeSignature(v.publicKey, v.signature, { email: v.email, code: v.code, deviceId: v.deviceId, publicKey: v.publicKey });
    if (pending.size >= 100) throw new Error('Too many requests');
    const requestId = random(), p = { ...s, deviceId: v.deviceId, publicKey: v.publicKey, challenge: random(), expiresAt: Date.now() + 30000 };
    consumeCode(); pending.set(requestId, p); emit({ type: 'phone_connecting' });
    return { requestId, challenge: p.challenge, expiresAt: p.expiresAt / 1000, email, profile: p.profile, phone: p.phone };
   }
   if (route === '/v1/pair/confirm') {
    const p = pending.get(v.requestId); pending.delete(v.requestId); if (!p || p.expiresAt <= Date.now()) throw new Error('Confirmation expired');
    nativeSignature(p.publicKey, v.signature, { requestId: v.requestId, challenge: p.challenge, profile: p.profile, phone: p.phone });
    await assertRoot(); const r = records().find(r => r.profile === p.profile && r.phone === p.phone);
    if (r) { if (r.revoked || r.deviceId !== p.deviceId || r.publicKey !== p.publicKey) throw new Error('Phone identity mismatch'); await verifyIdentity(root, key, identity(r)); }
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
    const files = z.array(z.object({ path: filePath, bytes: z.number().int().nonnegative().max(1024**4) })).min(1).max(10000).parse(v.files);
    const r = proof(v, 'backup', { name: v.name, kind: v.kind, files: files.length, bytes: files.reduce((n,f)=>n+f.bytes,0) });
    if (transfer && !transfer.failed && !transfer.finished) throw new Error('Transfer active'); await assertRoot();
    const t = await createTransfer(root, key, identity(r), { kind: v.kind, name: v.name, files: files.map(f => ({ ...f, sha256: '0'.repeat(64) })) });
    transfer = { ...t, id: random(), token: random(), deviceId: r.deviceId, identity: identity(r), offsets: new Map(), hashes: new Map(), failed: false, lastActivity: Date.now() };
    emit({ type: 'phone_connecting' }); emit({ type: 'pairing_verified', profile: r.profile, phone: r.phone }); emit({ type: 'transfer_started' }); emit({ type: 'transfer_progress', files: 0, total: files.length }); await audit('transfer_started'); return { transferId: transfer.id, token: transfer.token };
   }
   if (route === '/v1/backup/chunk') {
    const h = req.headers, t = authorizedTransfer({ transferId: h['x-transfer-id'], token: h['x-transfer-token'] }), index = Number(h['x-file-index']), offset = Number(h['x-offset']), entry = t.files[index];
    if (!Number.isInteger(index) || !Number.isInteger(offset) || !entry || t.completed.has(index) || offset !== (t.offsets.get(index) ?? 0)) throw new Error('Invalid offset');
    let bytes = 0, chunks = []; for await (const c of req) { bytes += c.length; if (bytes > 4194304 || offset + bytes > entry.bytes) throw new Error('Chunk too large'); chunks.push(c); }
    const data = Buffer.concat(chunks); if (createHash('sha256').update(data).digest('hex') !== h['x-sha256']) throw new Error('Chunk digest mismatch');
    await assertRoot(); await verifyIdentity(root, key, t.identity); let parent = await directory(await verifyIdentity(root, key, t.identity), t.name); const parts = entry.path.split('/'); for (const p of parts.slice(0,-1)) parent = await directory(parent,p,true);
    const target = path.join(parent, parts.at(-1));
    const handle = await fs.open(target, constants.O_WRONLY | constants.O_NOFOLLOW | (offset === 0 ? constants.O_CREAT | constants.O_EXCL : 0), 0o600);
    try { if ((await handle.stat()).size !== offset) throw new Error('File offset changed'); let written=0; while(written<data.length) {const result=await handle.write(data,written,data.length-written,offset+written);written+=result.bytesWritten;} await handle.sync(); } finally { await handle.close(); }
    const hash = t.hashes.get(index) ?? createHash('sha256'); hash.update(data); t.hashes.set(index,hash); t.offsets.set(index,offset+bytes); t.lastActivity=Date.now();
    if (offset+bytes === entry.bytes) { entry.sha256=hash.digest('hex'); t.completed.add(index); emit({ type: 'transfer_progress', files: t.completed.size, total: t.files.length }); }
    return { received: offset+bytes };
   }
   if (route === '/v1/backup/finish') { const t = authorizedTransfer(v); await assertRoot(); await finishTransfer(root,key,t.identity,t); t.finished=true; emit({ type:'transfer_completed' }); await audit('transfer_completed'); return { state:'complete',sentBytes:t.bytes,totalBytes:t.bytes }; }
   throw new Error('Unknown native operation');
  },
  async fail() { if (transfer) transfer.failed=true; emit({type:'transfer_failed',reason:'Phone transfer failed. Check Wi-Fi and the connected drive.'}); await audit('failure','transfer'); },
  expired: () => transfer && !transfer.failed && !transfer.finished && Date.now()-transfer.lastActivity>180000,
 };
}
