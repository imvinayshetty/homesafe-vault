import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { LocalBackupWorkspace } from "@/components/local-backup-workspace";
import { VaultAccess } from "@/components/vault-access";
import { Button } from "@/components/ui/button";
import { HardDrive, Thermometer, Wifi, ShieldCheck, KeyRound, Smartphone, Tablet, Laptop, History, RotateCcw, CheckCircle2, Loader2, Lock, Sun, Moon } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Homesafe Vault — Local Backup Dashboard" },
      { name: "description", content: "Manage local file backups by profile and phone folder. Sign-in is cloud-based with Authy 2FA; backup files stay on local storage." },
      { property: "og:title", content: "Homesafe Vault — Local Backup Dashboard" },
      { property: "og:description", content: "Local file backup workspace with named phone folders, saved-backup filters and storage warnings." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

type Device = { id: string; name: string; kind: "phone" | "tablet" | "laptop"; last: string };
type Snap = { id: string; date: string; size: string; files: number; state: "idle" | "checking" | "valid" | "restoring" | "restored" };

const newPin = () => String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
const icons = { phone: Smartphone, tablet: Tablet, laptop: Laptop };

function Index() {
  const [now, setNow] = useState<Date | null>(null);
  const [pin, setPin] = useState("------");
  const [left, setLeft] = useState(30);
  const [temp, setTemp] = useState(38.4);
  const [mounted, setMounted] = useState(true);
  const [light, setLight] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [showDemo, setShowDemo] = useState(false);
  const [devices, setDevices] = useState<Device[]>([
    { id: "1", name: "Vinay's Pixel 8", kind: "phone", last: "2 min ago" },
    { id: "2", name: "Family iPad", kind: "tablet", last: "1 hr ago" },
    { id: "3", name: "Asha's iPhone 15", kind: "phone", last: "Yesterday" },
  ]);
  const [snaps, setSnaps] = useState<Snap[]>(
    ["Today 03:00", "Yesterday 03:00", "Nov 13 03:00", "Nov 12 03:00", "Nov 08 03:00"].map((d, i) => ({
      id: String(i), date: d, size: `${(412 - i * 6.3).toFixed(1)} GB`, files: 184210 - i * 912, state: "idle",
    })),
  );

  useEffect(() => {
    setPin(newPin()); setNow(new Date());
    const html = document.documentElement;
    const saved = localStorage.getItem("theme");
    const initial = saved ?? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    html.setAttribute("data-theme", initial);
    setLight(initial === "light");
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = (e: MediaQueryListEvent) => {
      if (!localStorage.getItem("theme")) {
        html.setAttribute("data-theme", e.matches ? "light" : "dark");
        setLight(e.matches);
      }
    };
    mq.addEventListener("change", onChange);
    const t = setInterval(() => {
      setNow(new Date());
      setTemp((x) => Math.min(46, Math.max(34, x + (Math.random() - 0.5) * 0.6)));
      setLeft((l) => { if (l <= 1) { setPin(newPin()); return 30; } return l - 1; });
    }, 1000);
    return () => { clearInterval(t); mq.removeEventListener("change", onChange); };
  }, []);

  const toggleTone = () => {
    setLight((l) => {
      const next = !l;
      document.documentElement.setAttribute("data-theme", next ? "light" : "dark");
      localStorage.setItem("theme", next ? "light" : "dark");
      return next;
    });
  };
  const setSnap = (id: string, state: Snap["state"]) => setSnaps((s) => s.map((x) => (x.id === id ? { ...x, state } : x)));
  const validate = (id: string) => { setSnap(id, "checking"); setTimeout(() => setSnap(id, "valid"), 1800); };
  const restore = (id: string) => { setSnap(id, "restoring"); setTimeout(() => setSnap(id, "restored"), 2200); };
  const tempTone = temp > 44 ? "text-destructive" : temp > 41 ? "text-warning" : "text-primary";

  return (
    <main className="min-h-screen bg-background p-4 md:p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-xl bg-accent glow"><Lock className="h-5 w-5 text-primary" /></div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Homesafe Vault</h1>
              <p className="text-sm text-muted-foreground">Living Room Vault (Pi 5) · your home, your drive</p>
            </div>
          </div>
          <div className="order-first flex w-full justify-center md:order-none md:w-auto md:flex-1">
            <Button
              type="button"
              onClick={toggleTone}
              aria-label={light ? "Switch to dark mode" : "Switch to sage mode"}
              className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border bg-secondary px-5 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              {light ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
              <span className="toggle-text">{light ? "Dark" : "Sage"}</span>
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-2 rounded-full border border-primary/40 bg-accent px-3 py-1.5 text-sm font-medium text-primary">
              <ShieldCheck className="h-4 w-4" /> Backups stay local · Cloud sign-in only
            </span>
            <span className="font-mono text-sm text-muted-foreground">{now?.toLocaleTimeString() ?? ""}</span>
          </div>
        </header>

        <VaultAccess onAuthChange={setSignedIn} />
        {signedIn ? <LocalBackupWorkspace /> : (
          <p className="border-y border-border py-6 text-sm text-muted-foreground">Sign in with your email and Authy code to open the local backup workspace.</p>
        )}

        <Button variant="outline" onClick={() => setShowDemo(v => !v)}>{showDemo ? "Hide sample monitoring" : "Show sample monitoring"}</Button>
        {showDemo && <>
        <p className="text-xs text-warning">Sample vault monitoring below · drive, pairing, trusted devices and restore actions are demonstrations, not connected hardware.</p>
        <section className="grid gap-4 md:grid-cols-3">
          <div className="panel">
            <div className="flex items-center justify-between text-sm text-muted-foreground"><span>Vault drive</span><HardDrive className="h-4 w-4" /></div>
            <div className="mt-3 flex items-center gap-2 text-lg font-semibold">
              <span className={`h-2.5 w-2.5 rounded-full pulse-dot ${mounted ? "bg-primary" : "bg-destructive"}`} />
              {mounted ? "Ready and mounted" : "Safely ejected"}
            </div>
            <p className="mt-1 font-mono text-xs text-muted-foreground">/dev/sda1 → /mnt/homesafe · ext4</p>
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full w-[62%] rounded-full bg-primary" /></div>
            <div className="mt-2 flex justify-between text-xs text-muted-foreground"><span>1.24 TB used</span><span>2 TB</span></div>
            <button onClick={() => setMounted((m) => !m)} className="mt-4 min-h-11 w-full rounded-lg border border-border bg-secondary text-sm font-medium hover:bg-accent">
              {mounted ? "Safely eject" : "Reconnect drive"}
            </button>
          </div>

          <div className="panel">
            <div className="flex items-center justify-between text-sm text-muted-foreground"><span>Drive warmth</span><Thermometer className="h-4 w-4" /></div>
            <div className={`mt-3 font-display text-4xl ${tempTone}`}>{temp.toFixed(1)}°C</div>
            <p className="mt-1 text-xs text-muted-foreground">Running calm · health checks passing</p>
            <div className="mt-4 flex h-12 items-end gap-1">
              {Array.from({ length: 24 }).map((_, i) => (
                <div key={i} className="flex-1 rounded-sm bg-primary/30" style={{ height: `${40 + Math.sin(i / 2) * 25 + (i === 23 ? 20 : 0)}%` }} />
              ))}
            </div>
          </div>

          <div className="panel">
            <div className="flex items-center justify-between text-sm text-muted-foreground"><span>On your network</span><Wifi className="h-4 w-4" /></div>
            <div className="mt-3 font-mono text-2xl font-semibold">192.168.1.108</div>
            <p className="mt-1 font-mono text-xs text-muted-foreground">Home-WiFi-5G · 0 WAN bytes</p>
            <div className="mt-4 rounded-lg bg-accent p-3 text-xs text-accent-foreground">
              <div className="flex items-center gap-2 font-medium text-primary"><ShieldCheck className="h-4 w-4" />Local network only</div>
              <p className="mt-1 text-muted-foreground">Your files never leave your home network.</p>
            </div>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-5">
          <div className="panel glow md:col-span-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><KeyRound className="h-4 w-4" /> Code for pairing a phone</div>
            <div className="mt-5 flex justify-center gap-2">
              {pin.split("").map((d, i) => (
                <span key={i} className="grid h-14 w-11 place-items-center rounded-lg border border-border bg-secondary font-mono text-2xl font-semibold text-primary">{d}</span>
              ))}
            </div>
            <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary transition-all duration-1000 ease-linear" style={{ width: `${(left / 30) * 100}%` }} />
            </div>
            <p className="mt-2 text-center text-xs text-muted-foreground">Fresh code in {left}s · enter it in HomeSafe on your phone</p>
          </div>

          <div className="panel md:col-span-3">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">Trusted devices</h2>
              <span className="text-xs text-muted-foreground">{devices.length} trusted</span>
            </div>
            <ul className="mt-3 divide-y divide-border">
              {devices.map((d) => { const I = icons[d.kind]; return (
                <li key={d.id} className="flex items-center gap-3 py-3">
                  <div className="grid h-10 w-10 place-items-center rounded-lg bg-secondary"><I className="h-5 w-5 text-primary" /></div>
                  <div className="flex-1"><div className="text-sm font-medium">{d.name}</div><div className="text-xs text-muted-foreground">Last seen {d.last}</div></div>
                  <button onClick={() => setDevices((x) => x.filter((y) => y.id !== d.id))} className="min-h-11 rounded-lg border border-destructive/40 px-4 text-sm text-destructive hover:bg-destructive/10">Remove access</button>
                </li>); })}
              {devices.length === 0 && <li className="py-6 text-center text-sm text-muted-foreground">No phones trusted yet. Use the code to pair one privately.</li>}
            </ul>
          </div>
        </section>

        <section className="panel">
          <div className="flex items-center gap-2"><History className="h-4 w-4 text-primary" /><h2 className="font-semibold">Saved moments</h2></div>
          <div className="mt-3 divide-y divide-border">
            {snaps.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-40 flex-1"><div className="text-sm font-medium">{s.date}</div><div className="font-mono text-xs text-muted-foreground">{s.size} · {s.files.toLocaleString()} files</div></div>
                {s.state === "idle" && <button onClick={() => validate(s.id)} className="min-h-11 rounded-lg bg-secondary px-4 text-sm font-medium hover:bg-accent">Check &amp; restore</button>}
                {s.state === "checking" && <span className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Checking every file offline…</span>}
                {s.state === "valid" && (<>
                  <span className="flex items-center gap-1 text-sm text-primary"><CheckCircle2 className="h-4 w-4" />Verified offline</span>
                  <button onClick={() => restore(s.id)} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:opacity-90"><RotateCcw className="h-4 w-4" />Restore</button>
                </>)}
                {s.state === "restoring" && <span className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Bringing files back home…</span>}
                {s.state === "restored" && <span className="flex items-center gap-1 text-sm text-primary"><CheckCircle2 className="h-4 w-4" />Safely restored</span>}
              </div>
            ))}
          </div>
        </section>
        </>}
      </div>
    </main>
  );
}
