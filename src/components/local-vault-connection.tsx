import { useEffect, useState } from "react";
import { HardDrive, Link, Unplug, ArrowRight, FolderCheck, Smartphone, UserRound } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { fetchLibrary, type Library } from "@/lib/vault-library";
import { RecoveryPanel } from "@/components/recovery-panel";
import { Button } from "@/components/ui/button";
import { TransferStatus } from "@/components/transfer-status";
import { FlowScreen } from "@/components/flow-screen";
import { safeSegment } from "@/lib/local-backup";

export type LocationInfo = { path: string | null; source?: "auto" | "chosen"; connected: boolean; problem?: string; freeBytes?: number; totalBytes?: number };
type VaultDesktop = { isDesktop: true; getAccessKey: () => Promise<string | null>; status: () => Promise<{ running: boolean; error: string }>; getLocation?: () => Promise<LocationInfo>; changeLocation?: () => Promise<LocationInfo> };
const joinPath = (root: string, ...parts: string[]) => `${root}${root.includes("\\") ? "\\" : "/"}${parts.join(root.includes("\\") ? "\\" : "/")}`;
const when = (iso: string) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "unknown date");
const size = (b: number) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : `${(b / 1048576).toFixed(1)} MB`);
const gb = (n?: number) => (typeof n === "number" ? `${(n / 1024 ** 3).toFixed(1)} GB` : "unknown");
const desktop = () => (typeof window === "undefined" ? undefined : (window as unknown as { vaultDesktop?: VaultDesktop }).vaultDesktop);
/** Profile name remembered per Authy-verified account on this PC (not a secret), so linking a new phone skips it. */
export const profileKey = (email: string) => `homesafe-vault-profile:${email}`;

