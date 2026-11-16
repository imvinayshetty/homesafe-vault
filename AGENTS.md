<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

## What Lovable manages

Rules outside this block are the project's own. Change the pieces below in
Lovable, not by hand. With the [Lovable MCP](https://mcp.lovable.dev)
connected, `send_message` asks Lovable to do it; otherwise ask the user to
use the editor.

- **Database.** Do not add or edit `supabase/migrations/` or `drizzle/`.
  Ask Lovable to change the schema.
- **Generated files.** Do not edit a file whose header says it is automatically
  generated.
- **AI gateway.** Keep model calls on Lovable's gateway, and keep
  `LOVABLE_API_KEY` out of browser code.
- **Connectors.** Lovable provides native connectors. `list_connectors` shows
  which are enabled; `add_connector` only returns the dashboard link. When a
  connector is enabled, calls go through the connector gateway and need
  `LOVABLE_API_KEY`. When Lovable does not provide one, users can bring their
  own key and store it in Secrets.
- **Secrets.** Lovable manages them. Do not put secret values in the repo.
<!-- LOVABLE:END -->

## Local backup boundaries
- Emit account analytics directly from existing successful action handlers with only fixed flow/step labels; infer drop-off from missing subsequent milestones rather than treating page exits or authentication errors as abandonment.
- Present account access and local destination setup as replacing, focus-managed screens; expose monitoring controls only after the setup flow to prevent out-of-sequence actions.
- Keep browser folder I/O and cryptographic enrollment in `src/lib/local-backup.ts`, invoked only from effects or user actions; the hosted runtime cannot access the owner's USB disk.
- Persist directory handles and non-exportable device keys in IndexedDB, never cloud storage; this workflow must stay local and handles need explicit browser permission.
- Treat browser enrollment as browser identity, not phone identity; native phone enrollment and LAN transfer require separate companion software and must never be simulated as verified phone access.
- Verify AES-GCM profile identity before every write and reject collisions before creating a backup; existing backups must never be overwritten.
- Scan user-authorized storage metadata through `src/lib/backup-catalog.ts` for cross-profile filtering, without granting writes to other profiles; report unreadable records rather than silently hiding them.
- Never use browser-origin storage estimates as external-drive capacity; space warnings require a real write-limit error until a local companion can report disk space.
- Derive storage-health trends from completed catalog manifest payload sizes across all profiles, independently of saved-backup filters; these sizes are not filesystem usage or capacity measurements.
- New browser-file backups require a named phone destination and bind AES-GCM identity to profile/phone; retain legacy profile-level records read-only to avoid implicit migration or overwrite.
- Vault account and pairing screens remain unavailable without the local service; never store TOTP secrets in browser settings or manufacture a successful login, pairing QR, or phone revocation.
- Transfer stages advance only via the pure reducer in src/lib/vault-daemon.ts fed by the local Vault service loopback WebSocket; the browser never invents stage progress.
- Display live phone-pairing codes only from expiring local-service events on the awaiting screen; isolate 30-second sample rotation from authentication so demonstrations cannot grant access.
- Keep the Node local companion in vault-service, outside the hosted app import graph; it owns native disk I/O and HTTPS phone uploads, while the dashboard uses an origin-checked, owner-key-authenticated loopback socket.
- Keep native-service destinations separate from browser-enrolled phone folders; existing encrypted browser identities must not be silently migrated or replaced.
- Record real backup activity only in the companion's bounded local event log; never send pairing or transfer analytics to cloud tracking.
- Support HomeSafe's existing native signed begin/confirm and chunk protocol in a separate local adapter; never change the hosted app into a TLS or native-key proxy.
- Guided installers use OS startup tools with argument arrays, protect local keys, and persist verified drive identity; startup must reject replaced drives rather than silently adopt them.
