import express from "express";
import QRCode from "qrcode";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
app.use(express.json({ limit: "500kb" }));
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(__dirname, "../frontend");

const {
  GITHUB_OWNER,
  GITHUB_REPO,
  GITHUB_TOKEN,
  GITHUB_BRANCH = "main",
  DATA_PATH = "data/store.json",
  PUBLIC_APP_URL = "https://tripsynch.onrender.com",
  PORT = 10000
} = process.env;

for (const key of ["GITHUB_OWNER", "GITHUB_REPO", "GITHUB_TOKEN"]) {
  if (!process.env[key]) console.warn(`Missing environment variable: ${key}`);
}

const contentsUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${DATA_PATH}`;
const githubHeaders = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "TripSynch-V6"
};

const makeId = (bytes = 12) => crypto.randomBytes(bytes).toString("base64url");
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const clean = (value, length = 100) => String(value ?? "").trim().slice(0, length);
const httpError = (message, status = 400) => Object.assign(new Error(message), { status });

async function githubRequest(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: { ...githubHeaders, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) {
    const detail = await response.text();
    throw Object.assign(new Error(`GitHub ${method} failed: ${response.status} ${detail}`), { status: response.status });
  }
  return response.status === 204 ? null : response.json();
}

async function readStore() {
  try {
    const result = await githubRequest("GET", `${contentsUrl}?ref=${encodeURIComponent(GITHUB_BRANCH)}&t=${Date.now()}`);
    const content = Buffer.from(result.content.replace(/\n/g, ""), "base64").toString("utf8");
    const store = JSON.parse(content);
    store.version = 6;
    store.trips ||= [];
    return { store, sha: result.sha };
  } catch (error) {
    if (error.status === 404) return { store: { version: 6, trips: [] }, sha: null };
    throw error;
  }
}

async function writeStore(store, sha, message) {
  await githubRequest("PUT", contentsUrl, {
    message,
    branch: GITHUB_BRANCH,
    content: Buffer.from(`${JSON.stringify(store, null, 2)}\n`).toString("base64"),
    ...(sha ? { sha } : {})
  });
}

async function mutateStore(change, message) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const { store, sha } = await readStore();
    const output = change(store);
    try {
      await writeStore(store, sha, message);
      return output;
    } catch (error) {
      if (![409, 422].includes(error.status) || attempt === 5) throw error;
      await new Promise(resolve => setTimeout(resolve, 200 * attempt));
    }
  }
}

function publicTrip(trip) {
  return {
    id: trip.id, code: trip.code, name: trip.name, currency: trip.currency,
    ownerId: trip.ownerId, createdAt: trip.createdAt,
    members: trip.members || [], expenses: trip.expenses || [], settlements: trip.settlements || []
  };
}

function authorize(req, trip, ownerOnly = false) {
  const tokenHash = hash(req.get("x-trip-secret") || "");
  const isOwner = tokenHash === trip.ownerTokenHash;
  const isMember = Object.values(trip.memberTokenHashes || {}).includes(tokenHash);
  if ((!isOwner && !isMember) || (ownerOnly && !isOwner)) throw httpError(ownerOnly ? "Owner authorization required" : "Invalid trip authorization", 403);
}

app.get("/health", (req, res) => res.json({ ok: true, service: "TripSynch API v6", frontend: true, publicAppUrl: PUBLIC_APP_URL }));
app.get("/api/config", (req, res) => res.json({ apiBase: PUBLIC_APP_URL.replace(/\/$/, ""), appUrl: PUBLIC_APP_URL.replace(/\/$/, "") }));

app.post("/api/trips", async (req, res, next) => {
  try {
    const name = clean(req.body.name, 80), ownerName = clean(req.body.ownerName, 60), currency = clean(req.body.currency || "INR", 3).toUpperCase();
    if (!name || !ownerName || !["INR","USD","EUR","GBP","SGD","AED"].includes(currency)) return res.status(400).json({ error: "Valid trip name, owner name, and currency are required" });
    const token = makeId(24), memberId = makeId();
    const trip = { id: makeId(), code: crypto.randomBytes(4).toString("hex").toUpperCase(), name, currency, ownerId: memberId, ownerTokenHash: hash(token), memberTokenHashes: {}, createdAt: new Date().toISOString(), members: [{ id: memberId, name: ownerName, joinedAt: new Date().toISOString() }], expenses: [], settlements: [] };
    await mutateStore(store => store.trips.push(trip), `TripSynch V6: create ${trip.id}`);
    return res.status(201).json({ trip: publicTrip(trip), memberId, token });
  } catch (error) { return next(error); }
});

app.post("/api/join", async (req, res, next) => {
  try {
    const code = clean(req.body.code, 8).toUpperCase(), name = clean(req.body.name, 60);
    if (!code || !name) return res.status(400).json({ error: "Invite code and name are required" });
    const memberId = makeId(), token = makeId(24); let trip;
    await mutateStore(store => {
      trip = store.trips.find(item => item.code === code);
      if (!trip) throw httpError("Trip not found", 404);
      trip.memberTokenHashes ||= {}; trip.members ||= [];
      trip.memberTokenHashes[memberId] = hash(token);
      trip.members.push({ id: memberId, name, joinedAt: new Date().toISOString() });
    }, `TripSynch V6: join ${code}`);
    return res.json({ trip: publicTrip(trip), memberId, token });
  } catch (error) { return next(error); }
});

app.get("/api/trips/:id", async (req, res, next) => {
  try {
    const { store } = await readStore(); const trip = store.trips.find(item => item.id === req.params.id);
    if (!trip) return res.status(404).json({ error: "Trip not found" });
    authorize(req, trip); res.set("Cache-Control", "no-store"); return res.json(publicTrip(trip));
  } catch (error) { return next(error); }
});

app.post("/api/trips/:id/expenses", async (req, res, next) => {
  try {
    let trip;
    await mutateStore(store => {
      trip = store.trips.find(item => item.id === req.params.id); if (!trip) throw httpError("Trip not found", 404); authorize(req, trip);
      const description = clean(req.body.description, 100), amount = Number(req.body.amount), paidBy = clean(req.body.paidBy, 100);
      const splitAmong = Array.isArray(req.body.splitAmong) ? [...new Set(req.body.splitAmong.map(value => clean(value, 100)).filter(Boolean))] : [];
      const memberIds = new Set(trip.members.map(member => member.id));
      if (!description || !Number.isFinite(amount) || amount <= 0 || !memberIds.has(paidBy) || !splitAmong.length || splitAmong.some(id => !memberIds.has(id))) throw httpError("Invalid expense details");
      trip.expenses ||= [];
      trip.expenses.push({ id: makeId(), description, amount: Number(amount.toFixed(2)), paidBy, splitAmong, createdBy: clean(req.body.actorId, 100), createdAt: new Date().toISOString() });
    }, `TripSynch V6: expense ${req.params.id}`);
    return res.status(201).json(publicTrip(trip));
  } catch (error) { return next(error); }
});

app.post("/api/trips/:id/settlements", async (req, res, next) => {
  try {
    let trip, record;
    await mutateStore(store => {
      trip = store.trips.find(item => item.id === req.params.id); if (!trip) throw httpError("Trip not found", 404); authorize(req, trip);
      const from = clean(req.body.from, 100), to = clean(req.body.to, 100), amount = Number(req.body.amount), ids = new Set(trip.members.map(member => member.id));
      if (!ids.has(from) || !ids.has(to) || from === to || !Number.isFinite(amount) || amount <= 0) throw httpError("Invalid settlement");
      trip.settlements ||= []; record = { id: makeId(), from, to, amount: Number(amount.toFixed(2)), status: "settled", settledBy: clean(req.body.actorId, 100), settledAt: new Date().toISOString() }; trip.settlements.push(record);
    }, `TripSynch V6: settle ${req.params.id}`);
    return res.status(201).json({ trip: publicTrip(trip), settlement: record });
  } catch (error) { return next(error); }
});

app.delete("/api/trips/:id/settlements/:settlementId", async (req, res, next) => {
  try {
    let trip;
    await mutateStore(store => { trip = store.trips.find(item => item.id === req.params.id); if (!trip) throw httpError("Trip not found", 404); authorize(req, trip); const before = (trip.settlements || []).length; trip.settlements = (trip.settlements || []).filter(item => item.id !== req.params.settlementId); if (trip.settlements.length === before) throw httpError("Settlement not found", 404); }, `TripSynch V6: undo settlement ${req.params.id}`);
    return res.json(publicTrip(trip));
  } catch (error) { return next(error); }
});

app.delete("/api/trips/:id", async (req, res, next) => {
  try {
    await mutateStore(store => { const index = store.trips.findIndex(item => item.id === req.params.id); if (index < 0) throw httpError("Trip not found", 404); const trip = store.trips[index]; authorize(req, trip, true); if (clean(req.body.actorId, 100) !== trip.ownerId) throw httpError("Only the trip creator can delete this trip", 403); store.trips.splice(index, 1); }, `TripSynch V6: delete ${req.params.id}`);
    return res.json({ ok: true });
  } catch (error) { return next(error); }
});

app.get("/api/qr", async (req, res, next) => { try { const value = clean(req.query.text, 1200); if (!value) return res.status(400).json({ error: "QR text is required" }); return res.type("png").set("Cache-Control", "public,max-age=3600").send(await QRCode.toBuffer(value, { width: 420, margin: 2 })); } catch (error) { return next(error); } });

app.use(express.static(frontendDir, { index: "index.html", maxAge: "1h" }));
app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(frontendDir, "index.html")));
app.use((error, req, res, next) => { console.error(error); if (res.headersSent) return next(error); return res.status(error.status || 500).json({ error: error.status ? error.message : "Internal server error" }); });
app.listen(Number(PORT), "0.0.0.0", () => console.log(`TripSynch V6 listening on ${PORT}`));
