import { describe, expect, it } from "vitest";
import { backupSizeSummary, formatStorageBytes } from "@/lib/storage-health";
import type { CatalogEntry } from "@/lib/backup-catalog";

const entry: CatalogEntry = { profile: "Vinay", phone: "Pixel", name: "Full_Bckup_151126", kind: "Full", date: "151126", files: 2, bytes: 1024, complete: true };

describe("Storage health from backup records", () => {
  it("sums completed payloads across profiles and phones, not drive capacity", () => {
    const result = backupSizeSummary([entry, { ...entry, profile: "Asha", phone: "iPhone", bytes: 2048 }]);
    expect(result.bytes).toBe(3072);
    expect(result.count).toBe(2);
    expect(result).not.toHaveProperty("availableBytes");
  });
  it("groups sizes by date and backup type in chronological order", () => {
    expect(backupSizeSummary([entry, { ...entry, kind: "Custom", bytes: 512 }, { ...entry, date: "141126", bytes: 256 }]).days).toEqual([
      { date: "2026-11-14", full: 256, custom: 0, bytes: 256, count: 1 },
      { date: "2026-11-15", full: 1024, custom: 512, bytes: 1536, count: 2 },
    ]);
  });
  it("excludes incomplete and invalid sizes from trends", () => {
    const result = backupSizeSummary([entry, { ...entry, complete: false, bytes: 9000 }, { ...entry, bytes: -1 }, { ...entry, date: "311126" }]);
    expect(result.bytes).toBe(1024);
    expect(result.incomplete).toBe(1);
    expect(result.count).toBe(1);
  });
  it("returns an empty series rather than invented data", () => {
    expect(backupSizeSummary([])).toEqual({ bytes: 0, count: 0, incomplete: 0, days: [] });
  });
  it("formats byte sizes with binary units", () => {
    expect(formatStorageBytes(0)).toBe("0 B");
    expect(formatStorageBytes(1024)).toBe("1 KiB");
    expect(formatStorageBytes(1073741824)).toBe("1 GiB");
  });
});