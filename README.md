# TripSynch radio-payer UI update

Replace the repository `frontend/` and `docs/` folders with the folders in this package.

The update replaces the Paid By dropdown with persistent radio cards. The selected payer is preserved in `data-selected-payer` while the four-second refresh rebuilds the screen.

## Publish

```bash
git add frontend docs
git commit -m "Replace payer dropdown with persistent radio buttons"
git push
```

GitHub Pages serves the `docs/` copy. The service worker cache has been increased to `tripsynch-v4`.
