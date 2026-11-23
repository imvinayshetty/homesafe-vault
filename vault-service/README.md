# HomeSafe Vault local service

Standalone Node.js 22+ companion for a Windows/Linux/macOS PC or Raspberry Pi OS (64-bit). This folder runs **on the machine with the USB drive**, not Vercel or Lovable Cloud. It is not imported by the website. Cloud handles the website's existing sign-in only. Pairing, identity, files and the activity log stay local.

## Install and run

### Guided setup (Windows PC or Raspberry Pi/Linux)

Install Node.js 22+ and OpenSSL, download this repository, then open a terminal in `vault-service`:

```sh
npm install
node src/cli.mjs install
```

The local wizard asks for an existing `HomeSafeBckup` folder, verifies a temporary write/read/delete without touching backups, shows real free space, and asks you to confirm the intended drive. It asks for your dashboard origin and private LAN IPv4 address, creates a private certificate/key and saved drive identity, then offers automatic startup. Windows uses a least-privilege owner-logon scheduled task; Linux/Pi uses a user systemd service. Startup is checked against the running service's drive-ready endpoint. No OS setup occurs in the hosted browser.

For an unattended Pi, after setup explicitly run `sudo loginctl enable-linger <your-username>` to start the user service at boot without a login. Mount the drive through your OS before the service starts; use a stable mount/drive letter. A missing or changed drive causes a safe startup failure, not a fallback write. If the drive mounts late, start the user service again after mounting. Keep the repository in its installed location: startup refers to its absolute path.

Run `node src/cli.mjs doctor` to repeat actual drive write/read verification, check certificate expiry, and confirm the service is ready. Existing settings and startup registrations are never silently replaced. If startup registration fails after configuration, keep the saved keys and use the manual start command; do not initialize again. The installer does not download Node/OpenSSL or change firewall/router settings. Windows and physical Raspberry Pi startup need hardware verification; tests here validate startup definitions and actual Linux drive checks.

### HomeSafe Android/iPhone app

Vault speaks only **Phone protocol v1** (below). Build/install the native HomeSafe app from its own project; its browser preview cannot substitute. This Node service replaces HomeSafe's Python service; never run both, they share port 7443.

1. Start Vault (desktop app, guided installer or `start`). Sign into the dashboard with email/Authy and name the profile and phone.
2. On the phone, scan the QR on the **Awaiting connection** card, find the Vault over Wi-Fi (mDNS), or type the address and grouped certificate fingerprint shown next to the code.
3. Confirm the offered profile/phone on the phone, choose Full/Custom, pick files and start. The dashboard animation advances only from real service events.

Native-protocol socket/disk tests pass; physical Android/iPhone TLS pinning and app installation are not verified here.

### Manual setup

1. Install Node.js 22 LTS or newer and download this repository to the Vault machine. Open a terminal in `vault-service`, then run `npm install` (or `bun install`).
2. Mount your drive yourself and create its `HomeSafeBckup` folder. Do not use an automount path that silently falls back to your PC's system drive. The service rejects a changed/missing drive root; it never recreates it.
3. Create a local TLS certificate outside the repository. With OpenSSL, for example:

```sh
openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 1825 -keyout vault.key -out vault.crt -subj "/CN=homesafe-vault.local" -addext "subjectAltName=DNS:homesafe-vault.local,IP:192.168.1.108"
```

The IP above is an **example**: replace it with your PC/Pi's actual home LAN IP. Keep the private key outside Git and grant access only to the account running Vault. On Windows, configure NTFS permissions for the key and `%USERPROFILE%\.homesafe-vault` (Node's POSIX file modes do not enforce Windows ACLs). On Linux/macOS use `chmod 600 vault.key`.

4. Initialize once, using absolute paths and the actual dashboard origin:

```sh
node src/cli.mjs init --root "/mnt/usb/HomeSafeBckup" --origin "https://your-vault-dashboard.example" --cert "/home/you/vault.crt" --key "/home/you/vault.key"
node src/cli.mjs start
```

On Windows substitute paths such as `E:\HomeSafeBckup` and `C:\Users\you\vault.crt`. `--state <absolute folder>` overrides the private settings directory for all commands. Initialization refuses to replace an existing configuration. Preserve this folder securely: losing its encryption key means existing identities cannot be verified. Do not put it on the shared drive or commit it.

