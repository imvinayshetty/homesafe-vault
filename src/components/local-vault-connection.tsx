import { useState } from "react";
import { HardDrive, Link, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TransferStatus } from "@/components/transfer-status";
import { safeSegment } from "@/lib/local-backup";

export function LocalVaultConnection() {
  const [profile, setProfile] = useState("");
  const [phone, setPhone] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [destination, setDestination] = useState<{ profile: string; phone: string; accessKey: string } | null>(null);
  const [error, setError] = useState("");
  const inputClass = "mt-2 min-h-11 w-full rounded-md border border-input bg-background px-3";
  return <section aria-labelledby="live-vault-heading" className="space-y-5 border-y border-border py-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="live-vault-heading" className="flex items-center gap-2 font-display text-2xl"><HardDrive className="h-5 w-5 text-primary" />Local Vault monitoring</h2>{destination && <Button variant="outline" onClick={() => { setDestination(null); setAccessKey(""); }}><Unplug />Disconnect dashboard</Button>}</div>
    {!destination ? <form className="space-y-4" onSubmit={e => { e.preventDefault(); try { if (!/^[A-Za-z0-9_-]{43}$/.test(accessKey)) throw new Error("Enter the local access key issued by your Vault service."); setDestination({ profile: safeSegment(profile), phone: safeSegment(phone), accessKey }); setError(""); } catch (err) { setError(err instanceof Error ? err.message : "Check your destination."); } }}>
      <div className="grid gap-4 sm:grid-cols-3"><label className="text-sm">Profile name<input required value={profile} onChange={e => setProfile(e.target.value)} className={inputClass} /></label><label className="text-sm">Phone name<input required value={phone} onChange={e => setPhone(e.target.value)} className={inputClass} /></label><label className="text-sm">Local service access key<input required type="password" autoComplete="off" value={accessKey} onChange={e => setAccessKey(e.target.value)} className={inputClass} /></label></div>
      <Button type="submit"><Link />Connect local Vault</Button>
      <p className="text-xs text-muted-foreground">Drive destination is set on your PC or Raspberry Pi. Your access key stays in this page’s memory.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </form> : <TransferStatus {...destination} />}
  </section>;
}