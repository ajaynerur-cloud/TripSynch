#!/usr/bin/env node
/**
 * One-off migration: copy the TripSynch store into the PRIVATE data repository.
 *
 *   # from the local working copy (default source: data/store.json)
 *   DATA_REPO_OWNER=ajaynerur-cloud \
 *   DATA_REPO_NAME=TripSynch-Data \
 *   DATA_REPO_TOKEN=github_pat_xxx \
 *   node scripts/migrate-store-to-private-repo.mjs
 *
 *   # from the old public repo, over the API
 *   node scripts/migrate-store-to-private-repo.mjs --from-repo ajaynerur-cloud/TripSynch:data/store.json@main
 *
 * Flags: --from <path>  --from-repo owner/repo:path@branch  --dry-run  --force
 *
 * Safety: refuses to overwrite a target that already holds users or trips
 * unless --force is passed. Prints a redacted summary only.
 */

import fs from "node:fs/promises";
import process from "node:process";

const API = "https://api.github.com";
const STORE_VERSION = 9;

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const value = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const cfg = {
  owner: process.env.DATA_REPO_OWNER || process.env.GITHUB_OWNER || "",
  repo: process.env.DATA_REPO_NAME || process.env.GITHUB_REPO || "",
  branch: process.env.DATA_REPO_BRANCH || process.env.GITHUB_BRANCH || "main",
  path: (process.env.DATA_FILE_PATH || process.env.DATA_PATH || "store.json").replace(/^\/+/, ""),
  token: process.env.DATA_REPO_TOKEN || process.env.GITHUB_TOKEN || ""
};

const dryRun = flag("--dry-run");
const force = flag("--force");
const localSource = value("--from") || (value("--from-repo") ? null : "data/store.json");
const remoteSource = value("--from-repo");

const die = message => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const redact = text =>
  String(text ?? "")
    .split(cfg.token || "\u0000")
    .join("***")
    .replace(/gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}/g, "***");

if (!cfg.owner || !cfg.repo || !cfg.token) {
  die("Set DATA_REPO_OWNER, DATA_REPO_NAME and DATA_REPO_TOKEN before running.");
}

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${cfg.token}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "TripSynch-Migrate",
  "Cache-Control": "no-cache"
};

async function gh(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  if (!response.ok && response.status !== 404) die(`GitHub ${method} ${response.status}: ${redact(text)}`);
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const contentsUrl = (owner, repo, path) =>
  `${API}/repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;

function normalize(store) {
  const next = store && typeof store === "object" ? store : {};
  next.version = STORE_VERSION;
  next.users ||= [];
  next.trips ||= [];
  for (const trip of next.trips) {
    trip.members ||= [];
    trip.expenses ||= [];
    trip.settlements ||= [];
    delete trip.ownerSecretHash; // pre-V9 secret material, not carried over
    delete trip.memberSecrets;
  }
  return next;
}

/* ------------------------------------------------------------------ source */

let sourceStore;
let sourceLabel;

if (remoteSource) {
  const match = /^([^/]+)\/([^:]+):([^@]+)(?:@(.+))?$/.exec(remoteSource);
  if (!match) die("--from-repo must look like owner/repo:path/to/store.json@branch");
  const [, owner, repo, path, branch = "main"] = match;
  sourceLabel = `${owner}/${repo}:${path}@${branch}`;
  const { status, body } = await gh("GET", `${contentsUrl(owner, repo, path)}?ref=${encodeURIComponent(branch)}`);
  if (status === 404) die(`Source not found: ${sourceLabel}`);
  sourceStore = JSON.parse(Buffer.from(String(body.content).replace(/\s/g, ""), "base64").toString("utf8"));
} else {
  sourceLabel = localSource;
  const raw = await fs.readFile(localSource, "utf8").catch(() => die(`Cannot read ${localSource}`));
  sourceStore = JSON.parse(raw);
}

const store = normalize(sourceStore);
const orphanTrips = store.trips.filter(trip => !trip.ownerUserId).map(trip => trip.code || trip.id);

/* ------------------------------------------------------------------ target */

const repoInfo = await gh("GET", `${API}/repos/${cfg.owner}/${cfg.repo}`);
if (repoInfo.status === 404) die(`Data repository ${cfg.owner}/${cfg.repo} not found, or the token cannot see it.`);
if (repoInfo.body.private !== true) die(`${cfg.owner}/${cfg.repo} is PUBLIC. Make it private before migrating data into it.`);

const target = await gh("GET", `${contentsUrl(cfg.owner, cfg.repo, cfg.path)}?ref=${encodeURIComponent(cfg.branch)}`);
let sha = null;
if (target.status !== 404) {
  sha = target.body.sha;
  const existing = JSON.parse(Buffer.from(String(target.body.content).replace(/\s/g, ""), "base64").toString("utf8"));
  const populated = (existing.users?.length || 0) + (existing.trips?.length || 0);
  if (populated > 0 && !force) {
    die(
      `Target ${cfg.path} already holds ${existing.users?.length || 0} user(s) and ` +
        `${existing.trips?.length || 0} trip(s). Re-run with --force to overwrite.`
    );
  }
}

console.log(`source : ${sourceLabel}`);
console.log(`target : ${cfg.owner}/${cfg.repo}:${cfg.path}@${cfg.branch} (private)`);
console.log(`payload: ${store.users.length} user(s), ${store.trips.length} trip(s)`);
if (orphanTrips.length) {
  console.log(
    `note   : ${orphanTrips.length} pre-V9 trip(s) have no ownerUserId and will not appear ` +
      `for any account until re-created: ${orphanTrips.join(", ")}`
  );
}

if (dryRun) {
  console.log("✓ dry run, nothing written");
  process.exit(0);
}

await gh("PUT", contentsUrl(cfg.owner, cfg.repo, cfg.path), {
  message: "chore: migrate TripSynch store into private data repository",
  branch: cfg.branch,
  content: Buffer.from(`${JSON.stringify(store, null, 2)}\n`, "utf8").toString("base64"),
  committer: { name: "TripSynch Bot", email: "tripsynch-bot@users.noreply.github.com" },
  ...(sha ? { sha } : {})
});

console.log("✓ migrated. Next: remove data/store.json from the public repo and rotate the old PAT.");