5. In a second local terminal, run `node src/cli.mjs access`. This deliberately displays the private owner access key; never share it with phones. Sign in to the dashboard with email/Authy, then enter this key plus HomeSafe email, profile and phone name under **Local Vault monitoring**. The drive is the one configured at initialization; browser folder selection cannot change the service's destination.
6. Permit inbound TCP 7443 **only on the private home network**. Never forward this port through your router. Port 7878 is loopback-only and must not be exposed. Stop with Ctrl+C. After a crash, remove `service.lock` from the settings folder only after confirming no other Vault process exists.

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

## Phone protocol v1 (reference)

### Ports
- `7443/tcp` HTTPS on the PC/Pi's home Wi-Fi address — phones only. Allow it on the private network only; never port-forward.
- `7878/tcp` loopback only — dashboard WebSocket `/v1/transfer-events` (origin-checked, owner key) and `GET /v1/ready`.
- The service polls the default-route address every 30 s. On a change it restarts the phone listener on the new address and re-advertises mDNS. The certificate is **not** regenerated (phones pin its fingerprint).

### Certificate
Self-signed, 5-year lifetime (1825 days). Phones pin `fp` = lowercase hex SHA-256 of the DER certificate. The dashboard shows the expiry next to the pairing code and warns 60 days before; `doctor` reports days left and fails when expired.

### Pairing URI (QR)
`homesafe://pair?v=1&host=<IPv4>&port=7443&fp=<64 hex>&code=<6 digits>&email=<account email>`
Profile and phone are **not** in the URI; the phone receives them in the `/v1/pair/begin` response. Codes rotate every 30 s while awaiting; **Pair mobile device** mints a single-use 120 s code. Manual fallback: the dashboard shows `https://<host>:7443` and the fingerprint grouped in 4-hex blocks, both copyable.

### mDNS
Service type `_homesafe._tcp.local.`, instance name `HomeSafe Vault <short random suffix>` (never the PC hostname), port 7443, TXT `v=1`, `fp=<fingerprint>`.

### Signatures
Ed25519; `publicKey` is the raw 32-byte key, base64. The signed bytes are **canonical JSON** of a flat object: keys sorted by Unicode code point (= UTF-8 byte order, not UTF-16/locale order), no whitespace, non-ASCII as raw UTF-8, integers only. Vectors with key order, Devanagari, emoji and large numbers: `protocol/test-vectors.json` (checked by `test/protocol.test.mjs`).

| Route (POST, JSON) | Request | Signed fields | Response |
| --- | --- | --- | --- |
| `/v1/pair/begin` | `email, code, deviceId, publicKey, signature` | `email, code, deviceId, publicKey` | `requestId, challenge, expiresAt, email, profile, phone` |
| `/v1/pair/confirm` | `requestId, signature` | `requestId, challenge, profile, phone` | `connected, email, profile, phone` |
| `/v1/device/challenge` | `deviceId` | — | `challenge, expiresAt` (30 s, single use) |
| `/v1/backups` | `deviceId, challenge, signature` | `deviceId, challenge, action:"catalog"` | `backups[]` |
| `/v1/backup/start` | `deviceId, challenge, name, kind, files[≤5000], fileCount?, bytes?, signature` | `deviceId, challenge, action:"backup", name, kind, files:<file count>, bytes:<total bytes>` | `transferId, token, manifestComplete` |
| `/v1/backup/files` | `transferId, token, offset, files[≤5000]` | — (transfer token) | `received, manifestComplete` |
| `/v1/backup/chunk` | raw body ≤4 MiB; headers `X-Transfer-Id, X-Transfer-Token, X-File-Index, X-Offset, X-Sha256` | — | `received` |
| `/v1/backup/finish` | `transferId, token` | — | `state:"complete", sentBytes, totalBytes` |

`files` entries are `{path, bytes}`. Start an inline backup with a non-empty `files` array and no `fileCount` (optional `bytes` must equal its sum). For a paged backup send `files: []`, integer `fileCount` from 1 to 500,000, and `bytes` equal to the signed total; the response has `manifestComplete: false`. The signature still uses the field names `files` (the total count) and `bytes`, not `fileCount`.

