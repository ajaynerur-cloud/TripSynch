// api/storage.js
// TripSynch storage layer: the JSON store lives in a PRIVATE GitHub repository.
//
// Why a separate private repo:
//   - the application repo stays public (Pages/docs, APK workflow, shareable code)
//   - the store contains emails and scrypt password hashes, which must never be public
//   - the data repo's commit history doubles as an audit log / point-in-time backup
//
// Everything below talks to the GitHub Contents API. No database, no disk state
// (Render's filesystem is ephemeral, so disk would be lost on every deploy).

import crypto from "node:crypto";
import { httpError } from "./http-error.js";

const API_ROOT = "https://api.github.com";
const USER_AGENT = "TripSynch-Storage";
const API_VERSION = "2022-11-28";
const MAX_WRITE_ATTEMPTS = 5;
const STORE_VERSION = 9;
const PRIVACY_ERROR = "Data repository must be private";

/* ------------------------------------------------------------------ config */

const pick = (...keys) => {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
};

// New DATA_REPO_* names are preferred. The legacy GITHUB_* names are kept as a
// fallback so an in-flight deploy never loses its storage configuration.
export const config = Object.freeze({
  owner: pick("DATA_REPO_OWNER", "GITHUB_OWNER"),
  repo: pick("DATA_REPO_NAME", "GITHUB_REPO"),
  branch: pick("DATA_REPO_BRANCH", "GITHUB_BRANCH") || "main",
  filePath: (pick("DATA_FILE_PATH", "DATA_PATH") || "store.json").replace(/^\/+/, ""),
  token: pick("DATA_REPO_TOKEN", "GITHUB_TOKEN"),
  committerName: pick("DATA_COMMIT_NAME") || "TripSynch Bot",
  committerEmail: pick("DATA_COMMIT_EMAIL") || "tripsynch-bot@users.noreply.github.com",
  allowPublicDataRepo: pick("ALLOW_PUBLIC_DATA_REPO") === "true"
});

const repoUrl = () => `${API_ROOT}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
const contentsUrl = () =>
  `${repoUrl()}/contents/${config.filePath.split("/").map(encodeURIComponent).join("/")}`;

/* --------------------------------------------------------------- redaction */

const TOKEN_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /\b[0-9a-f]{40}\b/g
];

/** Strip the PAT (and anything shaped like one) out of any string before it is logged. */
export function redact(value) {
  let text = typeof value === "string" ? value : String(value ?? "");
  if (config.token) text = text.split(config.token).join("***");
  for (const pattern of TOKEN_PATTERNS) text = text.replace(pattern, "***");
  return text;
}

/** Log helper: callers never build log strings by hand. */
const logWarn = (...parts) => console.warn(redact(parts.join(" ")));
const logInfo = (...parts) => console.log(redact(parts.join(" ")));

/* ------------------------------------------------------------ http plumbing */

function requestHeaders(extra = {}) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${config.token}`,
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": USER_AGENT,
    // Force the CDN to revalidate with origin instead of serving a stale blob.
    "Cache-Control": "no-cache",
    ...extra
  };
}

/**
 * One GitHub call. Returns { status, etag, body }.
 * Never throws the raw GitHub response body at the caller: the detail is kept
 * on the error object (redacted) for the server log, while `message` stays generic.
 */
async function githubRequest(method, url, { body, etag, allow = [] } = {}) {
  if (!isConfigured()) throw storageError("Data repository is not configured", { detail: describeMissing() });

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: requestHeaders({
        ...(etag ? { "If-None-Match": etag } : {}),
        ...(body ? { "Content-Type": "application/json" } : {})
      }),
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (cause) {
    throw storageError("Could not reach the data repository", { detail: redact(cause?.message), cause });
  }

  if (response.status === 304) return { status: 304, etag, body: null };
  if (response.ok || allow.includes(response.status)) {
    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    return { status: response.status, etag: response.headers.get("etag"), body: payload };
  }

  const detail = redact(await response.text().catch(() => ""));
  const remaining = response.headers.get("x-ratelimit-remaining");

  if (response.status === 401 || response.status === 403) {
    if (remaining === "0") {
      throw storageError("Data repository rate limit reached, retry shortly", {
        detail: `429-equivalent; reset=${response.headers.get("x-ratelimit-reset")}`
      });
    }
    throw storageError("Data repository credentials were rejected", { detail: `${response.status} ${detail}` });
  }
  if (response.status === 409 || response.status === 422) {
    throw storageError("Data repository write conflict", { detail: `${response.status} ${detail}`, conflict: true });
  }
  throw storageError("Data repository request failed", { detail: `${method} ${response.status} ${detail}` });
}

