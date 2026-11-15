import { useEffect, useState } from "react";
import { Mail, KeyRound, Smartphone, QrCode, ShieldCheck, Loader2, LogOut, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";

type Stage =
  | { kind: "form" }
  | { kind: "confirm-email"; email: string }
  | { kind: "enroll"; factorId: string; qr: string; secret: string }
  | { kind: "challenge"; factorId: string }
  | { kind: "signed-in"; email: string };

const inputClass = "mt-2 min-h-11 w-full rounded-md border border-input bg-background px-3 outline-none focus:ring-2 focus:ring-ring disabled:opacity-60";

/** Cloud handles sign-in only; every backup file stays on local storage. */
export function VaultAccess({ onAuthChange }: { onAuthChange?: (signedIn: boolean) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [stage, setStage] = useState<Stage>({ kind: "form" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    void supabase.auth.getUser().then(async ({ data }) => {
      if (!active || !data.user) return;
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (!active) return;
      if (aal?.currentLevel === "aal2") setStage({ kind: "signed-in", email: data.user.email ?? "" });
      else setStage(await nextStep());
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") setStage({ kind: "form" });
    });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, []);

  useEffect(() => { onAuthChange?.(stage.kind === "signed-in"); }, [stage.kind, onAuthChange]);

  /** Decide the next step after password auth: enroll Authy, challenge, or done. */
  async function nextStep(): Promise<Stage> {
    const { data: aal, error: aalError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aalError) throw aalError;
    if (aal.currentLevel === "aal2") {
      const { data } = await supabase.auth.getUser();
      return { kind: "signed-in", email: data.user?.email ?? "" };
    }
    const { data: factors, error: factorsError } = await supabase.auth.mfa.listFactors();
    if (factorsError) throw factorsError;
    const existing = factors.totp.find(f => f.status === "verified") ?? factors.totp[0];
    if (existing?.status === "verified") return { kind: "challenge", factorId: existing.id };
    if (existing) await supabase.auth.mfa.unenroll({ factorId: existing.id });
    const { data: enroll, error: enrollError } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: `Authy ${crypto.randomUUID().slice(0, 8)}` });
    if (enrollError) throw enrollError;
    return { kind: "enroll", factorId: enroll.id, qr: enroll.totp.qr_code, secret: enroll.totp.secret };
  }

  async function run(work: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await work(); }
    catch (e) { setError(e instanceof Error ? e.message : "Something went wrong. Please try again."); }
    finally { setBusy(false); }
  }

  const register = () => run(async () => {
    const { error: signUpError } = await supabase.auth.signUp({
      email: email.trim(), password,
      options: { emailRedirectTo: window.location.origin },
    });
    if (signUpError) throw signUpError;
    setStage({ kind: "confirm-email", email: email.trim() });
  });

  const login = () => run(async () => {
    const { error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (signInError) throw signInError;
    setStage(await nextStep());
  });

  const verifyToken = (factorId: string, after: Stage) => run(async () => {
    const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId });
    if (challengeError) throw challengeError;
    const { error: verifyError } = await supabase.auth.mfa.verify({ factorId, challengeId: challenge.id, code: token.trim() });
    if (verifyError) throw verifyError;
    setToken("");
    if (after.kind === "enroll") {
      setStage({ kind: "signed-in", email });
      setNotice("Authy is now protecting your Vault account.");
    } else {
      setStage(await nextStep());
    }
  });

  const signOut = () => run(async () => {
    await supabase.auth.signOut();
    setPassword(""); setToken("");
    setStage({ kind: "form" });
  });

  const copySecret = async () => {
    if (stage.kind !== "enroll") return;
    await navigator.clipboard.writeText(stage.secret);
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section className="space-y-5 border-t border-border py-6" aria-labelledby="vault-access-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="vault-access-heading" className="font-display text-2xl">Your Vault account</h2>
        <span className="flex items-center gap-2 rounded-full border border-primary/40 bg-accent px-3 py-1.5 text-sm font-medium text-primary">
          <ShieldCheck className="h-4 w-4" />Only sign-in is cloud-based · backups stay local
        </span>
      </div>

      {stage.kind === "signed-in" ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-secondary/50 p-4">
          <p className="flex items-center gap-2 text-sm"><ShieldCheck className="h-4 w-4 text-primary" />Signed in as <span className="font-medium">{stage.email}</span> · verified with Authy</p>
          <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => void signOut()}><LogOut />Sign out</Button>
        </div>
      ) : stage.kind === "confirm-email" ? (
        <div className="space-y-2 rounded-lg border border-border bg-secondary/50 p-4 text-sm">
          <p className="flex items-center gap-2 font-medium"><Mail className="h-4 w-4 text-primary" />Check your email</p>
          <p className="text-muted-foreground">We sent a confirmation link to <span className="font-medium text-foreground">{stage.email}</span>. Open it, then come back and sign in to set up Authy.</p>
          <Button variant="outline" className="min-h-11" onClick={() => { setMode("login"); setStage({ kind: "form" }); }}>Back to sign in</Button>
        </div>
      ) : stage.kind === "enroll" ? (
        <div className="grid gap-8 lg:grid-cols-2">
          <div className="space-y-4">
            <h3 className="flex items-center gap-2 font-medium"><QrCode className="h-4 w-4 text-primary" />Set up Authy</h3>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>Open the Authy app on your phone.</li>
              <li>Add an account and scan this QR code, or enter the setup key manually.</li>
              <li>Type the 6-digit code Authy shows to finish.</li>
            </ol>
            <div className="flex items-center gap-2 rounded-md border border-border bg-background p-3 font-mono text-sm">
              <span className="break-all">{stage.secret}</span>
              <Button variant="ghost" size="icon" aria-label="Copy setup key" onClick={() => void copySecret()}>{copied ? <Check className="h-4 w-4 text-primary" /> : <Copy className="h-4 w-4" />}</Button>
            </div>
            <label className="block text-sm">Authy code
              <input value={token} onChange={e => setToken(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" className={inputClass} />
            </label>
            <Button className="min-h-11" disabled={busy || token.trim().length < 6} onClick={() => void verifyToken(stage.factorId, stage)}>
              {busy ? <Loader2 className="animate-spin" /> : <KeyRound />}Verify &amp; finish setup
            </Button>
          </div>
          <div className="flex items-start justify-center" dangerouslySetInnerHTML={{ __html: stage.qr }} />
        </div>
      ) : stage.kind === "challenge" ? (
        <div className="max-w-md space-y-4">
          <h3 className="flex items-center gap-2 font-medium"><Smartphone className="h-4 w-4 text-primary" />Enter your Authy code</h3>
          <label className="block text-sm">Authy code
            <input value={token} onChange={e => setToken(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" className={inputClass} autoFocus />
          </label>
          <Button className="min-h-11" disabled={busy || token.trim().length < 6} onClick={() => void verifyToken(stage.factorId, stage)}>
            {busy ? <Loader2 className="animate-spin" /> : <KeyRound />}Verify &amp; sign in
          </Button>
        </div>
      ) : (
        <div className="max-w-md space-y-4">
          <div role="tablist" aria-label="Vault account access" className="flex gap-2">
            <Button role="tab" aria-selected={mode === "login"} variant={mode === "login" ? "secondary" : "ghost"} onClick={() => { setMode("login"); setError(""); }}>Returning user</Button>
            <Button role="tab" aria-selected={mode === "register"} variant={mode === "register" ? "secondary" : "ghost"} onClick={() => { setMode("register"); setError(""); }}>First-time registration</Button>
          </div>
          <div role="tabpanel" aria-label={mode === "login" ? "Returning user" : "First-time registration"} className="space-y-3">
            <div className="flex items-center gap-2 font-medium"><Mail className="h-4 w-4 text-primary" />{mode === "login" ? "Sign in to your Vault" : "Register on this Vault"}</div>
            <label className="block text-sm">Email address
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" placeholder="you@example.com" className={inputClass} />
            </label>
            <label className="block text-sm">Password
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder={mode === "register" ? "Choose a password (6+ characters)" : "Your password"} className={inputClass} />
            </label>
            <Button className="min-h-11" disabled={busy || !email.trim() || password.length < 6} onClick={() => void (mode === "login" ? login() : register())}>
              {busy ? <Loader2 className="animate-spin" /> : <KeyRound />}{mode === "login" ? "Sign in" : "Register"}
            </Button>
            <p className="text-xs text-muted-foreground">{mode === "login" ? "After your password, you'll enter the 6-digit code from Authy." : "After confirming your email, you'll set up Authy as your second factor."}</p>
          </div>
        </div>
      )}

      {error && <p role="alert" className="border-l-2 border-destructive pl-3 text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="text-sm text-primary">{notice}</p>}
      <p className="text-xs text-muted-foreground">Your email, password and Authy secret are handled by the cloud sign-in service only. Backup files, folder names and drive contents never leave your local storage. Phone pairing over home Wi-Fi still requires the local Vault service and HomeSafe phone app.</p>
    </section>
  );
}
