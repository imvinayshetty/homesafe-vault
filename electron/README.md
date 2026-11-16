# HomeSafe Vault desktop app

Opens the Vault dashboard and starts the local Vault service automatically — no terminal, no access key to copy.

First launch: pick the `HomeSafeBckup` folder on your USB drive once. After that the app starts at login, runs the service in the background, and connects monitoring by itself.

Build (on Windows for `.exe`, or a Raspberry Pi for arm64):

    cd electron
    npm install
    npm run package:win          # → release/HomeSafe Vault-win32-x64/HomeSafe Vault.exe
    npm run package:linux-arm64  # Raspberry Pi

Set `HOMESAFE_VAULT_URL` to your published dashboard address before launching if it differs from the default.
