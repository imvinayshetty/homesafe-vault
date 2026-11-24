import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { directory, verifyIdentity, writeManifest, verifyBackupFiles, filePath } from './storage.mjs';

/**
 * Staging: the phone's files first land in a folder on this computer's own disk, and the Vault copies them to the backup drive afterwards.
 * The phone is finished as soon as every file is on the computer; a slow or briefly missing drive no longer holds it up.
 * The default staging folder is used only when it has room for the backup plus 2 GB. Otherwise the owner is asked to choose a folder named HomeSafeTemp on a drive that does,
 * or to save straight to the backup drive.
 * Every file is hash-checked while it is copied, the finished backup on the drive is read back and checked again, and only then is the staged copy removed.
 */
export const STAGING_MARGIN_BYTES = 2 * 1024 ** 3;
const COPY_BUFFER = 4 * 1024 * 1024, DISK_TEST_BYTES = 32 * 1024 * 1024;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jobFile = dir => path.join(dir, '.job.json');

/** Removes the half-written staged copy of one file (the phone could not finish it). */
export async function discardStaged(dataDir, entry) {
  try {
    let parent = dataDir; const parts = filePath.parse(entry.path).split('/');
    for (const p of parts.slice(0, -1)) parent = await directory(parent, p, false, true);
    const target = path.join(parent, parts.at(-1)), st = await fs.lstat(target);
    if (st.isFile()) await fs.unlink(target);
  } catch { /* nothing staged yet */ }
}

/** Sequential write speed of a folder, in bytes per second. The test file is removed afterwards. */
export async function writeSpeed(folder, bytes = DISK_TEST_BYTES) {
  const file = path.join(folder, `.homesafe-speedtest-${randomBytes(6).toString('hex')}`), block = randomBytes(1024 * 1024);
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  const started = process.hrtime.bigint();
  try {
    for (let done = 0; done < bytes; done += block.length) await handle.write(block, 0, block.length, done);
    await handle.sync();
  } finally { await handle.close(); await fs.unlink(file).catch(() => {}); }
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  return Math.round(bytes / Math.max(seconds, 0.001));
}

