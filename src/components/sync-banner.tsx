import { useRef } from "react";
import { createEtaEstimator } from "@/lib/eta";
import type { SyncState } from "@/lib/vault-daemon";

const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB/s`;

/** Where the last backup stands after the phone has finished: saving from this computer to the drive. */
export function SyncBanner({ sync }: { sync: SyncState | null }) {
  const eta = useRef(createEtaEstimator());
  if (!sync) return null;
  if (sync.phase === "done") return <p role="status" className="text-sm text-primary">The last backup is saved to your drive and verified.</p>;
  if (sync.phase === "failed") return <p role="alert" className="text-sm text-destructive">{sync.reason} It will be retried when the Vault restarts.</p>;
  if (sync.phase === "waiting") return <p role="status" className="text-sm text-warning">Waiting for your backup drive. The files are safe on this computer and will be saved when the drive is connected.</p>;
  if (sync.phase === "verifying") return <p role="status" className="text-sm text-muted-foreground">Checking the copy on your drive…</p>;
  const pct = sync.totalBytes ? Math.min(100, Math.round(((sync.bytes ?? 0) / sync.totalBytes) * 100)) : 0;
  const left = sync.totalBytes ? eta.current.update(sync.bytes ?? 0, sync.totalBytes, sync.bytesPerSecond) : null;
  return <p role="status" className="text-sm text-muted-foreground">Saving to your drive · {pct}%{sync.bytesPerSecond ? ` · ${mb(sync.bytesPerSecond)}` : ""}{left ? ` · ${left} left` : ""}. Your phone is already free.</p>;
}