type Step = "profile" | "phone" | "location" | "access";
export function LocalVaultConnection({ email, onReady, onProfile }: { email: string; onReady?: (ready: boolean) => void; onProfile?: (profile: string) => void }) {
  const [saved, setSaved] = useState<string | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [profile, setProfile] = useState("");
  const [phone, setPhone] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [destination, setDestination] = useState<{ profile: string; phone: string; email: string; accessKey: string } | null>(null);
  const [error, setError] = useState("");
  const [desktopNote, setDesktopNote] = useState("");
  const [location, setLocation] = useState<LocationInfo | null>(null);
  const [locationBusy, setLocationBusy] = useState(false);
  const [library, setLibrary] = useState<Library | null>(null);
  const [liveLocation, setLiveLocation] = useState<LocationInfo | null>(null);
  const [switching, setSwitching] = useState("");
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
  // What this account may see on the drive: its own phones and past backups, and only the names of other profiles.
  useEffect(() => {
    const d = desktop();
    if (!d || (step !== "profile" && step !== "phone") || !email) return;
    let live = true; setLibrary(null);
    void d.getAccessKey().then(async key => {
      if (!live || !key) return;
      const lib = await fetchLibrary(key, email, step === "phone" ? profile : undefined);
      if (!live || !lib) return;
      setLibrary(lib);
      if (step === "profile" && lib.yourProfiles[0]) { const p = lib.yourProfiles[0]; localStorage.setItem(profileKey(email), p); setSaved(p); setProfile(p); onProfile?.(p); setStep("phone"); }
    }).catch(() => {});
    return () => { live = false; };
  }, [step, email]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!destination) return;
    let live = true;
    void desktop()?.getLocation?.().then(l => live && setLiveLocation(l)).catch(() => {});
    return () => { live = false; };
  }, [destination]);
  const switchProfile = async (name: string) => {
    setSwitching(name);
    await supabase.auth.signOut(); // Back to sign-in: the owner of that profile enters their account and Authy code.
  };
  useEffect(() => {
    const d = desktop();
    if (step !== "location" || !d?.getLocation) return;
    let live = true; setLocation(null);
    d.getLocation().then(l => live && setLocation(l)).catch(() => live && setLocation({ path: null, connected: false, problem: "Could not read the backup location from the Vault app." }));
    return () => { live = false; };
  }, [step]);
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
  if (destination) return <section aria-labelledby="live-vault-heading" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain py-2">
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3"><div className="min-w-0"><h2 id="live-vault-heading" className="flex items-center gap-2 font-display text-2xl"><HardDrive className="h-5 w-5 text-primary" />Local Vault monitoring</h2>{liveLocation?.path && <p className="mt-1 break-all text-sm text-muted-foreground">Saving to <span className="font-medium text-foreground">{joinPath(liveLocation.path, destination.profile, destination.phone)}</span> · {liveLocation.source === "auto" ? "found automatically" : "chosen by you"}{liveLocation.connected ? "" : " · drive not connected"}</p>}</div><Button variant="outline" onClick={() => { setDestination(null); setAccessKey(""); setPhone(""); setStep("phone"); onReady?.(false); }}><Unplug />Disconnect dashboard</Button></div>
    <TransferStatus {...destination} />
  </section>;
  const hasLocation = !!desktop()?.getLocation;
  const steps: Step[] = [...(saved ? [] : ["profile" as Step]), "phone", ...(hasLocation ? ["location" as Step] : []), "access"];
  const n = steps.indexOf(step) + 1;
  const titles: Record<Step, string> = { profile: "Name your profile", phone: "Name this phone", location: "Confirm backup location", access: "Connect your local Vault" };
  return <FlowScreen key={step} title={titles[step]} eyebrow={`${saved ? "Link a phone" : "Vault connection"} · Step ${n} of ${steps.length}`}>
    <form className="space-y-4" onSubmit={e => {
      e.preventDefault();
      try {
        if (step === "profile") { safeSegment(profile); onProfile?.(profile.trim()); setStep("phone"); }
        else if (step === "phone") { safeSegment(phone); setStep(hasLocation ? "location" : "access"); }
        else if (step === "location") { if (!location?.connected) throw new Error(location?.problem ?? "The backup drive is not connected."); setStep("access"); }
        else { if (!/^[A-Za-z0-9_-]{43}$/.test(accessKey)) throw new Error("Enter the local access key issued by your Vault service."); open(accessKey); }
        setError("");
      } catch (err) { setError(err instanceof Error ? err.message : "Check your destination."); }
    }}>
      {step === "profile" ? <>
        <p className="text-sm text-muted-foreground">First time on this Vault. Your backups are kept in a folder with this name.</p>
        <label className="block text-sm">Profile name<input required autoFocus value={profile} onChange={e => setProfile(e.target.value)} className={inputClass} /></label>
        <Button type="submit" className="min-h-12 w-full" disabled={!profile.trim()}>Continue<ArrowRight /></Button>
      </> : step === "phone" ? <>
        {library && library.phones.length > 0 && <div className="space-y-2" aria-label="Your phones">
          <p className="text-sm font-medium">Your phones and past backups</p>
          {library.phones.map(p => <button type="button" key={p.phone} onClick={() => setPhone(p.phone)} aria-pressed={phone === p.phone} className={`w-full rounded-lg border p-3 text-left text-sm ${phone === p.phone ? "border-primary bg-accent" : "border-border"}`}>
            <span className="flex items-center gap-2 font-medium"><Smartphone className="h-4 w-4 text-primary" />{p.phone}{p.revoked && <span className="text-xs text-destructive">revoked</span>}</span>
            <span className="block text-xs text-muted-foreground">{p.backups.length ? `${p.backups.length} backups · latest ${p.backups[0]?.name} (${when(p.backups[0]?.date ?? "")})` : "No backups yet"}</span>
            {phone === p.phone && p.backups.slice(0, 5).map(b => <span key={b.name} className="mt-1 block text-xs">{b.name} · {when(b.date)} · {b.files.toLocaleString()} files · {size(b.bytes)}{b.complete ? "" : " · incomplete"}</span>)}
          </button>)}
        </div>}
        <p className="text-sm text-muted-foreground">{library && library.phones.length ? "Pick one of your phones above, or name a new phone, for example “Vinay's Pixel”." : "Give the phone you're linking a name, for example “Vinay's Pixel”."}</p>
        <label className="block text-sm">Phone name<input required autoFocus value={phone} onChange={e => setPhone(e.target.value)} className={inputClass} /></label>
        <Button type="submit" className="min-h-12 w-full" disabled={!phone.trim()}>Continue<ArrowRight /></Button>
        {!saved && <Button variant="ghost" type="button" className="w-full" onClick={() => { setError(""); setStep("profile"); }}>Back to profile name</Button>}
        {library && library.otherProfiles.length > 0 && <div className="space-y-2 border-t border-border pt-4" aria-label="Other profiles">
          <p className="text-sm font-medium">Other profiles on this Vault</p>
          <p className="text-xs text-muted-foreground">Only the names are shown. To open one, sign in with that profile's account and its Authy code.</p>
          {library.otherProfiles.map(n => <Button key={n} type="button" variant="outline" className="w-full justify-between" disabled={!!switching} onClick={() => void switchProfile(n)}><span className="flex items-center gap-2"><UserRound className="h-4 w-4" />{n}</span><span className="text-xs">{switching === n ? "Signing out…" : "Switch · Authy"}</span></Button>)}
        </div>}
      </> : step === "location" ? <>
        <p className="break-words text-sm text-muted-foreground">{profile} · {phone}</p>
        {!location ? <p role="status" className="text-sm text-muted-foreground">Checking the backup drive…</p> : <div className="space-y-2 rounded-lg border border-border bg-card/60 p-3 text-sm">
          <p className="flex items-center gap-2 font-medium"><FolderCheck className="h-4 w-4 text-primary" />Backups for this phone will be saved in</p>
          <p className="break-all text-base font-medium">{location.path ? joinPath(location.path, profile, phone) : "No backup location set"}</p>
          <p className="text-muted-foreground">{location.source === "auto" ? "Found automatically on a connected drive." : "Chosen by you."}{location.connected ? ` Free space: ${gb(location.freeBytes)} of ${gb(location.totalBytes)}.` : ""}</p>
          {!location.connected && <p role="alert" className="text-destructive">{location.problem ?? "The backup drive is not connected."}</p>}
        </div>}
        {desktop() && <RecoveryPanel getKey={() => desktop()!.getAccessKey()} />}
        <Button type="submit" className="min-h-12 w-full" disabled={!location?.connected}>Yes, this is correct<ArrowRight /></Button>
        <Button variant="outline" type="button" className="w-full" disabled={locationBusy || !desktop()?.changeLocation} onClick={async () => { setLocationBusy(true); try { setLocation(await desktop()!.changeLocation!()); } catch { setError("Backup location not changed."); } finally { setLocationBusy(false); } }}>Change location…</Button>
        {!location?.connected && <Button variant="ghost" type="button" className="w-full" onClick={() => { setLocation(null); void desktop()?.getLocation?.().then(setLocation); }}>Check again</Button>}
        <Button variant="ghost" type="button" className="w-full" onClick={() => { setError(""); setStep("phone"); }}>Back to phone name</Button>
      </> : <>
        <p className="break-words text-sm text-muted-foreground">{profile} · {phone}</p>
        {desktopNote && <p role="status" className="text-sm text-muted-foreground">{desktopNote}</p>}
        {!desktop() && <>
          <label className="block text-sm">Local service access key<input required type="password" autoComplete="off" value={accessKey} onChange={e => setAccessKey(e.target.value)} className={inputClass} /></label>
          <p className="text-sm text-muted-foreground">Use the owner access key from the Vault service on your PC or Raspberry Pi.</p>
          <Button type="submit" className="min-h-12 w-full" disabled={!accessKey.trim()}><Link />Open monitoring</Button>
        </>}
        <Button variant="ghost" type="button" className="w-full" onClick={() => { setError(""); setStep(hasLocation ? "location" : "phone"); }}>Back</Button>
      </>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </form>
  </FlowScreen>;
}
