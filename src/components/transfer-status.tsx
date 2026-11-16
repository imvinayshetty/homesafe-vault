import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, Smartphone, Wifi } from "lucide-react";
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
  const pct = Math.round((progress ?? 0) * 100);
  const done = stage === 5 && !failed;
  const verifiedOnly = stage === 2 && !failed;
  const tone = failed ? "text-destructive" : "text-primary";
  const subtitle = failed ? `Backup stopped: ${failed}`
    : stage === 0 ? "Open the HomeSafe app on your phone and enter the Vault code"
    : stage === 1 ? "Securing a private link over your home Wi-Fi"
    : stage === 2 ? "Phone identity confirmed · choose Full or Custom backup on your phone"
    : stage === 3 ? "Preparing the phone folder on your drive"
    : stage === 4 ? `${pct}% copied to ${ROOTLESS(profile, phone)}`
    : "Every file is saved on your local drive";
  const R = 88, C = 2 * Math.PI * R;
  const ring = stage === 4 ? pct / 100 : stage >= 5 ? 1 : stage === 3 ? 0.08 : 0;
  return (
    <div className="flex h-full flex-col items-center gap-6 rounded-2xl border border-border bg-card/60 p-6 text-center sm:p-10" aria-live="polite">
      <div className="flex w-full flex-wrap items-center justify-between gap-2 text-left">
        <h3 className="flex items-center gap-2 font-medium"><Wifi className="h-4 w-4 text-primary" />Transfer status</h3>
        <span className={`flex items-center gap-2 text-xs ${service === "online" ? "text-primary" : "text-muted-foreground"}`}><span className={`h-2 w-2 rounded-full ${service === "online" ? "bg-primary pulse-dot" : "bg-muted-foreground"}`} />{service === "online" ? "Local Vault service connected" : service === "checking" ? "Looking for local Vault service…" : "Local Vault service not running"}</span>
      </div>
      <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">{profile} · {phone}</p>
      <div className="relative grid h-56 w-56 place-items-center sm:h-64 sm:w-64">
        {!failed && !done && stage <= 1 && <>{[0, 1, 2].map(k => <span key={k} className="tx-ripple absolute inset-6 rounded-full border-2 border-primary" style={{ animationDelay: `${k * 0.8}s` }} />)}</>}
        {done && [0, 1, 2, 3, 4, 5, 6, 7].map(k => <span key={k} className="tx-spark absolute h-2 w-2 rounded-full bg-primary" style={{ ["--a" as string]: `${k * 45}deg` }} />)}
        <svg viewBox="0 0 200 200" className="absolute inset-0 h-full w-full -rotate-90">
          <circle cx="100" cy="100" r={R} className="fill-none stroke-muted" strokeWidth="6" />
          {stage === 1 && !failed && <circle cx="100" cy="100" r={R} className="tx-spin fill-none stroke-primary" strokeWidth="6" strokeLinecap="round" strokeDasharray={`${C * 0.25} ${C}`} style={{ transformOrigin: "100px 100px" }} />}
          {(stage >= 3 || failed) && <circle cx="100" cy="100" r={R} className={`fill-none ${failed ? "stroke-destructive" : "stroke-primary"} transition-[stroke-dashoffset] duration-700`} strokeWidth="6" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - (failed ? 1 : ring))} />}
        </svg>
        <div key={`${stage}-${Boolean(failed)}`} className={`tx-pop grid h-32 w-32 place-items-center rounded-full sm:h-36 sm:w-36 ${failed ? "bg-destructive/15" : done || verifiedOnly ? "bg-primary text-primary-foreground shadow-[0_0_60px_-10px_var(--primary)]" : "bg-accent"}`}>
          {failed ? <AlertTriangle className="h-14 w-14 text-destructive" />
            : done || verifiedOnly ? <svg viewBox="0 0 52 52" className="h-16 w-16"><path d="M14 27 l8 8 l16 -18" className="tx-check fill-none stroke-current" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            : stage === 4 ? <span className="font-mono text-4xl font-medium text-primary">{pct}<span className="text-xl">%</span></span>
            : stage === 0 ? <Smartphone className="h-14 w-14 text-primary tx-float" />
            : <Loader2 className="h-12 w-12 animate-spin text-primary" />}
        </div>
      </div>
      <div className="space-y-2">
        <h4 key={stage} className={`tx-fade font-display text-2xl sm:text-3xl ${failed ? "text-destructive" : "text-foreground"}`}>{failed ? "Backup could not finish" : steps[stage]}{!failed && stage === 0 && <span className="inline-block animate-pulse">…</span>}</h4>
        <p className={`text-sm ${failed ? "text-destructive" : "text-muted-foreground"}`} role={failed ? "alert" : undefined}>{subtitle}</p>
      </div>
      <ol className="flex w-full max-w-md items-center gap-1.5" aria-label={`Step ${stage + 1} of 6`}>
        {steps.map((label, i) => <li key={i} title={label} className={`h-1.5 flex-1 rounded-full transition-colors duration-500 ${failed && i === stage ? "bg-destructive" : i < stage || (i === stage && (i === 2 || i === 5)) ? "bg-primary" : i === stage ? "bg-primary/50 animate-pulse" : "bg-muted"}`}><span className="sr-only">{label}</span></li>)}
      </ol>
      <p className={`text-xs text-muted-foreground ${tone === "text-primary" ? "" : ""}`}>Start the backup from the HomeSafe app on your phone. This screen moves only when the local Vault service on this computer reports progress.</p>
    </div>
  );
}
function ROOTLESS(profile: string, phone: string) { return `${profile}/${phone}`; }
