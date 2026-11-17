# HomeSafe Vault

A privacy-first desktop dashboard for a PC, Mac or Raspberry Pi that hosts a local USB backup drive for the HomeSafe phone app. Only sign-in (email + Authy 2FA) uses the internet; backups, pairing and transfers stay on home Wi-Fi and the local drive.

> Documentation policy: every new feature or behaviour change must be reflected in this README in the same change.

## Features

### Account access (cloud sign-in only)
- One-time registration with email + password, email confirmation, then Authy (TOTP) enrollment.
- Authy setup shows a scannable QR code and an "Open in Authy" button; the typed setup key is a last-resort fallback.
- Setup checklist: QR opened, account saved in Authy, 6-digit PIN verified; registration completes only after the session reaches AAL2 with a verified factor.
- Returning users: sign in, then Authy challenge.
- Each step opens on a fresh, focus-managed screen (`src/components/flow-screen.tsx`) with "Step X of Y" labels so actions can't be taken out of order.
- Privacy-safe analytics: flow started / step completed / completed / failed, with fixed labels only (no emails or codes).

### Local Vault setup
- After sign-in: choose the backup destination, then connect to the local Vault service (auto-connected in the desktop app, access key entry in a browser).
- Monitoring and Saved backups tabs appear only after setup finishes.

### Monitoring
- Awaiting-connection card with the Vault pairing code that refreshes every 30 seconds (shown only on this step).
- When a phone starts connecting, a full-screen payment-app-style animation shows six stages: Awaiting connection → Establishing connection → Code verified → Initiating transfer → Transfer in progress → Backup completed.
- Stages advance only from real Vault service events (`src/lib/vault-daemon.ts` reducer). A separate sample preview demonstrates the animation without granting access.
- New backups are started from the HomeSafe phone app, not the dashboard.

### Backups and storage
- Folder layout: `HomeSafeBckup/<Profile>/<Phone>/Full_Bckup_DDMMYY` or `Custom_Bckup_DDMMYY`.
- AES-256-GCM identity binds each profile/phone; identity is checked before every write. Existing backups are never overwritten; duplicate dates are rejected with a warning.
- Multiple profiles and phones per drive; legacy profile-level backups stay read-only.
- Saved backups filters: profile, phone, backup type, date. Warnings for disconnected drive, low space and unreadable folders (rescanned every 15 s).
- Storage health panel: available space, 14-day backup size trend, near-capacity alerts.

### Local Vault service (`vault-service/`)
- Node companion: loopback WebSocket (7878, origin-checked + owner key) for the dashboard, LAN HTTPS (7879) for phone uploads.
- Handles pairing codes, device connections, uploads, disk readback, and HomeSafe's native signed begin/confirm + chunk protocol.
- Bounded local event log only; no cloud tracking of backups.
- CLI: `init`, `start`, `access`, `install` (guided installer: drive check, TLS cert, systemd / Task Scheduler auto-start, readiness check), `doctor`. Replaced drives are rejected at startup.
- See `vault-service/README.md`.

### Desktop app (`electron/`)
- Bundles the dashboard (`DESKTOP=1` static build served from `app://vault`) so no web address or Lovable login is needed.
- Automatically starts the Vault service in the background, launches at login, and restarts it with backoff if it stops.
- First launch asks once for the HomeSafeBckup folder; Wi-Fi address changes are picked up automatically.
- Owner key exposed to the dashboard only through origin-checked IPC.
- Builds: Windows x64, macOS Apple Silicon, macOS Intel, Linux arm64. See `electron/README.md`.

### Appearance
- Calm sage (light) and dark slate themes with a toggle at the top; preference remembered and follows system setting by default.

## Development

```sh
bun install
bun run dev
bunx vitest run          # dashboard tests
cd vault-service && npm test
```