const gb = n => `${(n / 1024 ** 3).toFixed(1)} GB`;
const askOwner = message => Object.assign(new Error(message), { userMessage: message });
export async function createStaging({ dir, stateDir, enabled = true, allowSameDisk = false, freeBytes, root, rootStat, key, assertRoot, history, emit, audit, log = async () => {} }) {
  let stopped = false, chain = Promise.resolve(); const running = new Set();
  const free = freeBytes ?? (async d => { const s = await fs.statfs(d); return s.bavail * s.bsize; });
  const prefsFile = stateDir ? path.join(stateDir, 'staging.json') : null;
  // The owner's choice of a HomeSafeTemp folder to stage into.
  let prefs = prefsFile ? await fs.readFile(prefsFile, 'utf8').then(JSON.parse).catch(() => ({})) : {};
  if (typeof prefs !== 'object' || prefs === null) prefs = {};
  const savePrefs = async () => { if (!prefsFile) return; await fs.writeFile(`${prefsFile}.tmp`, JSON.stringify(prefs), { mode: 0o600 }); await fs.rename(`${prefsFile}.tmp`, prefsFile); };
  let lastNeed = 0;
  if (enabled) await fs.mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => { enabled = false; });

  /** 'ok' when a folder can receive this backup, otherwise why not. */
  async function check(base, need) {
    const st = await fs.stat(base).catch(() => null);
    if (!st || !st.isDirectory()) return 'missing';
    if (st.dev === rootStat.dev && !allowSameDisk) return 'same'; // same disk as the backup drive: staging would only copy twice
    return (await free(base).catch(() => 0)) >= need ? 'ok' : 'small';
  }

  /**
   * What staging can do for a backup of this size: 'ready' (a folder with room exists), 'needs_folder' (the default folder lacks backup size + 2 GB and no HomeSafeTemp folder fits),
   * or 'off' (staging is unavailable, or would gain nothing because the default folder is on the backup drive's own disk).
   */
  async function decide(declaredBytes) {
    if (!enabled || stopped) return { kind: 'off' };
    const need = declaredBytes + STAGING_MARGIN_BYTES; lastNeed = need;
    const fallback = await check(dir, need);
    if (fallback === 'ok') return { kind: 'ready', base: dir, need };
    const temp = prefs.tempDir ? await check(prefs.tempDir, need) : null;
    if (temp === 'ok') return { kind: 'ready', base: prefs.tempDir, need };
    if (fallback === 'same' && !prefs.tempDir) return { kind: 'off' };
    return { kind: 'needs_folder', need, free: await free(dir).catch(() => 0) };
  }
  let lastAsk = 0;
  const ask = d => { emit({ type: 'staging_needed', needBytes: d.need, freeBytes: d.free }); lastAsk = Date.now(); };

  /** Answer for the phone before it starts: can this backup be received on the computer first? With ask, also asks the owner on the Vault screen. */
  async function readiness(declaredBytes, wantAsk = false) {
    const d = await decide(declaredBytes);
    if (d.kind === 'needs_folder' && wantAsk && Date.now() - lastAsk > 5000) ask(d);
    return d.kind === 'off' ? { available: false, ready: false } : d.kind === 'ready' ? { available: true, ready: true, needBytes: d.need } : { available: true, ready: false, needBytes: d.need, freeBytes: d.free };
  }

  /**
   * Where this backup's files will be received first: { base }. Only called when the owner chose the fast option on the phone.
   * Throws (and asks on the Vault screen) when no folder has room.
   */
  async function plan(declaredBytes) {
    const d = await decide(declaredBytes);
    if (d.kind === 'ready') return { base: d.base };
    if (d.kind === 'needs_folder') { ask(d); throw Object.assign(new Error('staging_space'), { vaultCode: 'staging_space' }); }
    throw Object.assign(new Error('staging_unavailable'), { vaultCode: 'staging_unavailable' });
  }

  /** Creates this transfer's folder inside the planned staging folder. */
  async function begin(chosen, id) {
    const data = path.join(chosen.base, id, 'data');
    await fs.mkdir(data, { recursive: true, mode: 0o700 });
    return data;
  }

  /** The owner picked a folder named HomeSafeTemp on a drive with enough room. */
  async function choose(p) {
    const real = await fs.realpath(String(p ?? '')).catch(() => null), st = real ? await fs.lstat(real).catch(() => null) : null;
    if (!real || !st?.isDirectory() || path.basename(real).toLowerCase() !== 'homesafetemp') throw askOwner('Choose a folder named HomeSafeTemp.');
    if (st.dev === rootStat.dev && !allowSameDisk) throw askOwner('That folder is on your backup drive, so it would not help. Choose a HomeSafeTemp folder on another drive.');
    const room = await free(real).catch(() => 0);
    if (lastNeed && room < lastNeed) throw askOwner(`That folder's drive has ${gb(room)} free, but this backup needs ${gb(lastNeed)} (its size plus 2 GB). Choose a drive with more room.`);
    prefs = { tempDir: real }; await savePrefs();
    emit({ type: 'staging_ready' }); void resumePending();
  }

  /** Called when the phone has sent everything: remember what has to be saved, then save it in the background. */
  async function enqueue(job) {
    const file = jobFile(job.jobDir), tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(job), { mode: 0o600 }); await fs.rename(tmp, file);
    schedule(job);
  }
  function schedule(job) {
    if (running.has(job.id)) return;
    running.add(job.id);
    chain = chain.then(() => save(job)).catch(() => {}).finally(() => running.delete(job.id));
  }

  async function save(job) {
    const progress = { files: 0, total: job.files.length, bytes: 0, totalBytes: job.bytes };
    let lastEmit = 0, lastSaved = 0; const samples = [];
    const speed = () => { const now = Date.now(); samples.push([now, progress.bytes]); while (samples.length > 2 && now - samples[0][0] > 5000) samples.shift(); const [t0, b0] = samples[0]; return now > t0 ? Math.round((progress.bytes - b0) * 1000 / (now - t0)) : 0; };
    const report = async force => {
      const now = Date.now(); if (!force && now - lastEmit < 500) return; lastEmit = now;
      emit({ type: 'sync_progress', files: progress.files, total: progress.total, bytes: progress.bytes, totalBytes: progress.totalBytes, bytesPerSecond: speed() });
      if (force || now - lastSaved > 3000) { lastSaved = now; await history.update(job.id, { status: 'saving', receivedFiles: progress.files, receivedBytes: progress.bytes }).catch(() => {}); }
    };
    try {
      // The drive may be unplugged right now; keep the staged copy and wait for it.
      for (;;) {
        if (stopped) return;
        try { await assertRoot(); break; } catch { emit({ type: 'sync_waiting' }); await sleep(5000); }
      }
      await history.update(job.id, { status: 'saving', receivedFiles: 0, receivedBytes: 0 }).catch(() => {});
      const folder = await verifyIdentity(root, key, job.identity);
      const destination = await directory(folder, job.name, true);
      const t = { name: job.name, date: job.date, kind: job.kind, basedOn: job.basedOn, skipped: job.skipped, files: job.files, bytes: job.bytes, createdAt: job.createdAt, destination };
      await report(true);
      for (let i = 0; i < job.files.length; i++) {
        if (stopped) return;
        const entry = job.files[i], parts = filePath.parse(entry.path).split('/');
        // The destination is checked before every file so a swapped or unplugged drive is never written to.
        await assertRoot(); await verifyIdentity(root, key, job.identity);
        let src = path.join(job.jobDir, 'data'); for (const p of parts.slice(0, -1)) src = await directory(src, p, false, true); src = path.join(src, parts.at(-1));
        let parent = destination; for (const p of parts.slice(0, -1)) parent = await directory(parent, p, true, true);
        const target = path.join(parent, parts.at(-1));
        // A copy left by an earlier run is kept only if it is already complete and correct.
        const existing = await fs.lstat(target).catch(() => null);
        if (existing) {
          let same = false;
          if (existing.isFile() && existing.size === entry.bytes) { const h = createHash('sha256'), fh = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW); try { const buf = Buffer.allocUnsafe(COPY_BUFFER); let n; while ((n = (await fh.read(buf, 0, buf.length, null)).bytesRead) > 0) h.update(buf.subarray(0, n)); } finally { await fh.close(); } same = h.digest('hex') === entry.sha256; }
          if (same) { progress.files++; progress.bytes += entry.bytes; await report(false); continue; }
          if (existing.isFile()) await fs.unlink(target); else throw new Error('Destination is not a regular file');
        }
        const from = await fs.open(src, constants.O_RDONLY | constants.O_NOFOLLOW);
        const to = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        const hash = createHash('sha256'), buf = Buffer.allocUnsafe(COPY_BUFFER); let offset = 0;
        try {
          for (;;) {
            const { bytesRead } = await from.read(buf, 0, buf.length, offset); if (!bytesRead) break;
            hash.update(buf.subarray(0, bytesRead)); let written = 0;
            while (written < bytesRead) written += (await to.write(buf, written, bytesRead - written, offset + written)).bytesWritten;
            offset += bytesRead; progress.bytes += bytesRead; await report(false);
          }
          if (offset !== entry.bytes || hash.digest('hex') !== entry.sha256) throw Object.assign(new Error('Staged file does not match what the phone sent'), { vaultCode: 'integrity_mismatch' });
          await to.sync();
        } finally { await from.close(); await to.close(); }
        progress.files++; await report(false);
      }
      await writeManifest(t, false);
      emit({ type: 'sync_verifying' });
      const integrity = await verifyBackupFiles(root, key, job.identity, t, async checkedFiles => { emit({ type: 'sync_verifying', checkedFiles, total: job.files.length }); });
      if (integrity.status !== 'verified') throw Object.assign(new Error('Backup on the drive does not match the manifest'), { vaultCode: 'integrity_mismatch', integrity });
      await writeManifest(t, true);
      await history.update(job.id, { status: 'completed', completedAt: new Date().toISOString(), receivedFiles: progress.total, receivedBytes: progress.totalBytes, integrity });
      await fs.rm(job.jobDir, { recursive: true, force: true });
      emit({ type: 'sync_completed' }); await audit('sync_completed');
    } catch (e) {
      // The staged copy stays where it is, so nothing the phone sent is lost.
      const reason = e?.vaultCode === 'integrity_mismatch' ? 'The copy on the drive did not match. The files are still kept on this computer.' : 'Could not finish saving to the drive. The files are still kept on this computer.';
      await history.update(job.id, { status: 'failed', failureCode: e?.vaultCode ?? 'sync_failed', failureReason: reason, ...(e?.integrity ? { integrity: e.integrity } : {}) }).catch(() => {});
      await log('staging-sync', e); emit({ type: 'sync_failed', reason }); await audit('sync_failed');
    }
  }

  /** After a restart: carry on with backups that reached this computer but were not yet saved to the drive. */
  async function resumePending() {
    if (!enabled) return 0;
    let n = 0;
    for (const base of [dir, prefs.tempDir].filter(Boolean)) for (const name of await fs.readdir(base).catch(() => [])) {
      const jobDir = path.join(base, name);
      const job = await fs.readFile(jobFile(jobDir), 'utf8').then(JSON.parse).catch(() => null);
      if (!job || job.id !== name || job.jobDir !== jobDir) continue;
      schedule(job); n++;
    }
    return n;
  }

  /** Write speed of the backup drive and of the staging folder. Used by the speed test. */
  async function diskTest() {
    const drive = await writeSpeed(root);
    let staging = null; if (enabled) { try { staging = await writeSpeed(dir); } catch { /* not available */ } }
    return { driveBytesPerSecond: drive, stagingBytesPerSecond: staging, staging: enabled && (await fs.stat(dir).then(s => s.dev !== rootStat.dev || allowSameDisk).catch(() => false)) };
  }

  return { plan, readiness, begin, choose, enqueue, resumePending, diskTest, stop() { stopped = true; }, get enabled() { return enabled; } };
}
