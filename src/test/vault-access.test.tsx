import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VaultAccess } from "@/components/vault-access";

const auth = vi.hoisted(() => ({
  getUser: vi.fn().mockResolvedValue({ data: { user: null } }),
  onAuthStateChange: vi.fn(() => ({ data: { sub: null, subscription: { unsubscribe: vi.fn() } } })),
  signInWithPassword: vi.fn().mockResolvedValue({ error: null }),
  signUp: vi.fn().mockResolvedValue({ error: null }),
  mfa: {
    getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({ data: { currentLevel: "aal1" }, error: null }),
    listFactors: vi.fn().mockResolvedValue({ data: { totp: [{ id: "factor", status: "verified" }] }, error: null }),
    challenge: vi.fn().mockResolvedValue({ data: { id: "challenge" }, error: null }),
    verify: vi.fn().mockResolvedValue({ error: new Error("Invalid code") }),
  },
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("sequential account access", () => {
  it("requires password sign-in before offering PIN verification and accepts exactly six digits", async () => {
    render(<VaultAccess />);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "owner@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "example-password" } });
    expect(auth.mfa.challenge).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue to Authy" }));
    const pin = await screen.findByLabelText("Authy code");
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: "owner@example.test", password: "example-password" });
    fireEvent.change(pin, { target: { value: "12345" } });
    expect(screen.getByRole("button", { name: "Verify & open Vault" })).toBeDisabled();
    fireEvent.change(pin, { target: { value: "12a34567" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify & open Vault" }));
    await waitFor(() => expect(auth.mfa.verify).toHaveBeenCalledWith({ factorId: "factor", challengeId: "challenge", code: "123456" }));
  });
  it("waits for email confirmation after registration rather than unlocking the Vault", async () => {
    const onAuthChange = vi.fn();
    render(<VaultAccess onAuthChange={onAuthChange} />);
    fireEvent.click(screen.getByRole("tab", { name: "First-time registration" }));
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "new@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "example-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(auth.signUp).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue to sign in" })).toBeEnabled());
    expect(onAuthChange).not.toHaveBeenCalledWith(true);
    expect(auth.mfa.challenge).not.toHaveBeenCalled();
  });
});