# HomeSafe Vault local service

Standalone Node.js 22+ companion for a Windows/Linux/macOS PC or Raspberry Pi OS (64-bit). This folder runs **on the machine with the USB drive**, not Vercel or Lovable Cloud. It is not imported by the website. Cloud handles the website's existing sign-in only. Pairing, identity, files and the activity log stay local.

## Install and run

1. Install Node.js 22 LTS or newer and download this repository to the Vault machine. Open a terminal in `vault-service`, then run `npm install` (or `bun install`).
2. Mount your drive yourself and create its `HomeSafeBckup` folder. Do not use an automount path that silently falls back to your PC's system drive. The service rejects a changed/missing drive root; it never recreates it.
3. Create a local TLS certificate outside the repository. With OpenSSL, for example:

```sh
openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 365 -keyout vault.key -out vault.crt -subj "/CN=homesafe-vault.local" -addext "subjectAltName=DNS:homesafe-vault.local,IP:192.168.1.108"
```

The IP above is an **example**: replace it with your PC/Pi's actual home LAN IP. Keep the private key outside Git and grant access only to the account running Vault. On Windows, configure NTFS permissions for the key and `%USERPROFILE%\.homesafe-vault` (Node's POSIX file modes do not enforce Windows ACLs). On Linux/macOS use `chmod 600 vault.key`.

4. Initialize once, using absolute paths and the actual dashboard origin:

```sh
node src/cli.mjs init --root "/mnt/usb/HomeSafeBckup" --origin "https://your-vault-dashboard.example" --cert "/home/you/vault.crt" --key "/home/you/vault.key"
node src/cli.mjs start
```

On Windows substitute paths such as `E:\HomeSafeBckup` and `C:\Users\you\vault.crt`. `--state <absolute folder>` overrides the private settings directory for all commands. Initialization refuses to replace an existing configuration. Preserve this folder securely: losing its encryption key means existing identities cannot be verified. Do not put it on the shared drive or commit it.

5. In a second local terminal, run `node src/cli.mjs access`. This deliberately displays the private owner access key; never share it with phones. Sign in to the dashboard with email/Authy, then enter this key plus a profile and phone name under **Local Vault monitoring**. The drive is the one configured at initialization; browser folder selection cannot change the service's destination.
6. Permit inbound TCP 7879 **only on the private home network**. Never forward this port through your router. Port 7878 is loopback-only and must not be exposed. Stop with Ctrl+C. After a crash, remove `service.lock` from the settings folder only after confirming no other Vault process exists.

### Raspberry Pi automatic startup

Create `/etc/systemd/system/homesafe-vault.service` with your real username and paths (examples below), then run `sudo systemctl daemon-reload` and `sudo systemctl enable --now homesafe-vault`:

```ini
[Unit]
Description=HomeSafe local Vault
After=network-online.target
RequiresMountsFor=/mnt/usb/HomeSafeBckup
[Service]
Type=simple
User=your-user
WorkingDirectory=/home/your-user/homesafe/vault-service
ExecStart=/usr/bin/node src/cli.mjs start
UMask=0077
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
```

The service intentionally does not auto-restart after a crash while a stale lock exists. On Windows, use Task Scheduler at login with the same start command and working directory; do not run as administrator.

## Phone integration contract (HomeSafe companion still required)

The existing HomeSafe project has **not** been modified here. A native phone client must implement these operations before real phones can back up. Manual local IP connection is supported; automatic mDNS discovery, QR connection handoff and packaged native installers are not included. Browser-only mobile pages cannot securely substitute for a native key store and pinned TLS transport.

