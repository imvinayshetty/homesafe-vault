# HomeSafe changes before implementation

## Changes in the HomeSafe app

1. **Connect to your Vault**
   - Update the existing phone setup screen, preserving HomeSafe’s current visual style.
   - Find the Vault on home Wi-Fi through the installed Android/iPhone app, scan its pairing QR code, or enter its local address manually.
   - Request camera and local-network permissions only when needed, with a manual alternative when camera access is declined.

2. **Use the account registered on Vault**
   - Enter the same email address used during Vault registration.
   - Show a clear “Register on your Vault first” state for an account that is not registered.
   - Do not create a second account or authenticator setup on the phone.
   - Keep Authy login codes separate from the code displayed by Vault for phone pairing. Never send an Authy secret to the HomeSafe app.

3. **Confirm the profile and phone**
   - After authorized access, show the profile and phone selected on the signed-in Vault.
   - Ask the user to confirm both before enrollment.
   - New phones are named on Vault using memorable names; reject duplicate names within that profile rather than adding a second folder.

4. **Pair with QR or a typed code**
   - Scan the QR displayed for the selected profile and phone, or type the local address and its six-digit pairing code.
   - Show waiting, expired code, rejected request, disconnected and genuinely paired states.
   - Bind pairing to that account, profile, phone and device identity; stop displaying the code after successful use.

5. **Back up to the selected phone folder**
   - Show the destination as `HomeSafeBckup / user profile name / Phone name`.
   - Keep `Full_Bckup_DDMMYY` and `Custom_Bckup_DDMMYY` folders inside that phone folder.
   - Verify the encrypted device identity before every backup; never substitute browser identity for verified phone identity.
   - Full backup means only files the phone permits reading. Request appropriate OS permissions and explain excluded data.
   - Require a unique suffix for same-date backups and never overwrite existing backups.

6. **Return and recover safely**
   - Reconnect enrolled phones after authorized access without enrolling them again.
   - Display saved backups for the authorized phone, with backup-type and date filters.
   - Show clear warnings for an unavailable Vault, denied permissions, identity mismatch, disconnected storage, unreadable folders and insufficient space reported by Vault.
   - Keep sample pairing and backup behavior in the explicitly labeled demo; do not present it as real enrollment or transfer.

## Matching changes required in Vault

- One-time local email/profile registration and Authy-compatible authenticator setup, confirmed with a valid token.
- Returning-user access, profile confirmation, named phone selection and an add-phone icon with duplicate-name prevention.
- Move storage targeting and catalog scanning to the profile/phone hierarchy without silently moving or overwriting existing backups.
- Display pairing QR, local address and an expiring single-use code only after login and phone selection.
- Revoke phone access and enforce that revocation on future connections.

## Technical requirements and boundaries

- Real discovery, cryptographic phone enrollment and phone-file access require installed Android/iPhone companion apps; local accounts, pairing verification and USB writes require a service running on the PC/Pi. Neither exists in the current web projects.
- Verify pairing through an authenticated encrypted local connection with pinned Vault identity, cryptographically generated challenges, expiration and attempt limits. A QR code or six-digit PIN alone is not a secure transport or proof of physical proximity.
- Local email is an account identifier, not verified email ownership. Email plus an Authy token is not independently two authentication factors; genuine two-factor access requires an additional independent factor.
- Use a proven standard TOTP implementation for Authy compatibility. Protect authenticator secrets in the local service’s credential storage, not ordinary browser settings. No Twilio/Authy cloud API is needed; Authy’s own backup/sync behavior is separate from HomeSafe’s zero-cloud promise.
- Test profile/phone isolation, duplicate names, code expiry/reuse, identity mismatch, backup naming and no-overwrite behavior. Verify a real phone-to-Vault file write and readback before calling the integration complete.

## Where implementation happens

This plan describes changes to **HomeSafe**. This chat can inspect HomeSafe but cannot modify it. Open that project’s chat to apply its changes; matching Vault changes belong in this project. Companion apps and the local service must be delivered separately before real local pairing and phone backups can work.