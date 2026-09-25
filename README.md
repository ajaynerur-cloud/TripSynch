# TripSynch V8 Complete

V8 is based on the supplied V5 source and preserves create/join, invite/QR, persistent payer radio selection, expense splitting, expense timestamps, People and Details views, settlement marking/history/undo, GitHub JSON storage, Render API, GitHub Pages, PWA and Android APK workflows.

## Responsive layout
- Phone: single-column cards and fixed five-tab navigation.
- Tablet: two-column panels and four-column metrics.
- Desktop: 1200px workspace, sticky expense form and two-column audit cards.
- Very small phones: single-column metrics and stacked expense rows.

## Branding
The uploaded TripSynch artwork is used for PWA icons, favicon, Apple touch icon, onboarding/header branding, Android launcher source and splash source.

## Deploy
1. Drag all files into the Git repository root and replace old files.
2. Commit and push.
3. Render: clear build cache and deploy. `/health` returns TripSynch API v8.
4. GitHub Pages: publish `main` `/docs`.
5. APK: Actions > Build Android APK > Run workflow.
