# TripSynch V6

Render serves both the frontend and API from `https://tripsynch.onrender.com`. GitHub is used only for JSON persistence.

## Preserved features
Create/join, QR invite, native share, persistent payer radio buttons, split members, timestamps, My Position, People, Details with per-person split reasoning, settlement suggestions, Mark Settled, settlement history, Undo, delete trip, PWA, Capacitor and APK workflow.

## Render environment
Set `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_TOKEN`, `GITHUB_BRANCH=main`, `DATA_PATH=data/store.json`, and `PUBLIC_APP_URL=https://tripsynch.onrender.com`.

## Deploy
Push all files, then use Render **Clear build cache and deploy**. Open `/health` and confirm `TripSynch API v6`. GitHub Pages is not used.

## APK
Run the included GitHub Actions workflow or use `npm install`, `npm run android:add`, and `npm run android:debug`. QR and share links always use the public Render URL, never Android localhost.
