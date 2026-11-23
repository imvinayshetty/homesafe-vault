import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';

/**
 * A recovery file kept on the backup drive, so deleting the Vault's app-data folder does not lose who owns what.
 *  - phones: account email, profile, phone, device id, public key, revoked flag. No secrets (public keys only).
 *  - vault (optional): the Vault's identity key and TLS certificate/private key, encrypted with a passphrase the owner chose.
 */
export const RECOVERY_FILE = '.homesafe-recovery.json';
const KDF = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

export async function readRecovery(root) {
  try {
    const v = JSON.parse(await fs.readFile(path.join(root, RECOVERY_FILE), 'utf8'));
    return v && v.version === 1 && Array.isArray(v.phones) ? v : null;
  } catch { return null; }
}
async function save(root, data) {
  const file = path.join(root, RECOVERY_FILE);
  await fs.writeFile(`${file}.tmp`, JSON.stringify(data), { mode: 0o600 }); await fs.rename(`${file}.tmp`, file);
}
const clean = r => ({ email: r.email, profile: r.profile, phone: r.phone, deviceId: r.deviceId, publicKey: r.publicKey, ...(r.revoked ? { revoked: true } : {}) });

/** Keeps the names-and-ownership part current; an existing encrypted vault block is preserved. Best effort: never blocks a backup. */
export async function mirrorPhones(root, records) {
  try { const old = await readRecovery(root); await save(root, { version: 1, updatedAt: new Date().toISOString(), phones: records.map(clean), ...(old?.vault ? { vault: old.vault } : {}) }); } catch { /* drive read-only or unplugged */ }
}

export async function writeVault(root, passphrase, secrets) {
  if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 200) throw Object.assign(new Error('Weak recovery passphrase'), { userMessage: 'Use a recovery passphrase of at least 12 characters.' });
  const salt = randomBytes(16), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', scryptSync(passphrase, salt, 32, KDF), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secrets)), cipher.final()]);
  const old = await readRecovery(root);
  await save(root, { version: 1, updatedAt: new Date().toISOString(), phones: old?.phones ?? [], vault: { kdf: 'scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') } });
}

/** Returns { identityKey, cert, key } or throws when the passphrase is wrong. */
export function openVault(vault, passphrase) {
  const d = createDecipheriv('aes-256-gcm', scryptSync(String(passphrase), Buffer.from(vault.salt, 'base64'), 32, KDF), Buffer.from(vault.iv, 'base64'));
  d.setAuthTag(Buffer.from(vault.tag, 'base64'));
  const s = JSON.parse(Buffer.concat([d.update(Buffer.from(vault.ciphertext, 'base64')), d.final()]).toString());
  if (typeof s.identityKey !== 'string' || typeof s.cert !== 'string' || typeof s.key !== 'string') throw new Error('Recovery data is damaged');
  return s;
}
