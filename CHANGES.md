# Change set — private data repository

Drop these files into your working copy of `ajaynerur-cloud/TripSynch`, keeping
the paths. The Render web service definition is unchanged apart from env vars.

## New files
| Path | Purpose |
|---|---|
| `api/storage.js` | Private-repo storage layer: config + fallback, ETag read cache, write lock, conflict retry, bootstrap, redaction, health status. |
| `api/http-error.js` | Shared error helper. |
| `api/.env.example` | Local dev template. |
| `scripts/migrate-store-to-private-repo.mjs` | One-off data migration. |
| `.gitignore` | Stops `data/store.json` ever being committed again. |
| `ARCHITECTURE.md` | Design, env-var table, cutover runbook. |

## Modified files
| Path | Change |
|---|---|
| `api/server.js` | GitHub plumbing removed (now imported from `storage.js`); `/health` reports storage and returns 503 when not ready; `/api/*` refuses to serve if the data repo is public; error middleware redacts and no longer echoes GitHub detail to clients. Every route body is byte-for-byte unchanged. |
| `render.yaml` | `DATA_REPO_*` env vars replace `GITHUB_*` / `DATA_PATH`; `DATA_FILE_PATH=data/store.json`. |
| `api/package.json` | Version 10.1.0; `check` script covers the new modules. |
| `package.json` | Version 10.1.0; adds `migrate:data` and `migrate:data:dry`. |
| `README.md` | Data-storage section rewritten. |

## Unchanged
`frontend/`, `docs/`, `assets/`, `capacitor.config.json`, the APK workflow, and
the Render service itself (type, runtime, rootDir, build/start commands, health
check path, auto-deploy off). The HTTP API contract did not change, so no
client rebuild is required.

## Deleted from the repo (do this manually)
```bash
git rm --cached data/store.json
```
`data/store.example.json` stays.

## Data repository layout

`ajaynerur-cloud/TripSynch-Data` (private):

```
README.md
data/
  store.json     ← the live store
```

Seed files for it are in the separate `TripSynch-Data-seed/` folder. Committing
them is optional: the service creates `data/store.json`, directory included, on
first boot if it is absent.

## Verification performed
The full stack was exercised against an in-memory GitHub Contents API:

```
PASS  health 200, storage ready + private
PASS  bootstrapped store.json on first boot
PASS  health leaks no repo name or token
PASS  signup writes to private repo
PASS  caller 409 passes through untouched      (not misread as a write conflict)
PASS  login reads from private repo
PASS  create trip
PASS  5 concurrent expense writes all succeed
PASS  all 5 expenses persisted                 (write lock, zero lost updates)
PASS  ETag 304 served from cache (9x)
PASS  GitHub 409 retried transparently
PASS  legacy secret fields stripped
PASS  store shape correct
PASS  public data repo -> /health 503          (Render keeps the old version)
PASS  public data repo -> /api/* refuses to write
PASS  missing DATA_REPO_* -> /health 503
PASS  storage error is generic to the client
PASS  PAT never appears in logs / responses
PASS  migration dry-run, real run, public-target refusal, overwrite guard
```
