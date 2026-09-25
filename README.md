# TripSynch V10

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

## Data safety
This package contains `data/store.example.json` and does not overwrite your populated `data/store.json`.
