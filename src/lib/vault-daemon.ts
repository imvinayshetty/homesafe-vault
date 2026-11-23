/** Contract with the local Vault service (runs on the PC/Pi, never the cloud). */
export const DAEMON_URL = "ws://127.0.0.1:7878/v1/transfer-events";
export const PAIRING_CODE_LIFETIME_MS = 30_000;
/** "Pair Mobile Device" codes are single-use and last two minutes. */
export const MINTED_PAIRING_CODE_LIFETIME_MS = 120_000;
export interface PairingCode { code: string; expiresAt: number; qr?: string; fingerprint?: string; host?: string; port?: number; certExpiresAt?: number }
/** Warn this long before the Vault's phone certificate expires. */
export const CERT_WARNING_MS = 60 * 86_400_000;
/** "ab12cd…" → "AB12 CD34 …" for reading aloud / comparing on the phone. */
export const groupFingerprint = (fp: string) => fp.toUpperCase().match(/.{1,4}/g)?.join(" ") ?? "";
export const manualAddress = (p: Pick<PairingCode, "host" | "port">) => p.host && p.port ? `https://${p.host}:${p.port}` : null;

export type DaemonEvent =
  | ({ type: "pairing_code" } & PairingCode)
  | { type: "phone_connecting" }
  | { type: "pairing_verified"; profile: string; phone: string }
  | { type: "transfer_started" }
  | { type: "transfer_progress"; files: number; total: number }
  | { type: "transfer_completed" }
  | { type: "transfer_verifying"; checkedFiles: number; total: number }
  | { type: "transfer_failed"; reason: string };

export interface TransferState { stage: 0 | 1 | 2 | 3 | 4 | 5; failed?: string; progress?: number; verifying?: { checkedFiles: number; total: number } }

export function parseDaemonEvent(raw: unknown): DaemonEvent | null {
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!v || typeof v !== "object" || typeof v.type !== "string") return null;
    switch (v.type) {
      case "pairing_code": {
        if (typeof v.code !== "string" || !/^\d{6}$/.test(v.code) || !Number.isFinite(v.expiresAt)) return null;
        const e: DaemonEvent = { type: v.type, code: v.code, expiresAt: v.expiresAt };
        if (typeof v.qr === "string" && v.qr.startsWith("homesafe://pair?") && v.qr.length < 1000) e.qr = v.qr;
        if (typeof v.fingerprint === "string" && /^[a-f0-9]{64}$/.test(v.fingerprint)) e.fingerprint = v.fingerprint;
        if (typeof v.host === "string" && /^[a-zA-Z0-9.:-]{1,253}$/.test(v.host)) e.host = v.host;
        if (Number.isInteger(v.port) && v.port > 0 && v.port < 65536) e.port = v.port;
        if (Number.isFinite(v.certExpiresAt)) e.certExpiresAt = v.certExpiresAt;
        return e;
      }
      case "phone_connecting": case "transfer_started": case "transfer_completed": return { type: v.type };
      case "pairing_verified": return typeof v.profile === "string" && typeof v.phone === "string" ? { type: v.type, profile: v.profile, phone: v.phone } : null;
      case "transfer_progress": return Number.isFinite(v.files) && Number.isFinite(v.total) && v.total > 0 ? { type: v.type, files: v.files, total: v.total } : null;
      case "transfer_verifying": return Number.isSafeInteger(v.checkedFiles) && Number.isSafeInteger(v.total) && v.checkedFiles >= 0 && v.total > 0 && v.checkedFiles <= v.total ? { type: v.type, checkedFiles: v.checkedFiles, total: v.total } : null;
      case "transfer_failed": return { type: v.type, reason: typeof v.reason === "string" ? v.reason.slice(0, 200) : "Unknown error" };
    }
  } catch { /* malformed */ }
  return null;
}

/** Advances only in order and only for the confirmed profile/phone; out-of-order events are ignored. */
export function applyDaemonEvent(s: TransferState, e: DaemonEvent, profile: string, phone: string): TransferState {
  if (e.type === "pairing_code") return s;
  if (e.type === "transfer_failed") return s.stage === 5 ? s : { ...s, failed: e.reason };
  if (s.failed || s.stage === 5) return e.type === "phone_connecting" ? { stage: 1 } : s;
  switch (e.type) {
    case "phone_connecting": return s.stage === 0 ? { stage: 1 } : s;
    case "pairing_verified":
      if (s.stage !== 1) return s;
      if (e.profile.toLowerCase() !== profile.toLowerCase() || e.phone.toLowerCase() !== phone.toLowerCase()) return { ...s, failed: "Paired phone does not match the confirmed profile and phone folder." };
      return { stage: 2 };
    case "transfer_started": return s.stage === 2 ? { stage: 3 } : s;
    case "transfer_progress": return s.stage === 3 || s.stage === 4 ? { stage: 4, progress: Math.min(1, e.files / e.total) } : s;
    case "transfer_completed": return s.stage === 4 ? { stage: 5, progress: 1 } : s;
    case "transfer_verifying": return s.stage === 4 ? { ...s, verifying: { checkedFiles: e.checkedFiles, total: e.total } } : s;
  }
}
