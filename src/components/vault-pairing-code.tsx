import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { KeyRound, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PAIRING_CODE_LIFETIME_MS, MINTED_PAIRING_CODE_LIFETIME_MS, type PairingCode } from "@/lib/vault-daemon";

/** Sample codes never authenticate; live codes and QR payloads originate only from the local service. */
export function VaultPairingCode({ sample, pairing, onMint }: { sample?: boolean; pairing?: PairingCode | null; onMint?: (() => void) | undefined }) {
  const [now, setNow] = useState(0);
  const [demo, setDemo] = useState<PairingCode | null>(null);
  const [qr, setQr] = useState("");
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
  const payload = !sample && active ? current.qr : undefined;
  useEffect(() => {
    if (!payload) { setQr(""); return; }
    let live = true;
    QRCode.toDataURL(payload, { margin: 1, width: 240, errorCorrectionLevel: "M" }).then(url => live && setQr(url)).catch(() => live && setQr(""));
    return () => { live = false; };
  }, [payload]);
  const seconds = active ? Math.ceil((current.expiresAt - now) / 1000) : 0;
  const lifetime = seconds > PAIRING_CODE_LIFETIME_MS / 1000 ? MINTED_PAIRING_CODE_LIFETIME_MS : PAIRING_CODE_LIFETIME_MS;
  const ring = 2 * Math.PI * 16, left = active ? Math.min(1, (seconds * 1000) / lifetime) : 0;
  return <div className="flex w-full shrink-0 flex-col items-center gap-3 border-t border-border pt-4 text-center sm:w-auto sm:flex-row sm:border-l sm:border-t-0 sm:pl-5 sm:pt-0" aria-label="Vault pairing code">
    {qr && <img src={qr} alt="Pairing QR code for the HomeSafe phone app" className="h-32 w-32 rounded-lg bg-card p-1.5" style={{ background: "white" }} />}
    <div className="space-y-2">
      <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground"><KeyRound className="h-4 w-4" />Vault pairing code</p>
      <div className="flex justify-center gap-1.5" aria-label={active ? `Pairing code ${current.code}` : "Pairing code unavailable"}>
        {(active ? current.code : "------").split("").map((digit, index) => <span key={index} className="grid h-11 w-8 place-items-center rounded-md border border-border bg-secondary font-mono text-2xl font-semibold text-primary">{digit}</span>)}
      </div>
      <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
        {active && <svg viewBox="0 0 36 36" className="h-5 w-5 -rotate-90" aria-hidden><circle cx="18" cy="18" r="16" fill="none" strokeWidth="4" className="stroke-muted" /><circle cx="18" cy="18" r="16" fill="none" strokeWidth="4" strokeLinecap="round" className="stroke-primary transition-[stroke-dashoffset] duration-1000 ease-linear" strokeDasharray={ring} strokeDashoffset={ring * (1 - left)} /></svg>}
        {active ? `Expires in ${seconds}s` : "Waiting for a code from the local Vault service"}
      </p>
      {onMint && <Button type="button" size="sm" variant="secondary" onClick={onMint}><Smartphone />Pair mobile device</Button>}
      {sample && <p className="text-xs text-warning">Sample code · cannot pair a phone</p>}
    </div>
  </div>;
}
