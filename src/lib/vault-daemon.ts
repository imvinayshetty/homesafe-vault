/** Contract with the local Vault service (runs on the PC/Pi, never the cloud). */
export const DAEMON_URL = "ws://127.0.0.1:7878/v1/transfer-events";

export type DaemonEvent =
  | { type: "phone_connecting" }
  | { type: "pairing_verified"; profile: string; phone: string }
  | { type: "transfer_started" }
  | { type: "transfer_progress"; files: number; total: number }
  | { type: "transfer_completed" }
  | { type: "transfer_failed"; reason: string };

export interface TransferState { stage: 0 | 1 | 2 | 3 | 4 | 5; failed?: string; progress?: number }

export function parseDaemonEvent(raw: unknown): DaemonEvent | null {
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!v || typeof v !== "object" || typeof v.type !== "string") return null;
    switch (v.type) {
      case "phone_connecting": case "transfer_started": case "transfer_completed": return { type: v.type };
      case "pairing_verified": return typeof v.profile === "string" && typeof v.phone === "string" ? { type: v.type, profile: v.profile, phone: v.phone } : null;
      case "transfer_progress": return Number.isFinite(v.files) && Number.isFinite(v.total) && v.total > 0 ? { type: v.type, files: v.files, total: v.total } : null;
      case "transfer_failed": return { type: v.type, reason: typeof v.reason === "string" ? v.reason.slice(0, 200) : "Unknown error" };
    }
  } catch { /* malformed */ }
  return null;
}

/** Advances only in order and only for the confirmed profile/phone; out-of-order events are ignored. */
export function applyDaemonEvent(s: TransferState, e: DaemonEvent, profile: string, phone: string): TransferState {
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
  }
}
