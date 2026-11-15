import { useState } from "react";
import { Mail, KeyRound, UserRound, Smartphone, WifiOff, QrCode, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

/** No account is created here: only an installed local service can authenticate Vault users. */
export function VaultAccess() {
  const [mode, setMode] = useState<"login" | "register">("login");
  return (
    <section className="space-y-5 border-t border-border py-6" aria-labelledby="vault-access-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="vault-access-heading" className="font-display text-2xl">Your Vault account</h2>
        <span className="flex items-center gap-2 text-sm text-warning"><WifiOff className="h-4 w-4" />Local Vault service unavailable</span>
      </div>
      <div role="tablist" aria-label="Vault account access" className="flex gap-2">
        <Button role="tab" aria-selected={mode === "login"} variant={mode === "login" ? "secondary" : "ghost"} onClick={() => setMode("login")}>Returning user</Button>
        <Button role="tab" aria-selected={mode === "register"} variant={mode === "register" ? "secondary" : "ghost"} onClick={() => setMode("register")}>First-time registration</Button>
      </div>
      <div className="grid gap-8 lg:grid-cols-2">
        <div role="tabpanel" aria-label={mode === "login" ? "Returning user" : "First-time registration"} className="space-y-4">
          <div className="flex items-center gap-2 font-medium"><Mail className="h-4 w-4 text-primary" />{mode === "login" ? "Sign in to your profile" : "Register on this Vault"}</div>
          <fieldset disabled className="space-y-3">
            <label className="block text-sm">Email address<input type="email" autoComplete="email" placeholder="you@example.com" className="mt-2 min-h-11 w-full rounded-md border border-input bg-background px-3 disabled:opacity-60" /></label>
            {mode === "register" ? <label className="block text-sm">User profile name<input autoComplete="nickname" placeholder="Your profile name" className="mt-2 min-h-11 w-full rounded-md border border-input bg-background px-3 disabled:opacity-60" /></label> : <label className="block text-sm">Authy token<input inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit authenticator token" className="mt-2 min-h-11 w-full rounded-md border border-input bg-background px-3 disabled:opacity-60" /></label>}
            <Button disabled className="min-h-11"><KeyRound />{mode === "login" ? "Sign in with Authy" : "Register & set up Authy"}</Button>
          </fieldset>
          <p className="text-sm text-warning">Registration and sign-in are unavailable until a local Vault service is installed on your PC or Raspberry Pi. No account or Authy secret is saved by this page.</p>
          <p className="text-xs text-muted-foreground">Email identifies a local account; it is not email verification or a second authentication factor. Authy’s own cloud sync is managed separately in Authy.</p>
        </div>
        <div className="space-y-4 border-l border-border pl-5">
          <h3 className="flex items-center gap-2 font-medium"><Smartphone className="h-4 w-4 text-primary" />Phone pairing</h3>
          <ol className="space-y-3 text-sm text-muted-foreground">
            <li className="flex items-center gap-3"><UserRound className="h-4 w-4 shrink-0" />Profile confirmation · awaiting sign-in</li>
            <li className="flex items-center gap-3"><Smartphone className="h-4 w-4 shrink-0" />Phone selection · awaiting verified profile</li>
            <li className="flex items-center gap-3"><QrCode className="h-4 w-4 shrink-0" />QR and local-IP code · not issued</li>
          </ol>
          <div className="flex items-start gap-2 border-l-2 border-warning pl-3 text-sm"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" /><p>No phone is paired. Real pairing and revocation require the local Vault service and an installed HomeSafe Android or iPhone app. Pairing codes are separate from Authy tokens.</p></div>
        </div>
      </div>
    </section>
  );
}