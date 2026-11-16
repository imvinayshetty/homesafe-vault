import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, X509Certificate, createHash } from 'node:crypto';
import { createVaultService } from './service.mjs';
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const stateDir = path.resolve(option('state') ?? path.join(os.homedir(), '.homesafe-vault'));
async function main() {
  if (args[0] === 'init') {
    const rootArg = option('root'), origin = option('origin'), cert = option('cert'), tlsKey = option('key');
    if (!rootArg || !origin || !cert || !tlsKey) throw new Error('Missing init options');
    const root = await fs.realpath(rootArg);
    if (path.basename(root) !== 'HomeSafeBckup') throw new Error('Select HomeSafeBckup itself');
    const parsedOrigin = new URL(origin);
    if (parsedOrigin.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsedOrigin.hostname)) throw new Error('Use HTTPS');
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const config = { root, origins: [parsedOrigin.origin], adminToken: randomBytes(32).toString('base64url'), identityKey: randomBytes(32).toString('base64'), cert: path.resolve(cert), key: path.resolve(tlsKey) };
    await fs.readFile(config.cert); await fs.readFile(config.key);
    await fs.writeFile(path.join(stateDir, 'config.json'), JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
    console.log('Vault initialized. Run start; use access to retrieve the local dashboard access key.'); return;
  }
  const config = JSON.parse(await fs.readFile(path.join(stateDir, 'config.json'), 'utf8'));
  if (args[0] === 'access') {
    // Explicit owner-only command, never a startup log or remote API response.
    process.stdout.write(`Local dashboard access key (keep private):\n${config.adminToken}\n`); return;
  }
  if (args[0] !== 'start') throw new Error('Commands: init, start, access');
  const lockPath = path.join(stateDir, 'service.lock');
  const lock = await fs.open(lockPath, 'wx', 0o600);
  try {
    const cert = await fs.readFile(config.cert), key = await fs.readFile(config.key);
    const fingerprint = createHash('sha256').update(new X509Certificate(cert).raw).digest('hex');
    const service = await createVaultService({ ...config, stateDir, tls: { cert, key } });
    console.log(`HomeSafe Vault running. Monitor 127.0.0.1:${service.monitorPort}; phone HTTPS port ${service.lanPort}.`);
    console.log(`Phone certificate SHA-256 fingerprint: ${fingerprint}`);
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await service.close(); await lock.close(); await fs.unlink(lockPath); process.exit(0); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (e) { await lock.close(); await fs.unlink(lockPath); throw e; }
}
main().catch(() => { console.error('Vault could not start. Check command options, existing drive folder, TLS files, and local settings. If service.lock exists, stop the other instance before removing a stale lock. No existing backup was replaced.'); process.exitCode = 1; });
