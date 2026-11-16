# HomeSafe Vault desktop app (Windows / macOS)

The dashboard is bundled inside the app and opens locally — no public web address. Only sign-in (email + Authy) uses the internet. The local Vault service starts automatically.

First launch: pick the `HomeSafeBckup` folder on your USB drive once.

Build:

    cd electron
    npm install
    npm run package:win          # Windows x64
    npm run package:mac          # macOS Apple Silicon + Intel (unsigned)
    npm run package:linux-arm64  # Raspberry Pi
