import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Loader2, Smartphone, Wifi } from "lucide-react";
import { DAEMON_URL, MINTED_PAIRING_CODE_LIFETIME_MS, applyDaemonEvent, parseDaemonEvent, type PairingCode, type TransferState } from "@/lib/vault-daemon";
import { VaultPairingCode } from "@/components/vault-pairing-code";

export function transferSteps(profile: string, phone: string): string[] {
  return ["Awaiting connection", "Establishing connection", `Code success verified for ${profile} ${phone}`, "Initiating Transfer", "Transfer in progress", "Backup Completed"];
}

/** Stage advances only from events sent by the local Vault service over the loopback socket. */
export function TransferStatus({ profile, phone, email = "", accessKey = "" }: { profile: string; phone: string; email?: string; accessKey?: string }) {
  const [state, setState] = useState<TransferState>({ stage: 0 });
  const [pairing, setPairing] = useState<PairingCode | null>(null);
  const [service, setService] = useState<"checking" | "online" | "offline">("checking");
  const stateRef = useRef(state);
  const socketRef = useRef<WebSocket | null>(null);
  const [serviceError, setServiceError] = useState("");
  useEffect(() => {
    setPairing(null);
    stateRef.current = { stage: 0 }; setState({ stage: 0 }); setServiceError("");
    let ws: WebSocket | null = null; let retry: ReturnType<typeof setTimeout>; let stopped = false;
    const open = () => {
      try { ws = new WebSocket(DAEMON_URL); } catch { setService("offline"); return; }
      socketRef.current = ws;
      ws.onopen = () => { ws?.send(JSON.stringify({ type: "authenticate", token: accessKey })); };
      ws.onclose = (event) => { setService("offline"); setPairing(null); if (event.code === 1008) setServiceError("Local access key was rejected. Disconnect and enter the key from your Vault service."); if (!stopped && event.code !== 1008) { (window as unknown as { vaultDesktop?: { ensureRunning?: () => Promise<unknown> } }).vaultDesktop?.ensureRunning?.().catch(() => {}); retry = setTimeout(open, 4000); } };
      ws.onmessage = (m) => {
        try {
          const message = JSON.parse(String(m.data));
          if (message.type === "service_ready") { setService("online"); ws?.send(JSON.stringify({ type: "select_destination", profile, phone, email })); return; }
          if (message.type === "service_error") { setServiceError(String(message.reason)); return; }
        } catch { return; }
        const e = parseDaemonEvent(m.data); if (!e) return;
        if (e.type === "pairing_code") {
          setPairing({ code: e.code, expiresAt: Math.min(e.expiresAt, Date.now() + MINTED_PAIRING_CODE_LIFETIME_MS), ...(e.qr ? { qr: e.qr } : {}), ...(e.fingerprint ? { fingerprint: e.fingerprint } : {}) });
          return;
        }
        if (e.type === "phone_connecting") { setPairing(null); if (stateRef.current.stage > 1) return; }
        const prev = stateRef.current; const next = applyDaemonEvent(prev, e, profile, phone);
        if (next === prev) return;
        stateRef.current = next; setState(next);
        // Activity is recorded locally by the service, not cloud analytics.
      };
    };
    open();
    return () => { stopped = true; clearTimeout(retry); ws?.close(); };
  }, [profile, phone, email, accessKey]);
  if (state.stage === 0 && !state.failed) return <><AwaitingCard service={service} profile={profile} phone={phone} pairing={pairing} onMint={service === "online" ? () => socketRef.current?.send(JSON.stringify({ type: "mint_pairing" })) : undefined} />{serviceError && <p role="alert" className="text-sm text-destructive">{serviceError}</p>}</>;
  return <TransferScreen state={state} profile={profile} phone={phone} service={service} onClose={state.failed || state.stage === 5 ? () => { socketRef.current?.send(JSON.stringify({ type: "reset" })); stateRef.current = { stage: 0 }; setState({ stage: 0 }); } : undefined} />;
}

type Service = "checking" | "online" | "offline";
const serviceLabel = (s: Service) => s === "online" ? "Local Vault service connected" : s === "checking" ? "Looking for local Vault service…" : "Local Vault service not running";

