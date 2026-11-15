import { type BackupEntry, type LocalDirectory } from "./local-backup";

export interface CatalogEntry extends BackupEntry { profile: string; phone?: string }
export interface Catalog { entries: CatalogEntry[]; profiles: string[]; warnings: string[] }
export interface BackupFilters { profile: string; phone?: string; kind: string; date: string }
export type StorageIssue = "disconnected" | "permission" | "space" | "unreadable";

export function storageIssue(error: unknown): StorageIssue {
  if (error instanceof Error && error.cause) return storageIssue(error.cause);
  const name = error && typeof error === "object" && "name" in error && typeof error.name === "string" ? error.name : "";
  if (name === "QuotaExceededError") return "space";
  if (name === "NotAllowedError" || name === "SecurityError") return "permission";
  if (["NotFoundError", "InvalidStateError", "NotReadableError"].includes(name)) return "disconnected";
  return "unreadable";
}
export function storageWarning(issue: StorageIssue): string {
  switch (issue) {
    case "space": return "Storage space is low or exhausted. Free space on the selected drive and retry; the browser may also have reached a write limit.";
    case "permission": return "Storage access is not allowed. Reconnect the saved profile or locate HomeSafeBckup and grant folder access.";
    case "disconnected": return "Selected storage is disconnected or unavailable. Reconnect the drive, then check storage or locate HomeSafeBckup again.";
    case "unreadable": return "Selected storage could not be read. Check the drive and folder permissions, then try again.";
  }
}
export function backupISODate(code: string): string {
  if (!/^\d{6}$/.test(code)) return "";
  const day = Number(code.slice(0, 2));
  const month = Number(code.slice(2, 4));
  const year = 2000 + Number(code.slice(4));
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
export function filterBackups(entries: CatalogEntry[], filters: BackupFilters): CatalogEntry[] {
  return entries.filter(e => (!filters.profile || e.profile === filters.profile) && (!filters.phone || e.phone === filters.phone) && (!filters.kind || e.kind === filters.kind) && (!filters.date || backupISODate(e.date) === filters.date));
}
export function validManifest(value: unknown): value is BackupEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Partial<BackupEntry>;
  return typeof e.date === "string" && Boolean(backupISODate(e.date)) && (e.kind === "Full" || e.kind === "Custom") && typeof e.files === "number" && Number.isSafeInteger(e.files) && e.files >= 0 && typeof e.bytes === "number" && Number.isFinite(e.bytes) && e.bytes >= 0 && typeof e.complete === "boolean";
}
export async function scanCatalog(root: LocalDirectory): Promise<Catalog> {
  if (await root.queryPermission({ mode: "readwrite" }) !== "granted") throw new DOMException("Folder permission required", "NotAllowedError");
  const result: Catalog = { entries: [], profiles: [], warnings: [] };
  async function readBackup(backup: LocalDirectory, profile: string, phone?: string) {
    const path = [profile, phone, backup.name].filter(Boolean).join("/");
    try {
      const manifest: unknown = JSON.parse(await (await (await backup.getFileHandle(".homesafe-backup.json")).getFile()).text());
      if (!validManifest(manifest)) throw new Error("Invalid backup record");
      result.entries.push({ ...manifest, name: backup.name, profile, ...(phone ? { phone } : {}) });
    } catch (error) {
      if (["space", "permission"].includes(storageIssue(error))) throw error;
      result.warnings.push(`Unreadable backup folder: ${path}. Its backup record is missing, damaged or inaccessible; it is excluded from results.`);
    }
  }
  for await (const profile of root.values()) {
    if (profile.kind !== "directory") continue;
    result.profiles.push(profile.name);
    try {
      for await (const child of profile.values()) {
        if (child.kind !== "directory") continue;
        // Legacy snapshots remain readable, never moved or renamed automatically.
        if (/^(Full|Custom)_Bckup_/i.test(child.name)) { await readBackup(child, profile.name); continue; }
        try {
          for await (const backup of child.values()) {
            if (backup.kind === "directory") await readBackup(backup, profile.name, child.name);
          }
        } catch (error) {
          if (storageIssue(error) === "space" || storageIssue(error) === "permission") throw error;
          result.warnings.push(`Unreadable phone folder: ${profile.name}/${child.name}. Check its permissions and drive connection.`);
        }
      }
    } catch (error) {
      if (storageIssue(error) === "space" || storageIssue(error) === "permission") throw error;
      result.warnings.push(`Unreadable profile folder: ${profile.name}. Check its permissions and drive connection.`);
    }
  }
  result.profiles.sort((a, b) => a.localeCompare(b));
  result.entries.sort((a, b) => backupISODate(b.date).localeCompare(backupISODate(a.date)) || a.profile.localeCompare(b.profile) || a.name.localeCompare(b.name));
  return result;
}