function storageError(message, { detail = "", conflict = false, cause } = {}) {
  // 503 so clients retry rather than treating an infrastructure blip as bad input.
  return httpError(message, 503, { detail: redact(detail), conflict, storage: true, cause });
}

const isConfigured = () => Boolean(config.owner && config.repo && config.token);

function describeMissing() {
  const missing = [];
  if (!config.owner) missing.push("DATA_REPO_OWNER");
  if (!config.repo) missing.push("DATA_REPO_NAME");
  if (!config.token) missing.push("DATA_REPO_TOKEN");
  return `missing: ${missing.join(", ")}`;
}

/* --------------------------------------------------------------- the store */

const emptyStore = () => ({ version: STORE_VERSION, users: [], trips: [] });

export function normalizeStore(store) {
  const next = store && typeof store === "object" ? store : {};
  next.version = STORE_VERSION;
  next.users ||= [];
  next.trips ||= [];
  for (const trip of next.trips) {
    trip.members ||= [];
    trip.expenses ||= [];
    trip.settlements ||= [];
    // Pre-V9 shared-secret fields: dead code paths, and secret material we do
    // not want carried forward into the data repo's history.
    delete trip.ownerSecretHash;
    delete trip.memberSecrets;
  }
  return next;
}

const serialize = store => `${JSON.stringify(store, null, 2)}\n`;
const clone = value => structuredClone(value);

/* ------------------------------------------------------ read cache (ETag) */

const cache = { etag: null, sha: null, store: null };

export function invalidateCache() {
  cache.etag = null;
  cache.sha = null;
  cache.store = null;
}

/**
 * Read the store. Uses a conditional GET: when GitHub answers 304 the cached
 * copy is reused, which keeps the app well inside the API rate limit while
 * still being correct — any write, from anywhere, changes the ETag.
 * Always returns a deep clone so callers can mutate freely.
 */
export async function readStore({ force = false } = {}) {
  const url = `${contentsUrl()}?ref=${encodeURIComponent(config.branch)}`;
  const etag = force ? null : cache.etag;
  const { status, etag: nextEtag, body } = await githubRequest("GET", url, { etag, allow: [404] });

  if (status === 304 && cache.store) return { store: clone(cache.store), sha: cache.sha, cached: true };

  if (status === 404) {
    invalidateCache();
    return { store: emptyStore(), sha: null, cached: false };
  }

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(body.content).replace(/\s/g, ""), "base64").toString("utf8"));
  } catch (cause) {
    throw storageError("Data repository contains an unreadable store file", {
      detail: `path=${config.filePath}: ${cause?.message}`,
      cause
    });
  }

  const store = normalizeStore(parsed);
  cache.etag = nextEtag;
  cache.sha = body.sha;
  cache.store = clone(store);
  return { store, sha: body.sha, cached: false };
}

async function putStore(store, sha, message) {
  const { body } = await githubRequest("PUT", contentsUrl(), {
    body: {
      message: message.slice(0, 200),
      branch: config.branch,
      content: Buffer.from(serialize(store), "utf8").toString("base64"),
      committer: { name: config.committerName, email: config.committerEmail },
      ...(sha ? { sha } : {})
    }
  });
  // We know exactly what is on the branch now; keep it warm, drop the stale ETag.
  cache.etag = null;
  cache.sha = body?.content?.sha ?? null;
  cache.store = clone(store);
  return cache.sha;
}

/* ------------------------------------------------------------- write lock */

// One in-process queue for every mutation. Two requests arriving together now
// wait for each other instead of racing on the same blob sha and burning retries.
let writeQueue = Promise.resolve();

