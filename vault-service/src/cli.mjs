import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, X509Certificate, createHash } from 'node:crypto';
import { createVaultService } from './service.mjs';
import { guidedInstall, driveReady, certificateStatus } from './installer.mjs';
import { defaultRouteIPv4, advertise, watchAddress, mdnsName } from './discovery.mjs';
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const stateDir = path.resolve(option('state') ?? path.join(os.homedir(), '.homesafe-vault'));
async function main() {
  if (args[0] === 'install') { await guidedInstall(stateDir); return; }
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
  if (args[0] === 'doctor') { const drive = await driveReady(config.root, config.driveIdentity); console.log(`Drive write/read verification passed; ${(drive.availableBytes/1024**3).toFixed(1)} GiB free.`); const certInfo = certificateStatus(new X509Certificate(await fs.readFile(config.cert)).validTo); if (certInfo.expired) throw new Error('Certificate expired; phones must be paired again after replacing it'); console.log(`Certificate valid until ${new Date(certInfo.expiresAt).toISOString().slice(0, 10)} (${certInfo.daysLeft} days).${certInfo.warning ? ' WARNING: expires within 60 days.' : ''}`); const r = await fetch('http://127.0.0.1:7878/v1/ready', {signal:AbortSignal.timeout(2000)}); const ready = await r.json(); if (!r.ok || !ready.driveReady || (config.instanceId && ready.instanceId !== config.instanceId)) throw new Error('Configured service unavailable'); console.log('Vault service running and selected drive ready.'); return; }
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
    // Zero-config: follow the current home Wi-Fi address. The certificate is never regenerated (phones pin it).
    let lanHost = (await defaultRouteIPv4()) ?? config.lanHost, service = null, mdns = null;
    const name = mdnsName();
    const up = async () => {
      service = await createVaultService({ ...config, lanHost, stateDir, tls: { cert, key } });
      console.log(`HomeSafe Vault running. Monitor 127.0.0.1:${service.monitorPort}; phone HTTPS ${lanHost ?? '0.0.0.0'}:${service.lanPort}.`);
      mdns = await advertise({ port: service.lanPort, fingerprint, name }).catch(e => { console.error(`Wi-Fi discovery could not start: ${e.message}`); return null; });
    };
    const down = async () => { await mdns?.stop(); mdns = null; await service?.close(); service = null; };
    await up();
    console.log(`Phone certificate SHA-256 fingerprint: ${fingerprint}`);
    const watcher = watchAddress({ initial: lanHost, onChange: async next => { console.log(`Wi-Fi address changed to ${next}; restarting phone connection.`); await down(); lanHost = next; await up(); }, onError: e => console.error(`Restart on new address failed, retrying: ${e.message}`) });
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; watcher.stop(); await down(); await lock.close(); await fs.unlink(lockPath); process.exit(0); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (e) { await lock.close(); await fs.unlink(lockPath); throw e; }
}
main().catch(e => { console.error(`Vault could not start: ${e?.code === 'EADDRINUSE' ? 'another program is using the Vault port' : e?.code === 'EADDRNOTAVAIL' ? 'this PC\'s Wi-Fi address changed' : e?.message ?? 'unknown error'}. Check command options, existing drive folder, TLS files, and local settings. If service.lock exists, stop the other instance before removing a stale lock. No existing backup was replaced.`); process.exitCode = 1; });
