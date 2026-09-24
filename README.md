# TripSynch Enhanced Settlement View

This release adds detailed person balances, expense-level shares, and payment explanations.

## Deploy API
1. Push all files to the `TripSynch` GitHub repository.
2. In Render, deploy the repository with root directory `api`, build command `npm install`, and start command `npm start`.
3. Set `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_TOKEN`, `GITHUB_BRANCH=main`, `DATA_PATH=data/store.json`, and `ALLOWED_ORIGIN=https://YOUR_USER.github.io`.
4. Confirm `/health` returns `ok: true`.

## Deploy Pages
1. Keep the actual Render URL in `frontend/config.js`.
2. Run:
```bash
rm -rf docs
cp -R frontend docs
git add .
git commit -m "Deploy TripSynch enhanced details"
git push
```
3. GitHub repository Settings > Pages > Deploy from branch > main > `/docs`.

## Important fix
The API uses `splitAmong.map(value => clean(value, 100))`. Do not change it back to `splitAmong.map(clean)`.

## Calculation
For each person: `net balance = total paid - allocated shares`. Positive means receive; negative means pay. The payment plan matches debtors and creditors without changing anyone's final net amount. Rounding remainder is assigned to the final participant of an expense.
