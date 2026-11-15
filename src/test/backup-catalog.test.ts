import { describe, expect, it } from "vitest";
import { File as NodeFile } from "node:buffer";
import { backupISODate, filterBackups, scanCatalog, storageIssue, validManifest, type CatalogEntry } from "@/lib/backup-catalog";
import type { LocalDirectory } from "@/lib/local-backup";

const full: CatalogEntry = { profile: "Vinay", name: "Full_Bckup_151126", kind: "Full", date: "151126", files: 2, bytes: 100, complete: true };
const custom: CatalogEntry = { ...full, profile: "Asha", name: "Custom_Bckup_141126", kind: "Custom", date: "141126" };
const rows = [full, custom, { ...custom, profile: "Vinay" }];

function directory(name: string, children: LocalDirectory[] = [], record?: unknown): LocalDirectory {
  return {
    kind: "directory", name,
    async *values() { yield* children; },
    queryPermission: async () => "granted", requestPermission: async () => "granted",
    getDirectoryHandle: async n => { const child = children.find(c => c.name === n); if (!child) throw new DOMException("Missing", "NotFoundError"); return child; },
    getFileHandle: async n => { if (record === undefined) throw new DOMException("Missing", "NotFoundError"); return { kind: "file", name: n, getFile: async () => new NodeFile([JSON.stringify(record)], n) as unknown as File, createWritable: async () => { throw new Error("Read only test"); } }; },
    removeEntry: async () => { throw new Error("Read only test"); },
  };
}
describe("Saved backup filters", () => {
  it("filters named phones without including legacy profile-level records", () => {
    const pixel = { ...full, phone: "Pixel" };
    expect(filterBackups([full, pixel, { ...full, phone: "iPhone" }], { profile: "Vinay", phone: "Pixel", kind: "", date: "" })).toEqual([pixel]);
  });
  it("reads new phone folders and legacy snapshots without moving either", async () => {
    const root = directory("HomeSafeBckup", [directory("Vinay", [directory(full.name, [], full), directory("Pixel", [directory(full.name, [], full)])])]);
    const result = await scanCatalog(root);
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map(e => e.phone)).toEqual([undefined, "Pixel"]);
    expect(result.warnings).toEqual([]);
  });
  it("filters by profile", () => { expect(filterBackups(rows, { profile: "Asha", kind: "", date: "" })).toEqual([custom]); });
  it("filters by backup type", () => { expect(filterBackups(rows, { profile: "", kind: "Full", date: "" })).toEqual([full]); });
  it("filters by exact calendar date", () => { expect(filterBackups(rows, { profile: "", kind: "", date: "2026-11-15" })).toEqual([full]); });
  it("combines all filters", () => { expect(filterBackups(rows, { profile: "Vinay", kind: "Custom", date: "2026-11-14" })).toEqual([rows[2]]); });
  it("returns no results for a nonmatching combination", () => { expect(filterBackups(rows, { profile: "Asha", kind: "Full", date: "" })).toEqual([]); });
  it("clearing filters returns every backup", () => { expect(filterBackups(rows, { profile: "", kind: "", date: "" })).toEqual(rows); });
  it("rejects impossible dates instead of normalizing them", () => { expect(backupISODate("311126")).toBe(""); expect(backupISODate("020126")).toBe("2026-01-02"); });
});
describe("Storage warnings", () => {
  it("classifies disconnected storage", () => { expect(storageIssue(new DOMException("Removed", "NotFoundError"))).toBe("disconnected"); });
  it("classifies low-space write errors", () => { expect(storageIssue(new DOMException("Disk full", "QuotaExceededError"))).toBe("space"); });
  it("retains low-space cause after cleanup failure", () => { expect(storageIssue(new Error("Cleanup failed", { cause: new DOMException("Disk full", "QuotaExceededError") }))).toBe("space"); });
  it("distinguishes revoked permission", () => { expect(storageIssue(new DOMException("Denied", "NotAllowedError"))).toBe("permission"); });
  it("reports unreadable folders while retaining other backups", async () => {
    const root = directory("HomeSafeBckup", [directory("Vinay", [directory(full.name, [], full), directory("Custom_Bckup_151126")]), directory("Asha", [directory(custom.name, [], custom)])]);
    const result = await scanCatalog(root);
    expect(result.entries.map(e => e.profile)).toEqual(["Vinay", "Asha"]);
    expect(result.profiles).toEqual(["Asha", "Vinay"]);
    expect(result.warnings).toHaveLength(1); expect(result.warnings[0]).toContain("Vinay/Custom_Bckup_151126");
  });
  it("rejects malformed backup records", () => { expect(validManifest({ ...full, files: -1 })).toBe(false); expect(validManifest({ ...full, date: "311126" })).toBe(false); expect(validManifest(full)).toBe(true); });
  it("refuses scans without folder permission", async () => { const root = directory("HomeSafeBckup"); root.queryPermission = async () => "denied"; await expect(scanCatalog(root)).rejects.toMatchObject({ name: "NotAllowedError" }); });
  it("surfaces disconnected root instead of returning an empty list", async () => { const root = directory("HomeSafeBckup"); root.values = async function* () { throw new DOMException("Gone", "NotFoundError"); }; await expect(scanCatalog(root)).rejects.toMatchObject({ name: "NotFoundError" }); });
});