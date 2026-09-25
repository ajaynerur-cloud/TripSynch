# TripSynch Settlement V3

## New settlement feature
- Settle tab shows the current optimized payment plan.
- Mark as settled records a real payment in `trip.settlements`.
- Recorded payments are applied to balances, immediately nullifying the corresponding outstanding amount.
- Settlement history includes date/time and an Undo button.
- Expenses are never deleted or changed when settling.

## Deploy
Push all files. Render redeploys the API. GitHub Pages publishes `main` `/docs`.

## Existing trips
No migration is needed. Trips without `settlements` are treated as having an empty settlement history.

## Android
```bash
npm install
npm run android:add
npm run android:debug
```
Or run the included GitHub Actions workflow.
