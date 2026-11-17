// Zero-configuration helpers: home LAN address, external drive discovery and Wi-Fi (mDNS) advertising.
import os from 'node:os';
import dgram from 'node:dgram';
import path from 'node:path';
import { promises as fs } from 'node:fs';

export const isPrivateIPv4 = ip => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip ?? '');

/** Address of the interface that owns the default route (UDP connect sends no packets). */
export async function defaultRouteIPv4() {
  const viaRoute = await new Promise(resolve => {
    const s = dgram.createSocket('udp4');
    const done = v => { try { s.close(); } catch {} resolve(v); };
    s.once('error', () => done(null));
    try { s.connect(53, '1.1.1.1', () => { try { done(s.address().address); } catch { done(null); } }); } catch { done(null); }
    setTimeout(() => done(null), 1000);
  });
  if (isPrivateIPv4(viaRoute)) return viaRoute;
  for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) if (n.family === 'IPv4' && !n.internal && isPrivateIPv4(n.address)) return n.address;
  return null;
}

/** Mount points that look like external drives on this OS (boot disk excluded). */
export async function externalDriveRoots(platform = process.platform) {
  const out = [];
  const list = async dir => (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).filter(d => d.isDirectory() || d.isSymbolicLink()).map(d => path.join(dir, d.name));
  if (platform === 'win32') {
    const sys = (process.env.SystemDrive || 'C:').toUpperCase();
    for (const l of 'DEFGHIJKLMNOPQRSTUVWXYZ') { const r = `${l}:\\`; if (`${l}:` !== sys && await fs.access(r).then(() => true, () => false)) out.push(r); }
  } else if (platform === 'darwin') {
    const boot = await fs.realpath('/');
    for (const v of await list('/Volumes')) { const real = await fs.realpath(v).catch(() => boot); if (real !== boot) out.push(v); }
  } else {
    for (const base of ['/media', '/mnt', '/run/media']) for (const d of await list(base)) { out.push(d); for (const sub of await list(d)) out.push(sub); }
  }
  const mounts = [];
  for (const r of out) { const st = await fs.statfs(r).catch(() => null); if (st && st.blocks > 0) mounts.push({ root: r, freeBytes: st.bavail * st.bsize }); }
  return mounts;
}

/** Existing HomeSafeBckup folder wins; otherwise the external drive with the most free space. */
export async function findBackupRoot(drives) {
  for (const d of drives) { const p = path.join(d.root, 'HomeSafeBckup'); if ((await fs.stat(p).catch(() => null))?.isDirectory()) return { root: p, existing: true }; }
  const best = [...drives].sort((a, b) => b.freeBytes - a.freeBytes)[0];
  return best ? { root: path.join(best.root, 'HomeSafeBckup'), existing: false } : null;
}

/** Advertise `_homesafe._tcp.local.` so phones find the Vault and pin its certificate without typing. */
export async function advertise({ port, fingerprint, name = os.hostname() }) {
  const { Bonjour } = await import('bonjour-service');
  const bonjour = new Bonjour();
  const service = bonjour.publish({ name: `HomeSafe Vault ${name}`.slice(0, 63), type: 'homesafe', protocol: 'tcp', port, txt: { v: '1', name, fp: fingerprint ?? '' } });
  return { service, stop: () => new Promise(r => { try { bonjour.unpublishAll(() => { bonjour.destroy(); r(); }); } catch { r(); } }) };
}
