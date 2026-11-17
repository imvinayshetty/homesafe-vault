import { useEffect, useState } from "react";
import { HardDrive, Link, Unplug, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TransferStatus } from "@/components/transfer-status";
import { FlowScreen } from "@/components/flow-screen";
import { safeSegment } from "@/lib/local-backup";

type VaultDesktop = { isDesktop: true; getAccessKey: () => Promise<string | null>; status: () => Promise<{ running: boolean; error: string }> };
const desktop = () => (typeof window === "undefined" ? undefined : (window as unknown as { vaultDesktop?: VaultDesktop }).vaultDesktop);
/** Profile name remembered per Authy-verified account on this PC (not a secret), so linking a new phone skips it. */
export const profileKey = (email: string) => `homesafe-vault-profile:${email}`;

type Step = "profile" | "phone" | "access";
export function LocalVaultConnection({ email, onReady, onProfile }: { email: string; onReady?: (ready: boolean) => void; onProfile?: (profile: string) => void }) {
  const [saved, setSaved] = useState<string | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [profile, setProfile] = useState("");
  const [phone, setPhone] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [destination, setDestination] = useState<{ profile: string; phone: string; email: string; accessKey: string } | null>(null);
  const [error, setError] = useState("");
  const [desktopNote, setDesktopNote] = useState("");
  useEffect(() => {
    const stored = email ? localStorage.getItem(profileKey(email)) : null;
    setSaved(stored); setProfile(stored ?? ""); setStep(stored ? "phone" : "profile");
    onProfile?.(stored ?? "");
  }, [email]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = (key: string) => {
    const p = safeSegment(profile);
    localStorage.setItem(profileKey(email), p); setSaved(p);
    setDestination({ profile: p, phone: safeSegment(phone), email, accessKey: key }); onReady?.(true);
  };
  useEffect(() => {
    const d = desktop();
    if (step !== "access" || !d) return;
    let live = true;
    setDesktopNote("Connecting to the Vault service on this PC…");
    d.getAccessKey().then(async key => {
      if (!live) return;
      if (key && /^[A-Za-z0-9_-]{43}$/.test(key)) { open(key); setDesktopNote(""); }
      else { const st = await d.status(); setDesktopNote(st.error ? `Vault service not running: ${st.error}` : "Vault service not running. Restart the HomeSafe Vault app."); }
    }).catch(() => live && setDesktopNote("Could not reach the Vault service on this PC."));
    return () => { live = false; };
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps
  const inputClass = "mt-2 min-h-11 w-full rounded-md border border-input bg-background px-3";
  if (!step) return null;
  if (destination) return <section aria-labelledby="live-vault-heading" className="space-y-4 py-2">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="live-vault-heading" className="flex items-center gap-2 font-display text-2xl"><HardDrive className="h-5 w-5 text-primary" />Local Vault monitoring</h2><Button variant="outline" onClick={() => { setDestination(null); setAccessKey(""); setPhone(""); setStep("phone"); onReady?.(false); }}><Unplug />Disconnect dashboard</Button></div>
    <TransferStatus {...destination} />
  </section>;
  const steps: Step[] = saved ? ["phone", "access"] : ["profile", "phone", "access"];
  const n = steps.indexOf(step) + 1;
  const titles: Record<Step, string> = { profile: "Name your profile", phone: "Name this phone", access: "Connect your local Vault" };
  return <FlowScreen key={step} title={titles[step]} eyebrow={`${saved ? "Link a phone" : "Vault connection"} · Step ${n} of ${steps.length}`}>
    <form className="space-y-4" onSubmit={e => {
      e.preventDefault();
      try {
        if (step === "profile") { safeSegment(profile); onProfile?.(profile.trim()); setStep("phone"); }
        else if (step === "phone") { safeSegment(phone); setStep("access"); }
        else { if (!/^[A-Za-z0-9_-]{43}$/.test(accessKey)) throw new Error("Enter the local access key issued by your Vault service."); open(accessKey); }
        setError("");
      } catch (err) { setError(err instanceof Error ? err.message : "Check your destination."); }
    }}>
      {step === "profile" ? <>
        <p className="text-sm text-muted-foreground">First time on this Vault. Your backups are kept in a folder with this name.</p>
        <label className="block text-sm">Profile name<input required autoFocus value={profile} onChange={e => setProfile(e.target.value)} className={inputClass} /></label>
        <Button type="submit" className="min-h-12 w-full" disabled={!profile.trim()}>Continue<ArrowRight /></Button>
      </> : step === "phone" ? <>
        <p className="text-sm text-muted-foreground">Give the phone you're linking a name, for example “Vinay's Pixel”.</p>
        <label className="block text-sm">Phone name<input required autoFocus value={phone} onChange={e => setPhone(e.target.value)} className={inputClass} /></label>
        <Button type="submit" className="min-h-12 w-full" disabled={!phone.trim()}>Continue<ArrowRight /></Button>
        {!saved && <Button variant="ghost" type="button" className="w-full" onClick={() => { setError(""); setStep("profile"); }}>Back to profile name</Button>}
      </> : <>
        <p className="break-words text-sm text-muted-foreground">{profile} · {phone}</p>
        {desktopNote && <p role="status" className="text-sm text-muted-foreground">{desktopNote}</p>}
        {!desktop() && <>
          <label className="block text-sm">Local service access key<input required type="password" autoComplete="off" value={accessKey} onChange={e => setAccessKey(e.target.value)} className={inputClass} /></label>
          <p className="text-sm text-muted-foreground">Use the owner access key from the Vault service on your PC or Raspberry Pi.</p>
          <Button type="submit" className="min-h-12 w-full" disabled={!accessKey.trim()}><Link />Open monitoring</Button>
        </>}
        <Button variant="ghost" type="button" className="w-full" onClick={() => { setError(""); setStep("phone"); }}>Back to phone name</Button>
      </>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </form>
  </FlowScreen>;
}
