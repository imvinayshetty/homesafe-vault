import { webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { ROOT_FOLDER, createBackup, dateCode, defaultBackupName, encryptIdentity, hasSameDate, registerProfile, requireUniqueName, safeSegment, validateBackupName, verifyEnvelope, verifyProfile, type BackupEntry, type Identity, type LocalDirectory } from "@/lib/local-backup";

beforeAll(() => { Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true }); });
async function identity(): Promise<Identity> {
  return { deviceId: crypto.randomUUID(), key: await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]) };
}
const day = new Date(2026, 10, 15, 12);
const entry: BackupEntry = { name: "Full_Bckup_151126", date: "151126", kind: "Full", files: 1, bytes: 20, complete: true };

describe("Local backup rules", () => {
  it("uses the required storage root", () => { expect(ROOT_FOLDER).toBe("HomeSafeBckup"); });
  it("formats dates as DDMMYY", () => { expect(dateCode(new Date(2026, 0, 2))).toBe("020126"); });
  it("names full backups Full_Bckup_DDMMYY", () => { expect(defaultBackupName("Full", day)).toBe("Full_Bckup_151126"); });
  it("names custom backups Custom_Bckup_DDMMYY", () => { expect(defaultBackupName("Custom", day)).toBe("Custom_Bckup_151126"); });
  it("detects any same-date backup including a different kind", () => { expect(hasSameDate([entry], day)).toBe(true); expect(hasSameDate([entry], new Date(2026, 10, 16))).toBe(false); });
  it("allows a renamed dated backup but not an unrelated name", () => { expect(validateBackupName("Custom_Bckup_151126_2", "Custom", day)).toBe("Custom_Bckup_151126_2"); expect(() => validateBackupName("elsewhere", "Custom", day)).toThrow(); });
  it("prevents existing backup overwrite, including case variants", () => { expect(() => requireUniqueName("full_bckup_151126", [entry.name])).toThrow("already exists"); });
  it("rejects profile and backup path traversal", () => { expect(() => safeSegment("../Vinay")).toThrow(); expect(() => safeSegment("..")).toThrow(); expect(safeSegment("Vinay")).toBe("Vinay"); });
  it("encrypts identity with AES-256-GCM and a non-exportable key", async () => {
    const device = await identity(); const encrypted = await encryptIdentity(device, "Vinay");
    expect(encrypted.algorithm).toBe("AES-256-GCM"); expect((device.key.algorithm as AesKeyAlgorithm).length).toBe(256); expect(device.key.extractable).toBe(false);
    expect(JSON.stringify(encrypted)).not.toContain(device.deviceId);
    await expect(verifyEnvelope(encrypted, device, "Vinay")).resolves.toBeUndefined();
  });
  it("rejects a different device", async () => { const device = await identity(); await expect(verifyEnvelope(await encryptIdentity(device, "Vinay"), await identity(), "Vinay")).rejects.toThrow("does not match"); });
  it("rejects a renamed profile", async () => { const device = await identity(); await expect(verifyEnvelope(await encryptIdentity(device, "Vinay"), device, "Asha")).rejects.toThrow("does not match"); });
  it("rejects tampered encryption", async () => { const device = await identity(); const encrypted = await encryptIdentity(device, "Vinay"); encrypted.ciphertext[0] = (encrypted.ciphertext[0] ?? 0) ^ 1; await expect(verifyEnvelope(encrypted, device, "Vinay")).rejects.toThrow(); });
  it("requires the exact root on reconnect", async () => { const device = await identity(); await expect(verifyProfile({ root: { name: "wrong" } as LocalDirectory, profile: "Vinay", identity: device })).rejects.toThrow("HomeSafeBckup"); });
  it("reports missing matching profile without creating it", async () => {
    let creates = 0;
    const root = { kind: "directory", name: ROOT_FOLDER, getDirectoryHandle: async (_name: string, options?: { create?: boolean }) => { if (options?.create) creates++; throw new Error("missing"); } } as LocalDirectory;
    await expect(verifyProfile({ root, profile: "Vinay", identity: await identity() })).rejects.toThrow("No matching profile"); expect(creates).toBe(0);
  });
  it("prevents replacing an existing profile identity", async () => {
    const root = { async *values() { yield { name: "Vinay", kind: "directory" }; } } as LocalDirectory;
    await expect(registerProfile(root, "vinay", await identity())).rejects.toThrow("already exists");
  });
  it("rejects backup before writes when the profile cannot be verified", async () => {
    let writes = 0;
    const root = { kind: "directory", name: ROOT_FOLDER, getDirectoryHandle: async (_name: string, options?: { create?: boolean }) => { if (options?.create) writes++; throw new Error("missing"); } } as LocalDirectory;
    await expect(createBackup({ root, profile: "Vinay", identity: await identity() }, "Full", entry.name, [{ file: new File(["photo"], "photo.jpg"), path: "photo.jpg" }], day, false)).rejects.toThrow("No matching profile"); expect(writes).toBe(0);
  });
});