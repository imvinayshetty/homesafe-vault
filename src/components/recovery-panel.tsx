import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { recoveryRequest, type RecoveryStatus } from "@/lib/vault-library";

/** Shows what the Vault keeps on the drive to survive a deleted app-data folder, and lets the owner turn on full recovery with a passphrase. */
export function RecoveryPanel({ getKey }: { getKey: () => Promise<string | null> }) {
  const [status, setStatus] = useState<RecoveryStatus | null>(null);
  const [pass, setPass] = useState(""), [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [open, setOpen] = useState(false);
  useEffect(() => { let live = true; void getKey().then(k => (k ? recoveryRequest(k) : null)).then(s => { if (live && s) setStatus(s); }).catch(() => {}); return () => { live = false; }; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!status) return null;
  const enable = async () => {
    setError("");
    if (pass.length < 12) return setError("Use a passphrase of at least 12 characters.");
    if (pass !== again) return setError("The two passphrases do not match.");
    setBusy(true);
    try { const k = await getKey(); if (!k) throw new Error("The Vault service is not running."); setStatus(await recoveryRequest(k, pass)); setPass(""); setAgain(""); setOpen(false); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not turn on recovery."); }
    finally { setBusy(false); }
  };
  return <section aria-label="Recovery" className="space-y-2 rounded-lg border border-border bg-card/60 p-3 text-sm">
    <p className="flex items-center gap-2 font-medium"><ShieldCheck className="h-4 w-4 text-primary" />Recovery copy on this drive</p>
    <p className="text-muted-foreground">{status.namesSaved ? `Saved: who owns each profile and phone (${status.phones} phone${status.phones === 1 ? "" : "s"}) and revoked phones. If this PC's Vault data is deleted, they come back from the drive, and each phone pairs again once.` : "Not saved yet."}</p>
    <p className="text-muted-foreground">{status.fullEnabled ? "Full recovery is on: the Vault's keys are on the drive, encrypted with your passphrase. After a reset, enter it once and phones keep working with no re-pairing." : "Full recovery is off: after a reset every phone must pair again."}</p>
    {!status.fullEnabled && !open && <Button type="button" variant="outline" onClick={() => setOpen(true)}>Turn on full recovery…</Button>}
    {open && <div className="space-y-2">
      <p className="text-xs text-muted-foreground">Choose a passphrase you will remember. Without it the keys cannot be restored. Anyone who has both this drive and the passphrase could act as your Vault, so keep it private.</p>
      <label className="block">Recovery passphrase<input type="password" autoComplete="new-password" value={pass} onChange={e => setPass(e.target.value)} className="mt-1 min-h-11 w-full rounded-md border border-input bg-background px-3" /></label>
      <label className="block">Repeat passphrase<input type="password" autoComplete="new-password" value={again} onChange={e => setAgain(e.target.value)} className="mt-1 min-h-11 w-full rounded-md border border-input bg-background px-3" /></label>
      <div className="flex gap-2"><Button type="button" disabled={busy} onClick={() => void enable()}>Save encrypted recovery copy</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => { setOpen(false); setError(""); }}>Cancel</Button></div>
    </div>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </section>;
}
