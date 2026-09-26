# TripSynch V10.1

V10 preserves all V9 functionality and adds the supplied TripSynch branding across browser tabs, PWA installation, Windows/macOS/Linux desktop installation, iPhone/iPad home screen, Android launcher/adaptive assets, APK, splash screen, login screen, My Trips header, and active trip header.

## Branding assets
- Master native icon: `assets/icon.png`
- Capacitor source: `assets/icon-only.png`
- Splash source: `assets/splash.png`
- Browser/PWA icons: `frontend/assets/icons/`
- Favicon: ICO plus 16px and 32px PNG
- Apple touch icon: 180px PNG
- PWA icons: 192px, 512px, and 1024px

## Preserved V9 functionality
Signup, login, logout, automatic invite join after authentication, My Trips, owner and invitee roles, expenses, payer radio buttons, split selection, timestamps, My Position, People, Details, settlements, settlement history, Undo, Settle & Remove, Remove, Leave Trip, Delete Trip, Render frontend/API, GitHub JSON storage, no-store frontend delivery, old cache cleanup, manual-only APK build, and Render auto-deploy disabled.

## Build APK
Run the `Build TripSynch V10 APK` workflow manually. The workflow generates native Android launcher and splash assets before Gradle builds the APK.

## Data storage
The JSON store lives in a **separate private GitHub repository**, not in this repo. The Render web service is unchanged; only the storage target and its environment variables moved. See [ARCHITECTURE.md](ARCHITECTURE.md) for the design, the full env-var table and the cutover steps.

Quick version:

```bash
DATA_REPO_OWNER=ajaynerur-cloud \
DATA_REPO_NAME=TripSynch-Data \
DATA_REPO_TOKEN=github_pat_xxx \
npm run migrate:data
```

Then set `DATA_REPO_OWNER`, `DATA_REPO_NAME` and `DATA_REPO_TOKEN` in Render and redeploy. `GET /health` returns `200` only when storage is ready and the data repo is private; it returns `503` otherwise, so a misconfigured deploy fails its health check instead of going live.

## Data safety
`data/store.json` is gitignored and no longer part of this repository. `data/store.example.json` is kept as the empty shape. Live data is only ever in the private data repo, whose commit history doubles as a point-in-time backup.
