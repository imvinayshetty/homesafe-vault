import { webcrypto } from "node:crypto";
import { File as NodeFile } from "node:buffer";
import { beforeAll, describe, expect, it } from "vitest";
import { ROOT_FOLDER, createBackup, dateCode, defaultBackupName, encryptIdentity, hasSameDate, registerProfile, registerPhone, requireUniqueName, safeSegment, validateBackupName, verifyEnvelope, verifyProfile, type BackupEntry, type Identity, type LocalDirectory, type LocalFileHandle } from "@/lib/local-backup";

beforeAll(() => { Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true }); });
async function identity(): Promise<Identity> {
  return { deviceId: crypto.randomUUID(), key: await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]) };
}
const day = new Date(2026, 10, 15, 12);
const entry: BackupEntry = { name: "Full_Bckup_151126", date: "151126", kind: "Full", files: 1, bytes: 20, complete: true };
function missingProfileRoot(onCreate: () => void): LocalDirectory {
  return {
    kind: "directory", name: ROOT_FOLDER,
    getDirectoryHandle: async (_name, options) => { if (options?.create) onCreate(); throw new Error("missing"); },
    getFileHandle: async () => { throw new Error("missing"); },
    async *values() { /* Empty storage. */ },
    queryPermission: async () => "granted",
    requestPermission: async () => "granted",
    removeEntry: async () => { throw new Error("missing"); },
  };
}

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
    const root = missingProfileRoot(() => { creates++; });
    await expect(verifyProfile({ root, profile: "Vinay", identity: await identity() })).rejects.toThrow("No matching profile"); expect(creates).toBe(0);
  });
  it("prevents replacing an existing profile identity", async () => {
    const root = { async *values() { yield { name: "Vinay", kind: "directory" }; } } as LocalDirectory;
    await expect(registerProfile(root, "vinay", await identity())).rejects.toThrow("already exists");
  });
  it("rejects backup before writes when the profile cannot be verified", async () => {
    let writes = 0;
    const root = missingProfileRoot(() => { writes++; });
    await expect(createBackup({ root, profile: "Vinay", phone: "Pixel", identity: await identity() }, "Full", entry.name, [{ file: new File(["photo"], "photo.jpg"), path: "photo.jpg" }], day, false)).rejects.toThrow("No matching profile"); expect(writes).toBe(0);
  });
});

function memoryFolder(name: string): LocalDirectory {
  const children = new Map<string, LocalDirectory | LocalFileHandle>();
  return {
    kind: "directory", name, async *values() { yield* children.values(); },
    queryPermission: async () => "granted", requestPermission: async () => "granted",
    async getDirectoryHandle(n, options) {
      const found = children.get(n);
      if (found?.kind === "directory") return found;
      if (found || !options?.create) throw new DOMException("Missing", "NotFoundError");
      const child = memoryFolder(n); children.set(n, child); return child;
    },
    async getFileHandle(n, options) {
      const found = children.get(n);
      if (found?.kind === "file") return found;
      if (found || !options?.create) throw new DOMException("Missing", "NotFoundError");
      let data: Blob | string = "";
      const child: LocalFileHandle = { kind: "file", name: n, getFile: async () => new NodeFile([data as string], n) as unknown as File, createWritable: async () => ({ write: async value => { data = typeof value === "string" ? value : await value.text(); }, close: async () => {} }) };
      children.set(n, child); return child;
    },
    async removeEntry(n) { children.delete(n); },
  };
}
describe("Named phone destinations", () => {
  it("writes only under HomeSafeBckup/profile/phone and reads the actual file back", async () => {
    const root = memoryFolder(ROOT_FOLDER), device = await identity();
    await registerPhone(root, "Vinay", "Pixel", device);
    const enrollment = { root, profile: "Vinay", phone: "Pixel", identity: device };
    await createBackup(enrollment, "Full", entry.name, [{ file: new NodeFile(["real photo"], "photo.jpg") as unknown as File, path: "photo.jpg" }], day, false);
    const phone = await (await root.getDirectoryHandle("Vinay")).getDirectoryHandle("Pixel");
    expect(await (await (await (await phone.getDirectoryHandle("Full_Bckup_151126")).getFileHandle("photo.jpg")).getFile()).text()).toBe("real photo");
    await expect((await root.getDirectoryHandle("Vinay")).getDirectoryHandle(entry.name)).rejects.toThrow();
  });
  it("rejects duplicate phone names case-insensitively without replacing identity", async () => {
    const root = memoryFolder(ROOT_FOLDER), device = await identity();
    await registerPhone(root, "Vinay", "My Pixel", device);
    await expect(registerPhone(root, "Vinay", "my pixel", await identity())).rejects.toThrow("already exists");
    await expect(verifyProfile({ root, profile: "Vinay", phone: "My Pixel", identity: device })).resolves.toBeDefined();
  });
  it("binds identity to both profile and phone name", async () => {
    const device = await identity();
    const encrypted = await encryptIdentity(device, "Vinay/Pixel");
    await expect(verifyEnvelope(encrypted, device, "Vinay/iPhone")).rejects.toThrow();
    await expect(verifyEnvelope(encrypted, device, "Asha/Pixel")).rejects.toThrow();
  });
  it("allows multiple distinct phones within one profile", async () => {
    const root = memoryFolder(ROOT_FOLDER), device = await identity();
    await registerPhone(root, "Vinay", "Pixel", device);
    await registerPhone(root, "Vinay", "iPhone", device);
    const names = [];
    for await (const child of (await root.getDirectoryHandle("Vinay")).values()) names.push(child.name);
    expect(names).toEqual(["Pixel", "iPhone"]);
  });
  it("keeps legacy profile backups untouched and blocks new writes there", async () => {
    const root = memoryFolder(ROOT_FOLDER), device = await identity();
    await registerProfile(root, "Vinay", device);
    await expect(createBackup({ root, profile: "Vinay", identity: device }, "Full", entry.name, [{ file: new File(["x"], "x"), path: "x" }], day, false)).rejects.toThrow("named phone");
    await expect(verifyProfile({ root, profile: "Vinay", identity: device })).resolves.toBeDefined();
  });
});