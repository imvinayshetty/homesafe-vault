import { Check, Loader2, Wifi } from "lucide-react";

export type TransferStage = 0 | 1 | 2 | 3 | 4 | 5;

export function transferSteps(profile: string, phone: string): string[] {
  return [
    "Awaiting connection",
    "Establishing connection",
    `Code success verified for ${profile} ${phone}`,
    "Initiating Transfer",
    "Transfer in progress",
    "Backup Completed",
  ];
}

/** Stage only advances from real events reported by the local Vault service; nothing is simulated here. */
export function TransferStatus({ profile, phone, stage = 0 }: { profile: string; phone: string; stage?: TransferStage }) {
  const steps = transferSteps(profile, phone);
  return (
    <div className="space-y-4" aria-live="polite">
      <h3 className="flex items-center gap-2 font-medium"><Wifi className="h-4 w-4 text-primary" />Transfer status</h3>
      <ol className="space-y-1">
        {steps.map((label, i) => {
          const done = i < stage || (i === stage && (i === 2 || i === 5));
          const active = i === stage && !done;
          return (
            <li key={i} className={`relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-all duration-500 ${active ? "bg-accent text-foreground" : done ? "text-primary" : "text-muted-foreground opacity-60"}`}>
              <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border ${done ? "border-primary bg-primary text-primary-foreground" : active ? "border-primary text-primary" : "border-border"}`}>
                {done ? <Check className="h-4 w-4" /> : active ? (i === 0 ? <span className="h-2.5 w-2.5 rounded-full bg-primary pulse-dot" /> : <Loader2 className="h-4 w-4 animate-spin" />) : <span className="text-xs">{i + 1}</span>}
              </span>
              <span className={active ? "font-medium" : ""}>{label}{active && i === 0 && <span className="ml-1 inline-block animate-pulse">…</span>}</span>
              {active && i === 4 && <span className="ml-auto h-1.5 w-20 overflow-hidden rounded-full bg-muted"><span className="block h-full w-1/2 animate-pulse rounded-full bg-primary" /></span>}
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-muted-foreground">Start the backup from the HomeSafe app on your phone once it connects. Choosing Full or Custom backup happens on the phone. Progress here updates only when the local Vault service reports it.</p>
    </div>
  );
}