function withWriteLock(task) {
  const result = writeQueue.then(task, task);
  writeQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * Read → apply `change(store)` → commit, serialized and retried on conflict.
 * Errors thrown by `change` are the caller's own (validation, 404, 409) and are
 * never retried or swallowed.
 */
export async function mutateStore(change, message) {
  return withWriteLock(async () => {
    let lastError;
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
      const { store, sha } = await readStore({ force: attempt > 1 });
      const result = change(store); // caller errors escape here by design
      try {
        await putStore(store, sha, message);
        return result;
      } catch (error) {
        if (!error.conflict || attempt === MAX_WRITE_ATTEMPTS) throw error;
        lastError = error;
        invalidateCache();
        const backoff = attempt * 150 + Math.floor(Math.random() * 120);
        logWarn(`storage: write conflict on attempt ${attempt}, retrying in ${backoff}ms`);
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }
    throw lastError ?? storageError("Data repository write failed");
  });
}

/* ------------------------------------------------- bootstrap & health check */

const status = {
  configured: false,
  ready: false,
  private: null,
  bootstrapped: false,
  checkedAt: null,
  error: null
};

/** Safe for a public /health endpoint: no owner, repo, path or token echoed. */
export const storageStatus = () => ({ ...status });

/**
 * Called once at boot. Verifies the token can see the repo, warns loudly if the
 * data repo is public, and creates the store file if it is not there yet.
 * Resolves to the status object; it does not throw, so the process stays up and
 * /health can report the failure (which fails the Render deploy instead of
 * silently serving a broken build).
 */
export async function initStorage() {
  status.checkedAt = new Date().toISOString();
  status.configured = isConfigured();
  status.ready = false;
  status.error = null;

  if (!status.configured) {
    status.error = `Data repository is not configured (${describeMissing()})`;
    console.error(`storage: ${status.error}`);
    return storageStatus();
  }

  try {
    const { body: repo } = await githubRequest("GET", repoUrl());
    status.private = repo?.private === true;

    if (!status.private) {
      const warning =
        "storage: the configured data repository is PUBLIC. Emails and password hashes would be world-readable.";
      if (config.allowPublicDataRepo) {
        logWarn(`${warning} Continuing because ALLOW_PUBLIC_DATA_REPO=true.`);
      } else {
        status.error = PRIVACY_ERROR;
        console.error(`${warning} Refusing to serve; make it private or set ALLOW_PUBLIC_DATA_REPO=true.`);
        return storageStatus();
      }
    }

    if (repo?.permissions && repo.permissions.push !== true) {
      logWarn("storage: token has read-only access to the data repository; writes will fail.");
    }

    const probe = await githubRequest(
      "GET",
      `${contentsUrl()}?ref=${encodeURIComponent(config.branch)}`,
      { allow: [404] }
    );

    if (probe.status === 404) {
      await putStore(emptyStore(), null, "chore: bootstrap TripSynch store");
      status.bootstrapped = true;
      logInfo(`storage: created ${config.filePath} on ${config.branch}`);
    }

    status.ready = true;
    logInfo(
      `storage: ready (repo=${config.owner}/${config.repo} private=${status.private} branch=${config.branch} path=${config.filePath})`
    );
  } catch (error) {
    status.error = error.message;
    console.error(`storage: initialization failed: ${redact(error.message)} ${redact(error.detail || "")}`);
  }

  return storageStatus();
}

/**
 * True when the data repo was confirmed public at boot. The process keeps
 * running (so /health can explain itself) but must not write user data there.
 */
export const isPrivacyViolation = () => status.configured && !status.ready && status.error === PRIVACY_ERROR;

let refreshing = null;
const REFRESH_AFTER_MS = 15_000;

/**
 * Re-runs the startup check when storage is not ready, at most once every 15s.
 * Render polls /health, so a transient GitHub outage at boot heals itself
 * instead of needing a manual redeploy. A public data repo is not retried.
 */
export async function refreshStorageStatus() {
  if (status.ready || isPrivacyViolation()) return storageStatus();
  if (refreshing) return refreshing;
  const age = status.checkedAt ? Date.now() - Date.parse(status.checkedAt) : Infinity;
  if (age < REFRESH_AFTER_MS) return storageStatus();
  refreshing = initStorage().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/* --------------------------------------------------------------- utilities */

export const makeId = (bytes = 12) => crypto.randomBytes(bytes).toString("base64url");
