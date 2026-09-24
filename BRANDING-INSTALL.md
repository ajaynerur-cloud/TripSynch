# TripSynch Branding Git Overlay

Extract and drag all files into the root of the existing TripSynch repository. Merge folders, then run:

```bash
node apply-branding.mjs
npm install
npx cap add android
npm run assets:generate
npx cap sync android
git add .
git commit -m "Add TripSynch logo and APK branding"
git push
```

Build APK:

```bash
cd android
./gradlew assembleDebug
```

APK: `android/app/build/outputs/apk/debug/app-debug.apk`

This overlay does not replace app.js, API code, or trip data.