/** Compact dashboard section shown while waiting for the phone. */
export function AwaitingCard({ service, profile, phone, sample, action, pairing, onMint }: { service: Service; profile: string; phone: string; sample?: boolean; action?: ReactNode; pairing?: PairingCode | null; onMint?: (() => void) | undefined }) {
  return (
    <section className="flex flex-col items-center gap-4 rounded-2xl border border-border bg-card/60 p-4 text-center sm:p-5 lg:flex-row lg:text-left">
      <div className="relative grid h-24 w-24 shrink-0 place-items-center">
        {[0, 1, 2].map(k => <span key={k} className="tx-ripple absolute inset-2 rounded-full border-2 border-primary" style={{ animationDelay: `${k * 0.8}s` }} />)}
        <span className="grid h-16 w-16 place-items-center rounded-full bg-accent"><Smartphone className="tx-float h-8 w-8 text-primary" /></span>
      </div>
      <div className="flex-1 space-y-1">
        <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">{sample ? "Sample · " : ""}{profile} · {phone}</p>
        <h3 className="font-display text-2xl">Awaiting connection<span className="inline-block animate-pulse">…</span></h3>
        <p className="text-sm text-muted-foreground">Open the HomeSafe app on your phone and scan the QR code, or enter the Vault code. The transfer screen opens as soon as your phone connects.</p>
        <p className={`flex items-center justify-center gap-2 text-xs sm:justify-start ${service === "online" ? "text-primary" : "text-muted-foreground"}`}><span className={`h-2 w-2 rounded-full ${service === "online" ? "bg-primary pulse-dot" : "bg-muted-foreground"}`} />{serviceLabel(service)}</p>
      </div>
      <VaultPairingCode sample={sample ?? false} pairing={pairing ?? null} onMint={onMint} />
      {action}
    </section>
  );
}

/** Full-screen payment-style transfer animation, from Establishing connection onwards. */
export function TransferScreen({ state, profile, phone, service, onClose, sample }: { state: TransferState; profile: string; phone: string; service: Service; onClose?: (() => void) | undefined; sample?: boolean }) {
  const { stage, failed, progress } = state;
  const steps = transferSteps(profile, phone);
  const pct = Math.round((progress ?? 0) * 100);
  const done = stage === 5 && !failed;
  const verifiedOnly = stage === 2 && !failed;
  const subtitle = failed ? `Backup stopped: ${failed}`
    : stage === 0 ? "Open the HomeSafe app on your phone and enter the Vault code"
    : stage === 1 ? "Securing a private link over your home Wi-Fi"
    : stage === 2 ? "Phone identity confirmed · choose Full or Custom backup on your phone"
    : stage === 3 ? "Preparing the phone folder on your drive"
    : stage === 4 ? `${pct}% copied to ${ROOTLESS(profile, phone)}`
    : "Every file is saved on your local drive";
  const R = 88, C = 2 * Math.PI * R;
  const ring = stage === 4 ? pct / 100 : stage >= 5 ? 1 : stage === 3 ? 0.08 : 0;
  if (typeof document === "undefined") return null;
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Transfer status" className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 overflow-y-auto bg-background p-6 text-center sm:p-10" aria-live="polite">
      <div className="flex w-full flex-wrap items-center justify-between gap-2 text-left">
        <h3 className="flex items-center gap-2 font-medium"><Wifi className="h-4 w-4 text-primary" />Transfer status{sample && <span className="rounded-full border border-warning/50 px-2 py-0.5 text-xs text-warning">Sample</span>}</h3>
        <span className={`flex items-center gap-2 text-xs ${service === "online" ? "text-primary" : "text-muted-foreground"}`}><span className={`h-2 w-2 rounded-full ${service === "online" ? "bg-primary pulse-dot" : "bg-muted-foreground"}`} />{sample ? "Demonstration only" : serviceLabel(service)}</span>
      </div>
      <div className="w-full max-w-4xl flex-1" aria-hidden />
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
      {onClose && <button onClick={onClose} className="min-h-11 rounded-full bg-primary px-8 text-sm font-semibold text-primary-foreground hover:opacity-90">{failed ? "Back to dashboard" : stage === 5 ? "Done" : "Close sample"}</button>}
      <p className="text-xs text-muted-foreground">{sample ? "Sample preview · no phone or drive is connected." : "This screen moves only when the local Vault service on this computer reports progress."}</p>
      <div className="flex-1" aria-hidden />
    </div>
  , document.body);
}
function ROOTLESS(profile: string, phone: string) { return `${profile}/${phone}`; }
