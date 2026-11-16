import { describe, expect, it } from "vitest";
import { applyDaemonEvent, parseDaemonEvent, type DaemonEvent, type TransferState } from "@/lib/vault-daemon";
const run = (events: DaemonEvent[], s: TransferState = { stage: 0 }) => events.reduce((a, e) => applyDaemonEvent(a, e, "Vinay", "My Pixel"), s);
describe("daemon transfer stages", () => {
  it("advances through all six stages only on real events", () => {
    expect(run([{ type: "phone_connecting" }, { type: "pairing_verified", profile: "Vinay", phone: "My Pixel" }, { type: "transfer_started" }, { type: "transfer_progress", files: 1, total: 2 }, { type: "transfer_completed" }]).stage).toBe(5);
  });
  it("stays awaiting with no events", () => expect(run([]).stage).toBe(0));
  it("ignores out-of-order completion", () => expect(run([{ type: "phone_connecting" }, { type: "transfer_completed" }]).stage).toBe(1));
  it("rejects pairing for a different phone", () => {
    const s = run([{ type: "phone_connecting" }, { type: "pairing_verified", profile: "Vinay", phone: "Other" }]);
    expect(s.stage).toBe(1); expect(s.failed).toMatch(/does not match/);
  });
  it("records failure at the stalled stage", () => {
    const s = run([{ type: "phone_connecting" }, { type: "pairing_verified", profile: "Vinay", phone: "My Pixel" }, { type: "transfer_started" }, { type: "transfer_failed", reason: "Drive full" }]);
    expect(s).toMatchObject({ stage: 3, failed: "Drive full" });
  });
  it("drops malformed messages", () => { expect(parseDaemonEvent("{bad")).toBeNull(); expect(parseDaemonEvent({ type: "pairing_verified" })).toBeNull(); });
});
