# Backup workflow
- [ ] Review the HomeSafe mobile changes for local email/profile access, named phones and QR/manual-IP pairing before implementation; applying them requires the HomeSafe project chat, and real enrollment/transfer requires native phone apps and a local Vault service.
- [x] Add profile/type/date filters and storage access, space and unreadable-folder warnings; verify filtering and warning states with a browser folder adapter. External-drive capacity is unavailable in browsers; space warnings respond to actual write-limit errors.
- [x] Add local-folder browser profile registration and AES-256 identity verification.
- [x] Add selected-file backups, date naming, duplicate protection and location recovery.
- [x] Show Android/iPhone limitations and distinguish browser identity from native phone enrollment.
- [x] Test rules and verify encryption, file readback and duplicate handling using a browser folder adapter; native disk permission cannot be automated here.
- [ ] HomeSafe mobile enrollment and LAN transfer: blocked on native companion software and changes in the HomeSafe project.