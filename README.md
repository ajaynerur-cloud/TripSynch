# TripSynch

Plan together. Spend together. Settle together.

TripSynch is a GitHub Pages frontend with a small Node API that writes trip records into `data/store.json` through GitHub's repository contents API. Open clients poll every four seconds for near-real-time updates.

## Project structure

```text
TripSynch/
├── api/
│   ├── package.json
│   └── server.js
├── data/
│   └── store.json
├── frontend/
│   ├── app.js
│   ├── config.js
│   ├── index.html
│   ├── manifest.webmanifest
│   ├── styles.css
│   └── sw.js
├── .gitignore
├── render.yaml
└── README.md
```

## 1. Push to GitHub

Create a repository named `TripSynch`, extract this ZIP, open a terminal in the extracted folder, and run:

```bash
git init
git add .
git commit -m "Initial TripSynch project"
git branch -M main
git remote add origin https://github.com/YOUR_USER/TripSynch.git
git push -u origin main
```

## 2. Create a GitHub token

Create a fine-grained personal access token restricted to the TripSynch repository with **Contents: Read and write**. Never place the token in frontend files or an APK.

## 3. Deploy the API to Render

Create a Render Blueprint from this repository. The included `render.yaml` configures the service. Set these environment variables:

```text
GITHUB_OWNER=YOUR_GITHUB_USERNAME
GITHUB_REPO=TripSynch
GITHUB_TOKEN=YOUR_FINE_GRAINED_TOKEN
GITHUB_BRANCH=main
DATA_PATH=data/store.json
ALLOWED_ORIGIN=https://YOUR_GITHUB_USERNAME.github.io
```

After deployment, open the API health endpoint. It should return an object containing `ok: true`.

## 4. Configure the frontend

Edit `frontend/config.js` and replace the placeholder with the actual Render service URL:

```javascript
window.TRIPSYNCH_CONFIG = {
  API_BASE: "https://YOUR-ACTUAL-SERVICE.onrender.com"
};
```

The value must be a plain URL string. Do not paste an HTML link or `<a>` tag.

## 5. Publish GitHub Pages

From the project root:

```bash
rm -rf docs
cp -R frontend docs
git add frontend docs
git commit -m "Publish TripSynch Pages site"
git push
```

In the repository, open **Settings > Pages**, choose **Deploy from a branch**, select `main` and `/docs`, then save. The site will normally use this pattern:

```text
https://YOUR_GITHUB_USERNAME.github.io/TripSynch/
```

Set Render's `ALLOWED_ORIGIN` to the origin only:

```text
https://YOUR_GITHUB_USERNAME.github.io
```

Do not include `/TripSynch/` in `ALLOWED_ORIGIN`.

## 6. Test

1. Open the GitHub Pages site.
2. Create a trip.
3. Copy the invite link.
4. Open the link in another browser or private window.
5. Join and add an expense.
6. Wait up to four seconds for the other open client to refresh.

## 7. Capacitor Android build

If your Capacitor configuration uses `www` as `webDir`:

```bash
rm -rf www
cp -R frontend www
npx cap sync android
cd android
./gradlew assembleDebug
```

Expected debug APK location:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

## Security and design limits

- GitHub Pages is static, so the API is required to protect the GitHub token.
- If the repository is public, `data/store.json` is publicly readable. Use a separate private data repository for non-public trip data.
- Ending a trip removes it from the current JSON file, but Git history can retain older values.
- Git-backed JSON is suitable for a small, low-frequency personal app, not a high-volume transactional system.
- Near-real-time behavior is implemented through four-second polling, not WebSockets.

## Troubleshooting

- **401/403 from GitHub:** verify token access and the Contents read/write permission.
- **CORS error:** ensure `ALLOWED_ORIGIN` exactly matches the GitHub Pages origin.
- **QR not visible:** verify `frontend/config.js` contains the correct HTTPS API URL.
- **Old frontend remains cached:** increment `tripsynch-v1` in `frontend/sw.js`, copy `frontend` to `docs` again, commit, and push.
