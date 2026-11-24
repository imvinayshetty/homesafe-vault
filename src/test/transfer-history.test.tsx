import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TransferHistory } from "@/components/transfer-history";
import { parseTransferHistory, type TransferRecord } from "@/lib/transfer-history";
import { applyDaemonEvent, parseDaemonEvent } from "@/lib/vault-daemon";

afterEach(cleanup);
const row: TransferRecord = { id: "t1", profile: "Vinay", phone: "Pixel", name: "Full_Bckup_231126", kind: "Full", startedAt: "2026-11-23T01:00:00Z", updatedAt: "2026-11-23T01:05:00Z", completedAt: "2026-11-23T01:05:00Z", status: "failed", manifestReceived: 2, totalFiles: 2, receivedFiles: 2, receivedBytes: 6, totalBytes: 6, failureCode: "integrity_mismatch", failureReason: "Backup files do not match the saved manifest.", integrity: { status: "mismatch", checkedFiles: 2, mismatchCount: 1, issues: [{ path: "b.txt", reason: "checksum", expectedBytes: 3, actualBytes: 3 }] } };
describe("transfer history", () => {
  it("shows manifest progress, received bytes and mismatch details", () => {
    const verify = vi.fn();
    render(<TransferHistory backups={[row]} online onVerify={verify} />);
    expect(screen.getByText("2 / 2 entries")).toBeTruthy();
    expect(screen.getByText("6 B / 6 B")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("integrity_mismatch");
    fireEvent.click(screen.getByRole("button", { name: /Mismatch details/ }));
    expect(screen.getByText("b.txt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Recheck files/ }));
    expect(verify).toHaveBeenCalledWith("t1");
  });
  it("rejects records whose received bytes exceed the total", () => {
    expect(parseTransferHistory({ type: "transfer_history", backups: [{ ...row, receivedBytes: 7 }] })).toBeNull();
  });
  it("tracks verification only while transferring", () => {
    const e = parseDaemonEvent({ type: "transfer_verifying", checkedFiles: 1, total: 2 });
    if (!e) throw new Error("missing");
    expect(applyDaemonEvent({ stage: 4 }, e, "a", "b").verifying).toEqual({ checkedFiles: 1, total: 2 });
    expect(applyDaemonEvent({ stage: 2 }, e, "a", "b").verifying).toBeUndefined();
  });
});