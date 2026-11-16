import { useState } from "react";
import { HardDrive, Link, Unplug, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TransferStatus } from "@/components/transfer-status";
import { FlowScreen } from "@/components/flow-screen";
import { safeSegment } from "@/lib/local-backup";

export function LocalVaultConnection({ onReady }: { onReady?: (ready: boolean) => void }) {
  const [step, setStep] = useState<"destination" | "access">("destination");
  const [profile, setProfile] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [destination, setDestination] = useState<{ profile: string; phone: string; email: string; accessKey: string } | null>(null);
  const [error, setError] = useState("");
  const inputClass = "mt-2 min-h-11 w-full rounded-md border border-input bg-background px-3";
  if (destination) return <section aria-labelledby="live-vault-heading" className="space-y-5 py-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="live-vault-heading" className="flex items-center gap-2 font-display text-2xl"><HardDrive className="h-5 w-5 text-primary" />Local Vault monitoring</h2><Button variant="outline" onClick={() => { setDestination(null); setAccessKey(""); setStep("destination"); onReady?.(false); }}><Unplug />Disconnect dashboard</Button></div>
    <TransferStatus {...destination} />
  </section>;
  return <FlowScreen key={step} title={step === "destination" ? "Choose your phone" : "Connect your local Vault"} eyebrow={step === "destination" ? "Vault connection · Step 1 of 2" : "Vault connection · Step 2 of 2"}>
    <form className="space-y-6" onSubmit={e => {
      e.preventDefault();
      try {
        if (step === "destination") { safeSegment(profile); safeSegment(phone); setStep("access"); }
        else { if (!/^[A-Za-z0-9_-]{43}$/.test(accessKey)) throw new Error("Enter the local access key issued by your Vault service."); setDestination({ profile: safeSegment(profile), phone: safeSegment(phone), email: email.trim().toLowerCase(), accessKey }); onReady?.(true); }
        setError("");
      } catch (err) { setError(err instanceof Error ? err.message : "Check your destination."); }
    }}>
      {step === "destination" ? <>
        <label className="block text-sm">HomeSafe account email<input required type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" className={inputClass} /></label>
        <label className="block text-sm">Profile name<input required value={profile} onChange={e => setProfile(e.target.value)} className={inputClass} /></label>
        <label className="block text-sm">Phone name<input required value={phone} onChange={e => setPhone(e.target.value)} className={inputClass} /></label>
        <Button type="submit" className="min-h-12 w-full" disabled={!email.trim() || !profile.trim() || !phone.trim()}>Continue<ArrowRight /></Button>
      </> : <>
        <p className="break-words text-sm text-muted-foreground">{profile} · {phone}</p>
        <label className="block text-sm">Local service access key<input required type="password" autoComplete="off" value={accessKey} onChange={e => setAccessKey(e.target.value)} className={inputClass} /></label>
        <p className="text-sm text-muted-foreground">Use the owner access key from the Vault service on your PC or Raspberry Pi.</p>
        <Button type="submit" className="min-h-12 w-full" disabled={!accessKey.trim()}><Link />Open monitoring</Button>
        <Button variant="ghost" type="button" className="w-full" onClick={() => { setError(""); setStep("destination"); }}>Back to phone selection</Button>
      </>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </form>
  </FlowScreen>;
}
