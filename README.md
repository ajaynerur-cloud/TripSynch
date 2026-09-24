# TripSynch Mobile V2

## Publish Pages
Use repository Settings > Pages > Deploy from a branch > main > /docs.

## Render
Create a Blueprint using render.yaml and set the prompted environment values.

## Android locally
```bash
npm install
npm run android:add
npm run android:debug
```
APK: `android/app/build/outputs/apk/debug/app-debug.apk`

## Android on GitHub
Actions > Build Android APK > Run workflow, then download the artifact.
