import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { PAIRING_CODE_LIFETIME_MS, type PairingCode } from "@/lib/vault-daemon";

/** Sample codes never authenticate; live codes originate only from the local service. */
export function VaultPairingCode({ sample, pairing }: { sample?: boolean; pairing?: PairingCode | null }) {
  const [now, setNow] = useState(0);
  const [demo, setDemo] = useState<PairingCode | null>(null);
  useEffect(() => {
    const tick = () => {
      const time = Date.now();
      setNow(time);
      if (sample) setDemo(previous => previous && previous.expiresAt > time ? previous : {
        code: String(Math.floor(Math.random() * 1e6)).padStart(6, "0"),
        expiresAt: time + PAIRING_CODE_LIFETIME_MS,
      });
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [sample]);
  const current = sample ? demo : pairing;
  const active = current && current.expiresAt > now;
  const seconds = active ? Math.ceil((current.expiresAt - now) / 1000) : 0;
  return <div className="w-full shrink-0 space-y-3 border-t border-border pt-5 text-center sm:w-64 sm:border-l sm:border-t-0 sm:pl-5 sm:pt-0" aria-label="Vault pairing code">
    <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground"><KeyRound className="h-4 w-4" />Vault pairing code</p>
    <div className="flex justify-center gap-1.5" aria-label={active ? `Pairing code ${current.code}` : "Pairing code unavailable"}>
      {(active ? current.code : "------").split("").map((digit, index) => <span key={index} className="grid h-12 w-8 place-items-center rounded-md border border-border bg-secondary font-mono text-2xl font-semibold text-primary">{digit}</span>)}
    </div>
    <p className="text-xs text-muted-foreground">{active ? `Fresh code in ${seconds}s` : "Waiting for a code from the local Vault service"}</p>
    {sample && <p className="text-xs text-warning">Sample code · cannot pair a phone</p>}
  </div>;
}