import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { VaultPairingCode } from "@/components/vault-pairing-code";
import { applyDaemonEvent, groupFingerprint, parseDaemonEvent, PAIRING_CODE_LIFETIME_MS } from "@/lib/vault-daemon";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
describe("Vault pairing code lifetime", () => {
  it("rotates the sample after 30 seconds, not before", () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    vi.spyOn(Math, "random").mockReturnValueOnce(0.123456).mockReturnValue(0.654321);
    const { container } = render(<VaultPairingCode sample />);
    expect(container.querySelector('[aria-label="Pairing code 123456"]')).not.toBeNull();
    act(() => vi.advanceTimersByTime(29_000));
    expect(container.querySelector('[aria-label="Pairing code 123456"]')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1000));
    expect(container.querySelector('[aria-label="Pairing code 654321"]')).not.toBeNull();
    expect(PAIRING_CODE_LIFETIME_MS).toBe(30_000);
  });
  it("expires a live code rather than generating a replacement", () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    const { container } = render(<VaultPairingCode pairing={{ code: "012345", expiresAt: 130_000 }} />);
    expect(container.querySelector('[aria-label="Pairing code 012345"]')).not.toBeNull();
    act(() => vi.advanceTimersByTime(30_000));
    expect(container.querySelector('[aria-label="Pairing code unavailable"]')).not.toBeNull();
  });
  it("accepts only six-digit service codes and never advances transfer stages for a code", () => {
    const event = parseDaemonEvent({ type: "pairing_code", code: "012345", expiresAt: 130_000 });
    expect(event).toEqual({ type: "pairing_code", code: "012345", expiresAt: 130_000 });
    expect(parseDaemonEvent({ type: "pairing_code", code: "12345", expiresAt: 130_000 })).toBeNull();
    const state = { stage: 0 } as const;
    if (!event) throw new Error("Missing event");
    expect(applyDaemonEvent(state, event, "Vinay", "Pixel 8")).toBe(state);
  });
});describe("Manual pairing fallback", () => {
  const fp = "ab".repeat(32);
  it("shows the https address on port 7443 and the grouped fingerprint", () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    const { container } = render(<VaultPairingCode pairing={{ code: "012345", expiresAt: 130_000, host: "192.168.1.108", port: 7443, fingerprint: fp, certExpiresAt: 100_000 + 400 * 86_400_000 }} />);
    expect(container.textContent).toContain("https://192.168.1.108:7443");
    expect(container.textContent).toContain(groupFingerprint(fp));
    expect(groupFingerprint(fp).split(" ")).toHaveLength(16);
    expect(container.textContent).not.toContain("expires soon");
  });
  it("warns when the certificate expires within 60 days", () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    const { container } = render(<VaultPairingCode pairing={{ code: "012345", expiresAt: 130_000, host: "192.168.1.108", port: 7443, fingerprint: fp, certExpiresAt: 100_000 + 59 * 86_400_000 }} />);
    expect(container.textContent).toContain("expires soon");
  });
  it("parses host, port and certificate expiry from the service event", () => {
    expect(parseDaemonEvent({ type: "pairing_code", code: "012345", expiresAt: 1, host: "192.168.1.108", port: 7443, certExpiresAt: 5 })).toEqual({ type: "pairing_code", code: "012345", expiresAt: 1, host: "192.168.1.108", port: 7443, certExpiresAt: 5 });
    expect(parseDaemonEvent({ type: "pairing_code", code: "012345", expiresAt: 1, host: "<script>", port: 99999 })).toEqual({ type: "pairing_code", code: "012345", expiresAt: 1 });
  });
});
