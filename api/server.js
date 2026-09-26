import express from "express";
import QRCode from "qrcode";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { httpError } from "./http-error.js";
import {
  initStorage,
  isPrivacyViolation,
  makeId,
  mutateStore,
  readStore,
  redact,
  refreshStorageStatus,
  storageStatus
} from "./storage.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "500kb" }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(__dirname, "../frontend");
const {
  PUBLIC_APP_URL = "https://tripsynch.onrender.com",
  APP_SECRET,
  PORT = 10000
} = process.env;

if (!APP_SECRET) console.warn("APP_SECRET is missing. Configure it in Render before production use.");

const clean = (value, max = 120) => String(value ?? "").trim().slice(0, max);
const normalizeEmail = value => clean(value, 180).toLowerCase();
const toCents = value => Math.round(Number(value || 0) * 100);

function createPasswordHash(password, salt = crypto.randomBytes(16).toString("hex")) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

function verifyPassword(password, storedHash) {
  try {
    const [salt, expectedHex] = storedHash.split(":");
    const actual = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(expectedHex, "hex");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function signToken(userId) {
  const secret = APP_SECRET || "development-only-change-me";
  const payload = Buffer.from(JSON.stringify({ userId, exp: Date.now() + 30 * 86400000 })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function parseToken(token) {
  try {
    const secret = APP_SECRET || "development-only-change-me";
    const [payload, signature] = String(token || "").split(".");
    const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email };
}

function publicTrip(trip) {
  return {
    id: trip.id,
    code: trip.code,
    name: trip.name,
    currency: trip.currency,
    ownerUserId: trip.ownerUserId,
    ownerId: trip.ownerId,
    createdAt: trip.createdAt,
    members: trip.members || [],
    expenses: trip.expenses || [],
    settlements: trip.settlements || []
  };
}

function activeMemberFor(trip, userId) {
  return trip.members.find(member => member.userId === userId && member.active !== false);
}

function authorizeTrip(trip, userId, ownerOnly = false) {
  const member = activeMemberFor(trip, userId);
  if (!member) throw httpError("You are not an active member of this trip", 403);
  if (ownerOnly && trip.ownerUserId !== userId) throw httpError("Owner authorization required", 403);
  return member;
}

function calculateBalances(trip) {
  const balances = Object.fromEntries((trip.members || []).map(member => [member.id, 0]));
  for (const expense of trip.expenses || []) {
    if (!(expense.paidBy in balances) || !expense.splitAmong?.length) continue;
    const total = toCents(expense.amount);
    const base = Math.floor(total / expense.splitAmong.length);
    let remainder = total - base * expense.splitAmong.length;
    balances[expense.paidBy] += total;
    for (const memberId of expense.splitAmong) {
      if (!(memberId in balances)) continue;
      const extra = remainder > 0 ? 1 : 0;
      remainder -= extra;
      balances[memberId] -= base + extra;
    }
  }
  for (const settlement of trip.settlements || []) {
    if (settlement.status !== "settled") continue;
    const amount = toCents(settlement.amount);
    if (settlement.from in balances) balances[settlement.from] += amount;
    if (settlement.to in balances) balances[settlement.to] -= amount;
  }
  return balances;
}

async function requireUser(req, res, next) {
  try {
    const token = parseToken((req.get("authorization") || "").replace(/^Bearer\s+/i, ""));
    if (!token) throw httpError("Login required", 401);
    const { store } = await readStore();
    const user = store.users.find(item => item.id === token.userId && item.disabled !== true);
    if (!user) throw httpError("Account is not available", 401);
    req.user = publicUser(user);
    return next();
  } catch (error) {
    return next(error);
  }
}

// Hard stop: if the configured data repository turned out to be public, the app
// must not write emails or password hashes into it. /health explains why.
app.use("/api", (req, res, next) => {
  if (!isPrivacyViolation()) return next();
  return res.status(503).json({ error: "Trip data storage is misconfigured. Please contact the administrator." });
});

app.get("/health", async (req, res) => {
  const storage = await refreshStorageStatus();
  const ok = storage.ready === true;
  return res.status(ok ? 200 : 503).json({
    ok,
    service: "TripSynch API v10",
    frontend: true,
    publicAppUrl: PUBLIC_APP_URL,
    // Deliberately name no owner, repo, path or token here: /health is public.
    storage: {
      kind: "github-private-repo",
      configured: storage.configured,
      ready: storage.ready,
      private: storage.private,
      bootstrapped: storage.bootstrapped,
      checkedAt: storage.checkedAt,
      ...(storage.error ? { error: storage.error } : {})
    }
  });
});

app.post("/api/auth/signup", async (req, res, next) => {
  try {
    const name = clean(req.body.name, 60);
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");
    if (!name || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8) {
      return res.status(400).json({ error: "Name, valid email, and password of at least 8 characters are required" });
    }
    let user;
    await mutateStore(store => {
      if (store.users.some(item => item.email === email)) throw httpError("Email is already registered", 409);
      user = { id: makeId(), name, email, passwordHash: createPasswordHash(password), createdAt: new Date().toISOString(), disabled: false };
      store.users.push(user);
    }, `data: signup ${email}`);
    return res.status(201).json({ token: signToken(user.id), user: publicUser(user) });
  } catch (error) { return next(error); }
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");
    const { store } = await readStore();
    const user = store.users.find(item => item.email === email && item.disabled !== true);
    if (!user || !verifyPassword(password, user.passwordHash)) throw httpError("Invalid email or password", 401);
    return res.json({ token: signToken(user.id), user: publicUser(user) });
  } catch (error) { return next(error); }
});

app.get("/api/auth/me", requireUser, (req, res) => res.json({ user: req.user }));

app.get("/api/trips", requireUser, async (req, res, next) => {
  try {
    const { store } = await readStore();
    const trips = store.trips.filter(trip => activeMemberFor(trip, req.user.id)).map(publicTrip);
    return res.json({ trips });
  } catch (error) { return next(error); }
});

app.post("/api/trips", requireUser, async (req, res, next) => {
  try {
    const name = clean(req.body.name, 80);
    const currency = clean(req.body.currency || "INR", 3).toUpperCase();
    if (!name || !["INR", "USD", "EUR", "GBP", "SGD", "AED"].includes(currency)) throw httpError("Valid trip name and currency are required");
    const ownerMemberId = makeId();
    const trip = {
      id: makeId(), code: crypto.randomBytes(4).toString("hex").toUpperCase(), name, currency,
      ownerUserId: req.user.id, ownerId: ownerMemberId, createdAt: new Date().toISOString(),
      members: [{ id: ownerMemberId, userId: req.user.id, name: req.user.name, email: req.user.email, role: "owner", active: true, joinedAt: new Date().toISOString() }],
      expenses: [], settlements: []
    };
    await mutateStore(store => store.trips.push(trip), `data: create trip ${trip.id}`);
    return res.status(201).json({ trip: publicTrip(trip) });
  } catch (error) { return next(error); }
});

app.post("/api/trips/join", requireUser, async (req, res, next) => {
  try {
    const code = clean(req.body.code, 8).toUpperCase();
    if (!code) throw httpError("Invite code is required");
    let trip;
    await mutateStore(store => {
      trip = store.trips.find(item => item.code === code);
      if (!trip) throw httpError("Trip not found", 404);
      const previous = trip.members.find(member => member.userId === req.user.id);
      if (previous) {
        if (previous.active === false) throw httpError("This account was removed from the trip", 403);
        return;
      }
      trip.members.push({ id: makeId(), userId: req.user.id, name: req.user.name, email: req.user.email, role: "member", active: true, joinedAt: new Date().toISOString() });
    }, `data: join ${code}`);
    return res.json({ trip: publicTrip(trip) });
  } catch (error) { return next(error); }
});

app.get("/api/trips/:id", requireUser, async (req, res, next) => {
  try {
    const { store } = await readStore();
    const trip = store.trips.find(item => item.id === req.params.id);
    if (!trip) throw httpError("Trip not found", 404);
    const member = authorizeTrip(trip, req.user.id);
    res.set("Cache-Control", "no-store");
    return res.json({ trip: publicTrip(trip), memberId: member.id, user: req.user });
  } catch (error) { return next(error); }
});

app.post("/api/trips/:id/expenses", requireUser, async (req, res, next) => {
  try {
    let trip;
    await mutateStore(store => {
      trip = store.trips.find(item => item.id === req.params.id);
      if (!trip) throw httpError("Trip not found", 404);
      const actor = authorizeTrip(trip, req.user.id);
      const description = clean(req.body.description, 100);
      const amount = Number(req.body.amount);
      const paidBy = clean(req.body.paidBy, 100);
      const splitAmong = Array.isArray(req.body.splitAmong) ? [...new Set(req.body.splitAmong.map(item => clean(item, 100)).filter(Boolean))] : [];
      const activeIds = new Set(trip.members.filter(member => member.active !== false).map(member => member.id));
      if (!description || !Number.isFinite(amount) || amount <= 0 || !activeIds.has(paidBy) || !splitAmong.length || splitAmong.some(id => !activeIds.has(id))) throw httpError("Invalid expense details");
      trip.expenses.push({ id: makeId(), description, amount: Number(amount.toFixed(2)), paidBy, splitAmong, createdBy: actor.id, createdAt: new Date().toISOString() });
    }, `data: expense ${req.params.id}`);
    return res.status(201).json({ trip: publicTrip(trip) });
  } catch (error) { return next(error); }
});

app.post("/api/trips/:id/settlements", requireUser, async (req, res, next) => {
  try {
    let trip, record;
    await mutateStore(store => {
      trip = store.trips.find(item => item.id === req.params.id);
      if (!trip) throw httpError("Trip not found", 404);
      authorizeTrip(trip, req.user.id);
      const from = clean(req.body.from, 100), to = clean(req.body.to, 100), amount = Number(req.body.amount);
      const ids = new Set(trip.members.map(member => member.id));
      if (!ids.has(from) || !ids.has(to) || from === to || !Number.isFinite(amount) || amount <= 0) throw httpError("Invalid settlement");
      record = { id: makeId(), from, to, amount: Number(amount.toFixed(2)), status: "settled", settledByUserId: req.user.id, settledAt: new Date().toISOString() };
      trip.settlements.push(record);
    }, `data: settlement ${req.params.id}`);
    return res.status(201).json({ trip: publicTrip(trip), settlement: record });
  } catch (error) { return next(error); }
});

app.delete("/api/trips/:id/settlements/:settlementId", requireUser, async (req, res, next) => {
  try {
    let trip;
    await mutateStore(store => {
      trip = store.trips.find(item => item.id === req.params.id);
      if (!trip) throw httpError("Trip not found", 404);
      authorizeTrip(trip, req.user.id);
      const before = trip.settlements.length;
      trip.settlements = trip.settlements.filter(item => item.id !== req.params.settlementId);
      if (trip.settlements.length === before) throw httpError("Settlement not found", 404);
    }, `data: undo settlement ${req.params.id}`);
    return res.json({ trip: publicTrip(trip) });
  } catch (error) { return next(error); }
});

app.post("/api/trips/:id/members/:memberId/settle-remove", requireUser, async (req, res, next) => {
  try {
    let trip, settlement = null;
    await mutateStore(store => {
      trip = store.trips.find(item => item.id === req.params.id);
      if (!trip) throw httpError("Trip not found", 404);
      const owner = authorizeTrip(trip, req.user.id, true);
      const target = trip.members.find(member => member.id === req.params.memberId && member.active !== false);
      if (!target) throw httpError("Active member not found", 404);
      if (target.id === owner.id) throw httpError("Owner cannot be removed");
      const balance = calculateBalances(trip)[target.id] || 0;
      if (balance !== 0) {
        settlement = {
          id: makeId(), from: balance < 0 ? target.id : owner.id, to: balance < 0 ? owner.id : target.id,
          amount: Math.abs(balance) / 100, status: "settled", reason: "Settle and remove member",
          settledByUserId: req.user.id, settledAt: new Date().toISOString()
        };
        trip.settlements.push(settlement);
      }
      target.active = false;
      target.removedAt = new Date().toISOString();
      target.removedByUserId = req.user.id;
    }, `data: settle remove ${req.params.memberId}`);
    return res.json({ trip: publicTrip(trip), settlement });
  } catch (error) { return next(error); }
});

app.delete("/api/trips/:id/members/:memberId", requireUser, async (req, res, next) => {
  try {
    let trip;
    await mutateStore(store => {
      trip = store.trips.find(item => item.id === req.params.id);
      if (!trip) throw httpError("Trip not found", 404);
      const owner = authorizeTrip(trip, req.user.id, true);
      const target = trip.members.find(member => member.id === req.params.memberId && member.active !== false);
      if (!target) throw httpError("Active member not found", 404);
      if (target.id === owner.id) throw httpError("Owner cannot be removed");
      if ((calculateBalances(trip)[target.id] || 0) !== 0) throw httpError("Settle the member before removal", 409);
      target.active = false;
      target.removedAt = new Date().toISOString();
      target.removedByUserId = req.user.id;
    }, `data: remove ${req.params.memberId}`);
    return res.json({ trip: publicTrip(trip) });
  } catch (error) { return next(error); }
});

app.post("/api/trips/:id/leave", requireUser, async (req, res, next) => {
  try {
    await mutateStore(store => {
      const trip = store.trips.find(item => item.id === req.params.id);
      if (!trip) throw httpError("Trip not found", 404);
      const member = authorizeTrip(trip, req.user.id);
      if (trip.ownerUserId === req.user.id) throw httpError("The owner cannot leave. Delete the trip instead.");
      if ((calculateBalances(trip)[member.id] || 0) !== 0) throw httpError("Settle your balance before leaving", 409);
      member.active = false;
      member.removedAt = new Date().toISOString();
      member.removedByUserId = req.user.id;
    }, `data: leave trip ${req.params.id}`);
    return res.json({ ok: true });
  } catch (error) { return next(error); }
});

app.delete("/api/trips/:id", requireUser, async (req, res, next) => {
  try {
    await mutateStore(store => {
      const index = store.trips.findIndex(item => item.id === req.params.id);
      if (index < 0) throw httpError("Trip not found", 404);
      authorizeTrip(store.trips[index], req.user.id, true);
      store.trips.splice(index, 1);
    }, `data: delete trip ${req.params.id}`);
    return res.json({ ok: true });
  } catch (error) { return next(error); }
});

app.get("/api/qr", async (req, res, next) => {
  try {
    const text = clean(req.query.text, 1200);
    if (!text) throw httpError("QR text is required");
    return res.type("png").set("Cache-Control", "public,max-age=3600").send(await QRCode.toBuffer(text, { width: 420, margin: 2 }));
  } catch (error) { return next(error); }
});

app.use(express.static(frontendDir, {
  index: "index.html",
  etag: false,
  maxAge: 0,
  setHeaders: response => response.set("Cache-Control", "no-store, no-cache, must-revalidate")
}));
app.get(/^(?!\/api\/).*/, (req, res) => res.set("Cache-Control", "no-store").sendFile(path.join(frontendDir, "index.html")));
app.use((err, req, res, next) => {
  // Log redacted: storage errors carry a `detail` field that can quote GitHub
  // responses, and the PAT must never reach the log stream.
  const where = `${req.method} ${req.originalUrl}`;
  console.error(redact(`${where} -> ${err.status || 500} ${err.message}`));
  if (err.detail) console.error(redact(`  detail: ${err.detail}`));
  if (!err.status) console.error(redact(err.stack || ""));

  if (res.headersSent) return next(err);
  const status = err.status || 500;
  // Storage failures are infrastructure, not user input: never echo their detail.
  if (err.storage) return res.status(status).json({ error: "Trip data is temporarily unavailable. Please retry." });
  return res.status(status).json({ error: err.status ? err.message : "Internal server error" });
});

app.listen(Number(PORT), "0.0.0.0", async () => {
  console.log(`TripSynch V10 listening on ${PORT}`);
  const storage = await initStorage();
  if (!storage.ready) {
    console.error("TripSynch started WITHOUT working data storage. /health will report 503 until this is fixed.");
  }
});
