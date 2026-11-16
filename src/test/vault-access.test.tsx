import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    enroll: vi.fn().mockResolvedValue({ data: { id: "factor", totp: { uri: "otpauth://totp/Test?secret=TEST", secret: "TEST" } }, error: null }),
  },
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth } }));
vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,") } }));
const track = vi.fn();
beforeEach(() => {
  window.__lovableEvents = { track };
  auth.getUser.mockResolvedValue({ data: { user: null } });
  auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({ data: { currentLevel: "aal1" }, error: null });
  auth.mfa.verify.mockResolvedValue({ error: new Error("Invalid code") });
  auth.mfa.listFactors.mockResolvedValue({ data: { totp: [{ id: "factor", status: "verified" }] }, error: null });
});
afterEach(() => { cleanup(); delete window.__lovableEvents; vi.clearAllMocks(); });

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
    await waitFor(() => expect(track).toHaveBeenCalledWith("project.account_flow_failed", { flow: "sign_in", step: "authy_verification" }));
    expect(track).toHaveBeenCalledWith("project.account_flow_started", { flow: "sign_in" });
    expect(track).toHaveBeenCalledWith("project.account_step_completed", { flow: "sign_in", step: "password_verification" });
    expect(track).not.toHaveBeenCalledWith("project.account_flow_completed", { flow: "sign_in" });
    expect(JSON.stringify(track.mock.calls)).not.toMatch(/owner@|example-password|123456|Invalid code/);
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
    expect(track).toHaveBeenCalledWith("project.account_flow_started", { flow: "registration" });
    expect(track).toHaveBeenCalledWith("project.account_step_completed", { flow: "registration", step: "account_submission" });
    expect(track).not.toHaveBeenCalledWith("project.account_flow_completed", { flow: "registration" });
  });
  it("counts sign-in completion only after successful Authy verification", async () => {
    render(<VaultAccess />);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "owner@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "example-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to Authy" }));
    const pin = await screen.findByLabelText("Authy code");
    auth.mfa.verify.mockResolvedValueOnce({ error: null });
    auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({ data: { currentLevel: "aal2" }, error: null });
    fireEvent.change(pin, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify & open Vault" }));
    await waitFor(() => expect(track).toHaveBeenCalledWith("project.account_flow_completed", { flow: "sign_in" }));
    expect(track).toHaveBeenCalledWith("project.account_step_completed", { flow: "sign_in", step: "authy_verification" });
    expect(track.mock.calls.filter(([name]) => name === "project.account_flow_completed")).toHaveLength(1);
  });
  it("requires confirmed Authy factor and AAL2 before counting registration completion", async () => {
    render(<VaultAccess />);
    auth.mfa.listFactors.mockResolvedValueOnce({ data: { totp: [] }, error: null });
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "owner@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "example-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to Authy" }));
    fireEvent.click(await screen.findByLabelText("The QR code opened in Authy"));
    fireEvent.click(screen.getByLabelText("Authy saved my Vault account"));
    fireEvent.click(screen.getByRole("button", { name: "Continue to verification" }));
    fireEvent.change(screen.getByLabelText("Authy code"), { target: { value: "123456" } });
    auth.mfa.verify.mockResolvedValue({ error: null });
    fireEvent.click(screen.getByRole("button", { name: "Verify & finish setup" }));
    await waitFor(() => expect(track).toHaveBeenCalledWith("project.account_flow_failed", { flow: "registration", step: "authy_verification" }));
    expect(track).not.toHaveBeenCalledWith("project.account_flow_completed", { flow: "registration" });
    auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({ data: { currentLevel: "aal2" }, error: null });
    fireEvent.change(screen.getByLabelText("Authy code"), { target: { value: "654321" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify & finish setup" }));
    await waitFor(() => expect(track).toHaveBeenCalledWith("project.account_flow_completed", { flow: "registration" }));
    expect(track).toHaveBeenCalledWith("project.account_step_completed", { flow: "registration", step: "authy_setup_confirmed" });
    expect(JSON.stringify(track.mock.calls)).not.toMatch(/owner@|example-password|123456|654321|otpauth|TEST/);
  });
});