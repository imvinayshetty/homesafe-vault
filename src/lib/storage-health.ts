import { backupISODate, type CatalogEntry } from "./backup-catalog";

export interface BackupSizeDay { date: string; full: number; custom: number; bytes: number; count: number }

// Manifest sizes describe backup payloads, not filesystem usage or free drive space.
export function backupSizeSummary(entries: CatalogEntry[]) {
  const days = new Map<string, BackupSizeDay>();
  let bytes = 0;
  let count = 0;
  for (const entry of entries) {
    const date = backupISODate(entry.date);
    if (!entry.complete || !date || !Number.isFinite(entry.bytes) || entry.bytes < 0) continue;
    const day = days.get(date) ?? { date, full: 0, custom: 0, bytes: 0, count: 0 };
    if (entry.kind === "Full") day.full += entry.bytes;
    else day.custom += entry.bytes;
    day.bytes += entry.bytes;
    day.count++;
    days.set(date, day);
    bytes += entry.bytes;
    count++;
  }
  return { bytes, count, incomplete: entries.filter(e => !e.complete).length, days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

export function formatStorageBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exponent).toLocaleString(undefined, { maximumFractionDigits: exponent === 0 ? 0 : 1 })} ${units[exponent]}`;
}