- Connect to `https://<Vault LAN IP>:7879`. Pin the SHA-256 certificate fingerprint displayed by the local start command, verifying it with the owner outside this connection. Never disable certificate verification in a production phone client. A self-signed certificate requires explicit native pinning; it will not be trusted automatically.
- Generate an Ed25519 device key in the phone's secure keystore; never send the private key. Retain that key across backups. The public key is base64-encoded DER SPKI.
- `POST /v1/challenge` returns a 30-second, single-use `challenge`; requests are rate-limited to five per IP per minute.
- `POST /v1/pair` sends `{profile, phone, code, publicKey, challenge, signature}`. `signature` is base64 Ed25519 over the UTF-8 bytes of `JSON.stringify(["homesafe-pair-v1", challenge, code, profile, phone, publicKey])`. `code` is the **six-digit pairing code**, not an Authy token. It rotates every 30 seconds only while awaiting; verification consumes it.
- The service checks the exact selected destination, signature, challenge and code, enrolls a new encrypted identity or verifies the existing one, then returns `{token, expiresIn:3600}`. Keep the token in memory. Phone folder names are unique within a profile. Existing browser/legacy phone folders are not adopted or overwritten; use a new phone name for native enrollment.
- After successful verification, show Full/Custom selection on the **phone**, not Vault. `POST /v1/backups` with `Authorization: Bearer <token>` sends `{kind:"Full"|"Custom", name?:string, files:[{path, bytes, sha256}]}`. Names default to `Full_Bckup_DDMMYY` / `Custom_Bckup_DDMMYY` in the Vault machine's local date. Existing same-date backups require a unique suffix. Relative paths must be safe; duplicate/case-colliding paths and reserved metadata are rejected. Manifest limit: 10,000 files and 2 MiB request body.
- Response `{id,name}` reserves a new backup. `PUT /v1/backups/<id>/files/<zero-based index>` streams each exact file body sequentially with the same bearer token. SHA-256, size and disk sync must succeed before file progress advances. Progress is completed files / declared files, not estimated elapsed time. Requests time out after two minutes; transfers idle for three minutes fail. Interrupted backups remain incomplete and are never reused automatically.
- `POST /v1/backups/<id>/complete` re-reads every file and verifies SHA-256 from disk, then writes the completed manifest and emits completion. `POST .../cancel` records failure. One active transfer at a time; pair again after completion/failure.

## Dashboard protocol and privacy

`ws://127.0.0.1:7878/v1/transfer-events` checks the exact configured browser Origin and a first `{type:"authenticate",token:<owner key>}` message. The key is not passed in the URL or persisted by the dashboard. After `service_ready`, the dashboard sends `{type:"select_destination",profile,phone}`. Only authenticated monitors receive codes and ordered real transfer events. Reconnecting replays the latest sequence. `{type:"reset"}` returns to awaiting only after a finished/failed transfer. An authenticated monitor may send `{type:"revoke_phone",profile,phone}`; revocation is persisted and immediately invalidates its sessions. Live phone-list/revoke controls are not yet surfaced in the dashboard; sample controls remain demonstrations.

`events.jsonl` stores only event type, timestamp and stalled stage, without email/profile names, phone names, tokens, codes or file paths. It rotates at approximately 1 MiB, keeping one previous file. No analytics service receives these events. Drive health UI integration is separate; the service uses actual filesystem free space to reject oversized transfers but does not yet provide temperature/health telemetry.

AES-256-GCM protects device identity, **not backup payloads**; files remain readable on the owner's drive. Use OS disk encryption for payloads at rest. Identity is checked before each file write. Symlink/path checks and exclusive writes reject ordinary collisions; an untrusted local user with filesystem write access could still race these checks—run under an isolated OS account with owner-only access.

## Verification

`npm test` exercises real sockets, signed enrollment, streaming disk writes, SHA-256 readback, expiry, identity mismatch, path rejection, duplicate dates, symlinks and revocation. Plain HTTP is available only to explicitly configured loopback test fixtures; the shipped CLI always requires TLS. Tests ran on Linux, not physical Windows, Raspberry Pi USB hardware, or Android/iPhone. The existing Authy gate must be passed by the user before dashboard monitoring; a password-only session is insufficient.