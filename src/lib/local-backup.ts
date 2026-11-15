export const ROOT_FOLDER = "HomeSafeBckup";
export type BackupKind = "Full" | "Custom";
export interface LocalFileHandle { kind: "file"; name: string; getFile(): Promise<File>; createWritable(): Promise<{ write(data: Blob | string): Promise<void>; close(): Promise<void> }> }
export interface LocalDirectory {
  kind: "directory"; name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<LocalDirectory>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<LocalFileHandle>;
  values(): AsyncIterableIterator<LocalDirectory | LocalFileHandle>;
  queryPermission(options: { mode: "readwrite" }): Promise<string>;
  requestPermission(options: { mode: "readwrite" }): Promise<string>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}
export interface Identity { deviceId: string; key: CryptoKey }
export interface Enrollment { profile: string; phone?: string; identity: Identity; root: LocalDirectory }
interface Envelope { version: 1; algorithm: "AES-256-GCM"; iv: number[]; ciphertext: number[] }
export interface BackupEntry { name: string; date: string; kind: BackupKind; files: number; bytes: number; complete: boolean }
export interface BackupFile { file: File; path: string }

export function safeSegment(value: string): string {
  const name = value.trim();
  if (!name || name.length > 80 || /[\\/<>:"|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name) || name === "." || name === ".." || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) {
    throw new Error("Use a name of 1–80 characters without slashes, reserved names or trailing dots.");
  }
  return name;
}
export function dateCode(date: Date): string {
  return [date.getDate(), date.getMonth() + 1, date.getFullYear() % 100].map(n => String(n).padStart(2, "0")).join("");
}
export function defaultBackupName(kind: BackupKind, date: Date): string { return `${kind}_Bckup_${dateCode(date)}`; }
export function validateBackupName(name: string, kind: BackupKind, date: Date): string {
  const clean = safeSegment(name);
  const base = defaultBackupName(kind, date);
  if (clean !== base && !clean.startsWith(`${base}_`)) throw new Error(`Keep ${base} at the start; add a unique suffix to rename this backup.`);
  return clean;
}
export function hasSameDate(entries: BackupEntry[], date: Date): boolean { return entries.some(e => e.date === dateCode(date)); }
export function requireUniqueName(name: string, names: string[]): void {
  if (names.some(n => n.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error("That backup already exists. Rename the new backup; existing files will not be overwritten.");
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("homesafe-local-vault", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("settings");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Local device storage is unavailable. Enable browser storage to continue."));
  });
}
export async function loadSetting<T>(key: string): Promise<T | undefined> {
  const db = await database();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const request = db.transaction("settings").objectStore("settings").get(key);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
export async function saveSetting(key: string, value: unknown): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("settings", "readwrite");
      tx.objectStore("settings").put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
export async function localIdentity(): Promise<Identity> {
  const existing = await loadSetting<Identity>("identity");
  if (existing) return existing;
  const identity = { deviceId: crypto.randomUUID(), key: await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]) };
  await saveSetting("identity", identity);
  return identity;
}
export async function encryptIdentity(identity: Identity, profile: string): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(profile) }, identity.key, new TextEncoder().encode(JSON.stringify({ deviceId: identity.deviceId, profile })));
  return { version: 1, algorithm: "AES-256-GCM", iv: [...iv], ciphertext: [...new Uint8Array(ciphertext)] };
}
export async function verifyEnvelope(value: unknown, identity: Identity, profile: string): Promise<void> {
  try {
    const e = value as Envelope;
    if (e.version !== 1 || e.algorithm !== "AES-256-GCM" || !Array.isArray(e.iv) || e.iv.length !== 12 || !Array.isArray(e.ciphertext)) throw new Error();
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(e.iv), additionalData: new TextEncoder().encode(profile) }, identity.key, new Uint8Array(e.ciphertext));
    const decoded = JSON.parse(new TextDecoder().decode(plain));
    if (decoded.deviceId !== identity.deviceId || decoded.profile !== profile) throw new Error();
  } catch { throw new Error("Device identity does not match, or the encrypted profile is damaged. No backup was written."); }
}
async function writeJSON(directory: LocalDirectory, name: string, value: unknown) {
  const handle = await directory.getFileHandle(name, { create: true });
  const stream = await handle.createWritable();
  try { await stream.write(JSON.stringify(value, null, 2)); } finally { await stream.close(); }
}
export async function ensurePermission(root: LocalDirectory): Promise<void> {
  if (await root.queryPermission({ mode: "readwrite" }) !== "granted" && await root.requestPermission({ mode: "readwrite" }) !== "granted") throw new Error("Storage permission was not granted. Choose the folder again and allow read/write access.");
}
export async function registerProfile(root: LocalDirectory, profile: string, identity: Identity): Promise<void> {
  safeSegment(profile);
  const names: string[] = [];
  for await (const entry of root.values()) names.push(entry.name);
  if (names.some(n => n.toLowerCase() === profile.toLowerCase())) throw new Error("This profile folder already exists. Choose Reconnect saved profile; do not replace its identity.");
  const folder = await root.getDirectoryHandle(profile, { create: true });
  await writeJSON(folder, ".homesafe-identity.json", await encryptIdentity(identity, profile));
}
export async function registerPhone(root: LocalDirectory, profile: string, phone: string, identity: Identity): Promise<void> {
  if (root.name !== ROOT_FOLDER) throw new Error(`Choose the ${ROOT_FOLDER} folder.`);
  const cleanProfile = safeSegment(profile);
  const cleanPhone = safeSegment(phone);
  if (/^(Full|Custom)_Bckup_/i.test(cleanPhone)) throw new Error("Choose a memorable phone name, not a dated backup name.");
  await ensurePermission(root);
  // Find case-insensitive matches before creating anything, including file collisions.
  let existing: LocalDirectory | LocalFileHandle | undefined;
  for await (const entry of root.values()) {
    if (entry.name.toLowerCase() === cleanProfile.toLowerCase()) existing = entry;
  }
  if (existing && (existing.kind !== "directory" || existing.name !== cleanProfile)) throw new Error("That profile name already exists with different spelling or is not a folder. Use its exact name.");
  const folder = existing?.kind === "directory" ? existing : await root.getDirectoryHandle(cleanProfile, { create: true });
  for await (const entry of folder.values()) {
    if (entry.name.toLowerCase() === cleanPhone.toLowerCase()) throw new Error("That phone name already exists in this profile. Reconnect it or choose a different memorable name; its identity will not be replaced.");
  }
  const destination = await folder.getDirectoryHandle(cleanPhone, { create: true });
  await writeJSON(destination, ".homesafe-identity.json", await encryptIdentity(identity, `${cleanProfile}/${cleanPhone}`));
}
export async function verifyProfile(enrollment: Enrollment): Promise<LocalDirectory> {
  const { root, profile, phone, identity } = enrollment;
  if (root.name !== ROOT_FOLDER) throw new Error(`Choose the ${ROOT_FOLDER} folder, not a profile or dated backup folder.`);
  safeSegment(profile);
  let folder: LocalDirectory;
  try { folder = await root.getDirectoryHandle(profile); }
  catch { throw new Error(`No matching profile folder named “${profile}” was found. Check the selected storage and profile name.`); }
  if (phone) {
    safeSegment(phone);
    try { folder = await folder.getDirectoryHandle(phone); }
    catch { throw new Error(`No matching phone folder named “${phone}” was found in “${profile}”. No backup was written.`); }
  }
  let encrypted: unknown;
  try { encrypted = JSON.parse(await (await (await folder.getFileHandle(".homesafe-identity.json")).getFile()).text()); }
  catch { throw new Error("This profile has no readable encrypted identity. No backup was written."); }
  await verifyEnvelope(encrypted, identity, phone ? `${profile}/${phone}` : profile);
  return folder;
}
export async function listBackups(folder: LocalDirectory): Promise<BackupEntry[]> {
  const entries: BackupEntry[] = [];
  for await (const entry of folder.values()) {
    if (entry.kind !== "directory") continue;
    try {
      const manifest = JSON.parse(await (await (await entry.getFileHandle(".homesafe-backup.json")).getFile()).text()) as BackupEntry;
      if (typeof manifest.date === "string" && (manifest.kind === "Full" || manifest.kind === "Custom")) entries.push({ ...manifest, name: entry.name });
    } catch { /* Unrecognized folders still participate in name collision checks. */ }
  }
  return entries.sort((a, b) => b.name.localeCompare(a.name));
}
export async function createBackup(enrollment: Enrollment, kind: BackupKind, name: string, files: BackupFile[], date: Date, renamed: boolean): Promise<BackupEntry> {
  if (!enrollment.phone) throw new Error("Choose a named phone folder before saving. Existing profile-level backups remain unchanged.");
  if (!files.length) throw new Error("Select at least one accessible file to back up.");
  const targetName = validateBackupName(name, kind, date);
  const paths = files.map(({ path }) => path.split("/").map(safeSegment));
  const uniquePaths = new Set(paths.map(p => p.join("/").toLowerCase()));
  if (uniquePaths.size !== files.length || paths.some(p => p[0] === ".homesafe-backup.json")) throw new Error("Selected files contain duplicate or reserved paths. Choose them again.");
  const folder = await verifyProfile(enrollment);
  const entries = await listBackups(folder);
  if (hasSameDate(entries, date) && (!renamed || targetName === defaultBackupName(kind, date))) throw new Error("A backup already exists for today. Add a unique suffix to the backup name before continuing.");
  const names: string[] = [];
  for await (const entry of folder.values()) names.push(entry.name);
  requireUniqueName(targetName, names);
  const destination = await folder.getDirectoryHandle(targetName, { create: true });
  const manifest: BackupEntry = { name: targetName, date: dateCode(date), kind, files: files.length, bytes: files.reduce((sum, item) => sum + item.file.size, 0), complete: false };
  try {
    await writeJSON(destination, ".homesafe-backup.json", manifest);
    for (let i = 0; i < files.length; i++) {
      let parent = destination;
      const segments = paths[i];
      if (!segments) throw new Error("File path is missing.");
      for (const segment of segments.slice(0, -1)) parent = await parent.getDirectoryHandle(segment, { create: true });
      const filename = segments.at(-1);
      const item = files[i];
      if (!filename || !item) throw new Error("File path is missing.");
      const stream = await (await parent.getFileHandle(filename, { create: true })).createWritable();
      try { await stream.write(item.file); } finally { await stream.close(); }
    }
    manifest.complete = true;
    await writeJSON(destination, ".homesafe-backup.json", manifest);
    return manifest;
  } catch (error) {
    try { await folder.removeEntry(targetName, { recursive: true }); }
    catch { throw new Error("Backup interrupted. An incomplete folder remains; remove or rename it before trying again.", { cause: error }); }
    throw error;
  }
}