Send pages to `/v1/backup/files` as `{transferId, token, offset, files}` **before the first chunk**. The token must match the active transfer; `offset` must equal the number of entries already accepted (starting at 0). Gaps, repeats, case-insensitive duplicate paths, invalid paths/sizes, and entries beyond `fileCount` are rejected without adding the page. Each page is at most 5,000 entries and each JSON request is at most 2 MiB. The final page's byte sum must exactly equal the signed `bytes`; exceeding it at any point is rejected. Responses are `{received, manifestComplete}`.

Chunks and finish are refused with `too_many_files` until all declared entries are accepted and their sizes match the signed total. This preflight rejection writes no payload, does not mark a backup complete, and leaves the transfer available for valid pages and retry. Other chunk/write failures still fail the transfer. Chunks must arrive at the exact next byte offset with a matching SHA-256; existing files and backups are never overwritten. Names default to `Full_Bckup_DDMMYY` / `Custom_Bckup_DDMMYY` (Vault's local date); same-date backups need a unique suffix. `/v1/pair/begin` is limited to five attempts per IP per minute. Requests with an `Origin` header are rejected. `GET /v1/info` returns `{name, version:1}`.

### Errors
Every failure returns `{ "error": "<fixed message>", "code": "<code>" }`. Messages never contain file names, emails, profile or phone names.

| code | HTTP | meaning |
| --- | --- | --- |
| `code_expired` | 400 | pairing code, confirmation or device challenge expired / wrong |
| `wrong_account` | 400 | email or device not matching the account/phone selected on the Vault |
| `phone_revoked` | 400 | phone was removed on the dashboard; pair again |
| `drive_unavailable` | 503 | backup drive disconnected or replaced |
| `name_exists` | 409 | a backup with this name (or same date without suffix) exists |
| `no_space` | 507 | not enough free space for the declared total bytes |
| `transfer_active` | 409 | another backup is in progress |
| `too_many_files` | 400 | page over 5,000, backup over 500,000 files, or chunk/finish before the complete size-matched manifest |
| `rate_limited` | 429 | too many pairing attempts |
| `invalid_request` | 400 | bad signature, field, offset, digest or unknown route |

## Dashboard protocol and privacy

`ws://127.0.0.1:7878/v1/transfer-events` checks the exact configured browser Origin and a first `{type:"authenticate",token:<owner key>}` message. The key is not passed in the URL or persisted by the dashboard. After `service_ready`, the dashboard sends `{type:"select_destination",profile,phone}`. Only authenticated monitors receive codes and ordered real transfer events. Reconnecting replays the latest sequence. `{type:"reset"}` returns to awaiting only after a finished/failed transfer. An authenticated monitor may send `{type:"revoke_phone",profile,phone}`; revocation is persisted; the phone then receives `phone_revoked` and any of its active transfers fail. Live phone-list/revoke controls are not yet surfaced in the dashboard; sample controls remain demonstrations.

`events.jsonl` stores only event type, timestamp and stalled stage, without email/profile names, phone names, tokens, codes or file paths. It rotates at approximately 1 MiB, keeping one previous file. No analytics service receives these events. Drive health UI integration is separate; the service uses actual filesystem free space to reject oversized transfers but does not yet provide temperature/health telemetry.

AES-256-GCM protects device identity, **not backup payloads**; files remain readable on the owner's drive. Use OS disk encryption for payloads at rest. Identity is checked before each file write. Symlink/path checks and exclusive writes reject ordinary collisions; an untrusted local user with filesystem write access could still race these checks—run under an isolated OS account with owner-only access.

## Verification

`npm test` exercises real sockets, signed native enrollment, error codes, canonical-JSON vectors, manifest paging, address-change restarts, certificate expiry, streaming disk writes, SHA-256 readback, expiry, identity mismatch, path rejection, duplicate dates, symlinks and revocation. Plain HTTP is available only to explicitly configured loopback test fixtures; the shipped CLI always requires TLS. Tests ran on Linux, not physical Windows, Raspberry Pi USB hardware, or Android/iPhone. The existing Authy gate must be passed by the user before dashboard monitoring; a password-only session is insufficient.