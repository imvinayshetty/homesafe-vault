import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, Wifi } from "lucide-react";
import { DAEMON_URL, applyDaemonEvent, parseDaemonEvent, type TransferState } from "@/lib/vault-daemon";

export function transferSteps(profile: string, phone: string): string[] {
  return ["Awaiting connection", "Establishing connection", `Code success verified for ${profile} ${phone}`, "Initiating Transfer", "Transfer in progress", "Backup Completed"];
}
const STAGE_NAMES = ["awaiting", "connecting", "verified", "initiating", "in_progress", "completed"] as const;

/** Stage advances only from events sent by the local Vault service over the loopback socket. */
export function TransferStatus({ profile, phone }: { profile: string; phone: string }) {
  const [state, setState] = useState<TransferState>({ stage: 0 });
  const [service, setService] = useState<"checking" | "online" | "offline">("checking");
  const stateRef = useRef(state);
  useEffect(() => {
    let ws: WebSocket | null = null; let retry: ReturnType<typeof setTimeout>; let stopped = false;
    const open = () => {
      try { ws = new WebSocket(`${DAEMON_URL}?profile=${encodeURIComponent(profile)}&phone=${encodeURIComponent(phone)}`); } catch { setService("offline"); return; }
      ws.onopen = () => setService("online");
      ws.onclose = () => { setService("offline"); if (!stopped) retry = setTimeout(open, 10000); };
      ws.onmessage = (m) => {
        const e = parseDaemonEvent(m.data); if (!e) return;
        const prev = stateRef.current; const next = applyDaemonEvent(prev, e, profile, phone);
        if (next === prev) return;
        stateRef.current = next; setState(next);
        const track = window.__lovableEvents?.track;
        if (next.failed && !prev.failed) track?.("project.backup_transfer_failed", { stage: STAGE_NAMES[next.stage] });
        else if (next.stage === 2 && prev.stage !== 2) track?.("project.phone_paired", {});
        else if (next.stage === 3 && prev.stage !== 3) track?.("project.backup_transfer_started", {});
        else if (next.stage === 5 && prev.stage !== 5) track?.("project.backup_transfer_completed", {});
      };
    };
    open();
    return () => { stopped = true; clearTimeout(retry); ws?.close(); };
  }, [profile, phone]);
  const { stage, failed, progress } = state;
  const steps = transferSteps(profile, phone);
  return (
    <div className="space-y-4" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"><h3 className="flex shrink-0 items-center gap-2 font-medium"><Wifi className="h-4 w-4 text-primary" />Transfer status</h3><span className={`text-xs ${service === "online" ? "text-primary" : "text-muted-foreground"}`}>{service === "online" ? "Local Vault service connected" : service === "checking" ? "Looking for local Vault service…" : "Local Vault service not running"}</span></div>
      <ol className="space-y-1">
        {steps.map((label, i) => {
          const done = i < stage || (i === stage && (i === 2 || i === 5));
          const stalled = Boolean(failed) && i === stage;
          const active = i === stage && !done && !stalled;
          return (
            <li key={i} className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-all duration-500 ${stalled ? "bg-destructive/10 text-destructive" : active ? "bg-accent text-foreground" : done ? "text-primary" : "text-muted-foreground opacity-60"}`}>
              <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border ${stalled ? "border-destructive" : done ? "border-primary bg-primary text-primary-foreground" : active ? "border-primary text-primary" : "border-border"}`}>
                {stalled ? <AlertTriangle className="h-4 w-4" /> : done ? <Check className="h-4 w-4" /> : active ? (i === 0 ? <span className="h-2.5 w-2.5 rounded-full bg-primary pulse-dot" /> : <Loader2 className="h-4 w-4 animate-spin" />) : <span className="text-xs">{i + 1}</span>}
              </span>
              <span className={active || stalled ? "font-medium" : ""}>{label}{active && i === 0 && <span className="ml-1 inline-block animate-pulse">…</span>}</span>
              {active && i === 4 && <span className="ml-auto h-1.5 w-20 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-primary transition-all" style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} /></span>}
            </li>
          );
        })}
      </ol>
      {failed && <p role="alert" className="text-sm text-destructive">Backup stopped: {failed}</p>}
      <p className="text-xs text-muted-foreground">Start the backup from the HomeSafe app on your phone once it connects. Choosing Full or Custom backup happens on the phone. Progress here updates only when the local Vault service on this computer reports it.</p>
    </div>
  );
}
