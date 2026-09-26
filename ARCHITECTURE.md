# TripSynch — data architecture

## What changed

The JSON store moved out of this (public) repository into a **separate private
GitHub repository**. The Render web service is untouched: same service, same
`rootDir: api`, same `npm start`, same `/health` check, same URL. Only where the
API reads and writes its JSON has changed, plus the environment variables that
point at it.

```
Before                                   After
──────                                   ─────
Browser / APK                            Browser / APK
      │                                        │
      ▼                                        ▼
Render web service  ─ GitHub API ─▶      Render web service ─ GitHub API ─▶
  (tripsynch)         PUBLIC repo          (tripsynch)         PRIVATE repo
                      ajaynerur-cloud/                         ajaynerur-cloud/
                      TripSynch                                TripSynch-Data
                      data/store.json                          data/store.json
                      ⚠ emails + password                      ✅ not world-readable
                        hashes world-readable                  ✅ history = audit log
```

## Why

`data/store.json` in a public repo means every account email and every scrypt
password hash is downloadable by anyone, and stays in the git history forever.
A private data repo keeps the application code open while the data is not, and
the commit log gives a free point-in-time backup of every mutation.

Render's filesystem is ephemeral, so local disk is not an option; GitHub
Contents API remains the storage engine, only the repository changes.

## Components

| File | Role |
|---|---|
| `api/storage.js` | All GitHub Contents API access: config resolution, ETag read cache, write lock, conflict retry, bootstrap, token redaction, health status. |
| `api/http-error.js` | Shared `httpError(message, status, extra)` used by routes and storage. |
| `api/server.js` | Express routes only. No GitHub code left in it. |
| `scripts/migrate-store-to-private-repo.mjs` | One-off copy of the existing store into the private repo. |

The HTTP contract is unchanged, so `frontend/`, `docs/` and the Capacitor APK
need no edits.

## Environment variables

New names are preferred; the legacy names still work as a fallback so a
half-configured deploy never loses storage.

| New | Legacy fallback | Default | Notes |
|---|---|---|---|
| `DATA_REPO_OWNER` | `GITHUB_OWNER` | — | GitHub user/org owning the data repo |
| `DATA_REPO_NAME` | `GITHUB_REPO` | — | The **private** data repo |
| `DATA_REPO_TOKEN` | `GITHUB_TOKEN` | — | Fine-grained PAT, `Contents: Read and write`, scoped to that one repo |
| `DATA_REPO_BRANCH` | `GITHUB_BRANCH` | `main` | |
| `DATA_FILE_PATH` | `DATA_PATH` | `data/store.json` | Path inside the data repo |
| `DATA_COMMIT_NAME` | — | `TripSynch Bot` | Commit author shown in the data repo |
| `DATA_COMMIT_EMAIL` | — | `tripsynch-bot@users.noreply.github.com` | |
| `ALLOW_PUBLIC_DATA_REPO` | — | `false` | Escape hatch for throwaway testing only |

## Behaviour of the storage layer

**Startup check.** `initStorage()` runs after `listen`. It verifies the token
can see the repo, **refuses to become ready if the data repo is public**, warns
if the token is read-only, and creates `data/store.json` if it does not exist
yet. The Contents API creates the `data/` directory as part of that first
commit, so the repo does not need it pre-made — though the seed files make it
explicit.

**Health gate.** `/health` returns `200` only when storage is ready, otherwise
`503` with a reason. A misconfigured deploy therefore fails Render's health
check and the previous version keeps serving instead of a broken one. The
payload names no owner, repo, path or token — `/health` is public.

**ETag read cache.** Reads send `If-None-Match` with `Cache-Control: no-cache`.
A `304` reuses the in-memory copy (deep-cloned on every hand-out, so callers can
mutate freely); any write from anywhere changes the ETag, so the cache cannot go
stale. This keeps a chatty UI well inside the 5000 req/h API budget.

**Write lock.** Every `mutateStore` call goes through one in-process promise
queue. Concurrent requests queue instead of racing on the same blob SHA. A
genuine conflict (409/422 from GitHub) invalidates the cache, forces a fresh
read and retries with jittered backoff, up to 5 attempts. Errors thrown by the
caller's own `change(store)` function — "Email is already registered",
"Trip not found" — are never retried or swallowed.

**Redaction.** The PAT, and anything shaped like a PAT, is stripped from every
log line and every error message. Raw GitHub response bodies are kept on
`error.detail` for the server log only; clients get
`"Trip data is temporarily unavailable. Please retry."` with status `503`.

**Legacy field strip.** Pre-V9 `ownerSecretHash` / `memberSecrets` are dropped
during normalization — dead code paths, and secret material that should not be
carried into the new repo.

## Cutover

1. The private repo `ajaynerur-cloud/TripSynch-Data` already exists. Commit the
   seed layout to it so `main` and the `data/` directory are in place:
   ```
   README.md
   data/store.json      {"version": 9, "users": [], "trips": []}
   ```
   (Optional — the service bootstraps `data/store.json` itself on first boot.)
2. Create a fine-grained PAT: *Only select repositories* → the data repo →
   Repository permissions → **Contents: Read and write**. Nothing else.
3. Migrate the existing data:
   ```bash
   DATA_REPO_OWNER=ajaynerur-cloud \
   DATA_REPO_NAME=TripSynch-Data \
   DATA_REPO_TOKEN=github_pat_xxx \
   npm run migrate:data:dry      # preview
   npm run migrate:data          # write
   ```
4. In Render → tripsynch → Environment, add the `DATA_REPO_*` variables and
   deploy. Confirm `GET /health` shows `storage.ready: true` and
   `storage.private: true`.
5. Remove the live data file from the application repo and stop tracking it:
   ```bash
   git rm --cached data/store.json
   git commit -m "chore: move live store into the private data repository"
   git push
   ```
   `.gitignore` now covers `data/store.json`; `data/store.example.json` stays.
6. Delete the old `GITHUB_OWNER` / `GITHUB_REPO` / `GITHUB_TOKEN` /
   `GITHUB_BRANCH` / `DATA_PATH` variables from Render.
7. **Revoke the old PAT** and treat everything that was in the public
   `data/store.json` as compromised: the file is still in this repo's git
   history. Either rewrite history (`git filter-repo --path data/store.json
   --invert-paths`, then force-push) or, at minimum, have every account reset
   its password. The pre-V9 `ownerSecretHash` values are already burned.

## Known carry-over

Trips created before V9 have no `ownerUserId`, so no account is a member of
them and they will not appear in **My Trips** after migration. The migration
script lists any such trips by invite code. They need to be re-created under a
logged-in account.
