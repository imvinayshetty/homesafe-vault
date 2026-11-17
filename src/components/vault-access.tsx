import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { Mail, Smartphone, ShieldCheck, Loader2, LogOut, Copy, Check, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FlowScreen } from "@/components/flow-screen";
import { supabase } from "@/integrations/supabase/client";

type Stage =
  | { kind: "form" }
  | { kind: "confirm-email"; email: string }
  | { kind: "enroll"; factorId: string; qr: string; secret: string; uri: string }
  | { kind: "challenge"; factorId: string }
  | { kind: "signed-in"; email: string };

const inputClass = "mt-2 min-h-11 w-full rounded-md border border-input bg-background px-3 outline-none focus:ring-2 focus:ring-ring disabled:opacity-60";

/** Cloud handles sign-in only; every backup file stays on local storage. */
export function VaultAccess({ onAuthChange }: { onAuthChange?: (signedIn: boolean) => void }) {
  const [enrollStep, setEnrollStep] = useState<"scan" | "pin">("scan");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [stage, setStage] = useState<Stage>({ kind: "form" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    let active = true;
    void supabase.auth.getUser().then(async ({ data }) => {
      if (!active || !data.user) return;
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (!active) return;
      if (aal?.currentLevel === "aal2") setStage({ kind: "signed-in", email: data.user.email ?? "" });
      else { setEnrollStep("scan"); setStage(await nextStep()); }
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
    // Scanners need dark modules on a white quiet zone; render our own PNG from the otpauth URI.
    const qr = await QRCode.toDataURL(enroll.totp.uri, { width: 320, margin: 4, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } });
    return { kind: "enroll", factorId: enroll.id, qr, secret: enroll.totp.secret, uri: enroll.totp.uri };
  }

  async function run(work: () => Promise<void>, flow?: "registration" | "sign_in", step?: "account_submission" | "password_verification" | "authy_verification") {
    setBusy(true); setError(""); setNotice("");
    try { await work(); }
    catch (e) {
      if (flow && step) window.__lovableEvents?.track?.("project.account_flow_failed", { flow, step });
      setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    }
    finally { setBusy(false); }
  }

  const register = () => run(async () => {
    window.__lovableEvents?.track?.("project.account_flow_started", { flow: "registration" });
    const { error: signUpError } = await supabase.auth.signUp({
      email: email.trim(), password,
      options: window.location.protocol === "app:" ? {} : { emailRedirectTo: window.location.origin },
    });
    if (signUpError) throw signUpError;
    window.__lovableEvents?.track?.("project.account_step_completed", { flow: "registration", step: "account_submission" });
    setStage({ kind: "confirm-email", email: email.trim() });
  }, "registration", "account_submission");

  const login = () => run(async () => {
    window.__lovableEvents?.track?.("project.account_flow_started", { flow: "sign_in" });
    const { error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (signInError) throw signInError;
    window.__lovableEvents?.track?.("project.account_step_completed", { flow: "sign_in", step: "password_verification" });
    const next = await nextStep();
    if (next.kind === "enroll") {
      // Enrollment can resume in a later visit after email confirmation; count that entry separately.
      window.__lovableEvents?.track?.("project.account_step_completed", { flow: "registration", step: "enrollment_ready" });
    }
    if (next.kind === "signed-in") window.__lovableEvents?.track?.("project.account_flow_completed", { flow: "sign_in" });
    setEnrollStep("scan"); setStage(next);
  }, "sign_in", "password_verification");

  const verifyToken = (factorId: string, after: Stage) => run(async () => {
    const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId });
    if (challengeError) throw challengeError;
    const { error: verifyError } = await supabase.auth.mfa.verify({ factorId, challengeId: challenge.id, code: token.trim() });
    if (verifyError) throw verifyError;
    setToken("");
    if (after.kind === "enroll") {
      // Only mark registration complete once the backend confirms the factor and session are verified.
      const [{ data: aal }, { data: factors }] = await Promise.all([
        supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
        supabase.auth.mfa.listFactors(),
      ]);
      const factor = factors?.totp.find(f => f.id === factorId);
      if (aal?.currentLevel !== "aal2" || factor?.status !== "verified") {
        throw new Error("Authy setup could not be confirmed. Please enter a fresh code from Authy.");
      }
      setScanned(false); setAccepted(false);
      const { data: u } = await supabase.auth.getUser();
      setStage({ kind: "signed-in", email: u.user?.email ?? email });
      window.__lovableEvents?.track?.("project.account_step_completed", { flow: "registration", step: "authy_verification" });
      window.__lovableEvents?.track?.("project.account_flow_completed", { flow: "registration" });
      window.__lovableEvents?.track?.("project.account_flow_completed", { flow: "sign_in" });
      setNotice("Authy is now protecting your Vault account.");
    } else {
      const next = await nextStep();
      if (next.kind === "signed-in") {
        window.__lovableEvents?.track?.("project.account_step_completed", { flow: "sign_in", step: "authy_verification" });
        window.__lovableEvents?.track?.("project.account_flow_completed", { flow: "sign_in" });
      }
      setEnrollStep("scan"); setStage(next);
    }
  }, after.kind === "enroll" ? "registration" : "sign_in", "authy_verification");

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

  if (stage.kind === "signed-in") return <section className="flex flex-wrap items-center justify-between gap-4 border-b border-border py-4">
    <p className="flex min-w-0 flex-wrap items-center gap-2 text-sm"><ShieldCheck className="h-4 w-4 shrink-0 text-primary" /><span className="break-all">{stage.email}</span><span className="text-muted-foreground">Authy verified</span></p>
    <Button variant="ghost" disabled={busy} onClick={() => void signOut()}><LogOut />Sign out</Button>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;

  const title = stage.kind === "form" ? (mode === "login" ? "Welcome back" : "Create your Vault account") : stage.kind === "confirm-email" ? "Check your email" : stage.kind === "challenge" ? "Verify with Authy" : enrollStep === "scan" ? "Connect Authy" : "Confirm your Authy code";
  const eyebrow = stage.kind === "form" ? (mode === "login" ? "Sign in · Step 1 of 2" : "Registration · Step 1 of 4") : stage.kind === "confirm-email" ? "Registration · Step 2 of 4" : stage.kind === "challenge" ? "Sign in · Step 2 of 2" : enrollStep === "scan" ? "Setup · Step 3 of 4" : "Setup · Step 4 of 4";
  return <FlowScreen key={`${stage.kind}-${stage.kind === "enroll" ? enrollStep : mode}`} title={title} eyebrow={eyebrow}>
    {stage.kind === "form" ? <>
      <div role="tablist" aria-label="Vault account access" className="grid grid-cols-2 gap-2 border-b border-border pb-4">
        <Button role="tab" aria-selected={mode === "login"} disabled={busy} variant={mode === "login" ? "secondary" : "ghost"} className="h-auto min-h-12 whitespace-normal" onClick={() => { setMode("login"); setError(""); setPassword(""); }}>Returning user</Button>
        <Button role="tab" aria-selected={mode === "register"} disabled={busy} variant={mode === "register" ? "secondary" : "ghost"} className="h-auto min-h-12 whitespace-normal" onClick={() => { setMode("register"); setError(""); setPassword(""); }}>First-time registration</Button>
      </div>
      <form className="space-y-4" onSubmit={e => { e.preventDefault(); if (!busy && email.trim() && password.length >= 6) void (mode === "login" ? login() : register()); }}>
        <label className="block text-sm">Email address<input required type="email" disabled={busy} value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" placeholder="you@example.com" className={inputClass} /></label>
        <label className="block text-sm">Password<input required minLength={6} disabled={busy} type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} className={inputClass} /></label>
        <Button type="submit" className="min-h-12 w-full" disabled={busy || !email.trim() || password.length < 6}>{busy ? <Loader2 className="animate-spin" /> : <ArrowRight />}{mode === "login" ? "Continue to Authy" : "Create account"}</Button>
      </form>
    </> : stage.kind === "confirm-email" ? <>
      <Mail className="h-10 w-10 text-primary" />
      <p className="text-muted-foreground">Open the confirmation link sent to <span className="break-all font-medium text-foreground">{stage.email}</span>.</p>
      <Button className="min-h-12 w-full" onClick={() => { setMode("login"); setPassword(""); setStage({ kind: "form" }); }}>Continue to sign in<ArrowRight /></Button>
    </> : stage.kind === "enroll" && enrollStep === "scan" ? <>
      <p className="text-sm text-muted-foreground">In Authy, choose Add account, then Scan QR code.</p>
      <div className="flex justify-center"><img src={stage.qr} alt="Authy setup QR code" width={280} height={280} className="aspect-square w-full max-w-[280px] rounded-md" /></div>
      <a href={stage.uri} className="flex min-h-11 items-center justify-center gap-2 rounded-md border border-border text-sm hover:bg-accent"><Smartphone className="h-4 w-4" />Open in Authy on this phone</a>
      <details className="border-b border-border pb-4 text-sm"><summary className="cursor-pointer text-muted-foreground">Can't scan? Use a setup key</summary><div className="mt-3 flex items-center gap-2"><span className="break-all font-mono">{stage.secret}</span><Button variant="ghost" size="icon" aria-label="Copy setup key" onClick={() => void copySecret()}>{copied ? <Check /> : <Copy />}</Button></div></details>
      <fieldset className="space-y-3 text-sm"><legend className="sr-only">Confirm Authy setup</legend>
        <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={scanned} className="h-5 w-5 accent-primary" onChange={e => { setScanned(e.target.checked); if (!e.target.checked) setAccepted(false); }} />The QR code opened in Authy</label>
        <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={accepted} disabled={!scanned} className="h-5 w-5 accent-primary" onChange={e => setAccepted(e.target.checked)} />Authy saved my Vault account</label>
      </fieldset>
      <Button className="min-h-12 w-full" disabled={!scanned || !accepted} onClick={() => { setToken(""); setError(""); setEnrollStep("pin"); window.__lovableEvents?.track?.("project.account_step_completed", { flow: "registration", step: "authy_setup_confirmed" }); }}>Continue to verification<ArrowRight /></Button>
    </> : stage.kind === "enroll" || stage.kind === "challenge" ? <>
      <Smartphone className="h-10 w-10 text-primary" />
      <p className="text-sm text-muted-foreground">Enter the current six-digit code for your Vault account in Authy.</p>
      <form className="space-y-4" onSubmit={e => { e.preventDefault(); if (!busy && token.length === 6) void verifyToken(stage.factorId, stage); }}>
        <label className="block text-sm">Authy code<input disabled={busy} required pattern="[0-9]{6}" value={token} onChange={e => setToken(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" className={`${inputClass} text-center font-mono text-2xl`} /></label>
        <Button type="submit" className="min-h-12 w-full" disabled={busy || token.length !== 6}>{busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}{stage.kind === "enroll" ? "Verify & finish setup" : "Verify & open Vault"}</Button>
      </form>
      <Button variant="ghost" disabled={busy} className="w-full" onClick={() => { setError(""); setToken(""); if (stage.kind === "enroll") setEnrollStep("scan"); else void signOut(); }}>{stage.kind === "enroll" ? "Back to Authy setup" : "Use a different account"}</Button>
    </> : null}
    {error && <p role="alert" className="border-l-2 border-destructive pl-3 text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-primary">{notice}</p>}
  </FlowScreen>;
}
