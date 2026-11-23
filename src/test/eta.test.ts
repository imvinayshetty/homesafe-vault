import { describe, expect, it } from "vitest";
import { createEtaEstimator, formatEta } from "@/lib/eta";
import { parseSyncEvent } from "@/lib/vault-daemon";

describe("time left", () => {
  it("shows hours, minutes and seconds", () => {
    expect(formatEta(0)).toBe("0h 00m 00s");
    expect(formatEta(59.6)).toBe("0h 01m 00s");
    expect(formatEta(3725)).toBe("1h 02m 05s");
    expect(formatEta(36000 + 59 * 60 + 59)).toBe("10h 59m 59s");
  });
  it("is the bytes left over the speed, smoothed, and kept through a pause", () => {
    const e = createEtaEstimator();
    expect(e.update(0, 10_000_000, 1_000_000)).toBe("0h 00m 10s");
    expect(e.update(5_000_000, 10_000_000, 0)).toBe("0h 00m 05s");
    expect(e.update(10_000_000, 10_000_000, 1_000_000)).toBeNull();
    expect(createEtaEstimator().update(0, 100, 0)).toBeNull();
  });
  it("parses saving-to-drive events and ignores others", () => {
    expect(parseSyncEvent({ type: "sync_progress", bytes: 5, totalBytes: 10, bytesPerSecond: 2 })).toEqual({ phase: "saving", bytes: 5, totalBytes: 10, bytesPerSecond: 2 });
    expect(parseSyncEvent({ type: "sync_waiting" })).toEqual({ phase: "waiting" });
    expect(parseSyncEvent({ type: "sync_failed", reason: "x" })).toEqual({ phase: "failed", reason: "x" });
    expect(parseSyncEvent({ type: "sync_progress", bytes: -1 })).toEqual({ phase: "saving" });
    expect(parseSyncEvent({ type: "transfer_progress" })).toBeNull();
  });
});
