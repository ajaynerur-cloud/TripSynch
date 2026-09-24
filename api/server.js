import express from "express";
import QRCode from "qrcode";
import crypto from "node:crypto";

const app = express();
app.use(express.json({ limit: "300kb" }));

const {
  GITHUB_OWNER,
  GITHUB_REPO,
  GITHUB_TOKEN,
  GITHUB_BRANCH = "main",
  DATA_PATH = "data/store.json",
  ALLOWED_ORIGIN = "*",
  PORT = 3000
} = process.env;

const contentsUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${DATA_PATH}`;
const githubHeaders = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "TripSynch"
};

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-trip-secret");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const makeId = (bytes = 12) => crypto.randomBytes(bytes).toString("base64url");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const clean = (value, length = 100) => String(value ?? "").trim().slice(0, length);

async function readStore() {
  const response = await fetch(`${contentsUrl}?ref=${encodeURIComponent(GITHUB_BRANCH)}&t=${Date.now()}`, { headers: githubHeaders });
  if (response.status === 404) return { data: { version: 1, trips: [] }, sha: null };
  if (!response.ok) throw new Error(`GitHub read failed: ${response.status}`);
  const result = await response.json();
  const text = Buffer.from(result.content.replace(/\n/g, ""), "base64").toString("utf8");
  return { data: JSON.parse(text), sha: result.sha };
}

async function writeStore(data, sha, message) {
  const body = {
    message,
    content: Buffer.from(`${JSON.stringify(data, null, 2)}\n`).toString("base64"),
    branch: GITHUB_BRANCH,
    ...(sha ? { sha } : {})
  };
  const response = await fetch(contentsUrl, {
    method: "PUT",
    headers: { ...githubHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const error = new Error(`GitHub write failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
}

async function mutateStore(change, message) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { data, sha } = await readStore();
    const output = change(data);
    try {
      await writeStore(data, sha, message);
      return output;
    } catch (error) {
      if (error.status !== 409 || attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
}

function publicTrip(trip) {
  return {
    id: trip.id,
    code: trip.code,
    name: trip.name,
    currency: trip.currency,
    ownerId: trip.ownerId,
    createdAt: trip.createdAt,
    members: trip.members,
    expenses: trip.expenses
  };
}

function authorize(req, trip, ownerOnly = false) {
  const secretHash = hash(req.get("x-trip-secret") || "");
  const isOwner = secretHash === trip.ownerSecretHash;
  const isMember = Object.values(trip.memberSecrets || {}).includes(secretHash);
  if ((!isOwner && !isMember) || (ownerOnly && !isOwner)) {
    const error = new Error(ownerOnly ? "Owner authorization required" : "Invalid trip authorization");
    error.status = 403;
    throw error;
  }
}

app.get("/health", (req, res) => res.json({ ok: true, service: "TripSynch API" }));

app.post("/api/trips", async (req, res, next) => {
  try {
    const name = clean(req.body.name, 80);
    const ownerName = clean(req.body.ownerName, 60);
    const currency = clean(req.body.currency, 3).toUpperCase();
    if (!name || !ownerName || !["INR", "USD", "EUR", "GBP", "SGD", "AED"].includes(currency)) {
      return res.status(400).json({ error: "Valid trip name, owner name, and currency are required" });
    }
    const secret = makeId(24);
    const memberId = makeId();
    const trip = {
      id: makeId(),
      code: crypto.randomBytes(4).toString("hex").toUpperCase(),
      name,
      currency,
      ownerId: memberId,
      ownerSecretHash: hash(secret),
      memberSecrets: {},
      createdAt: new Date().toISOString(),
      members: [{ id: memberId, name: ownerName, joinedAt: new Date().toISOString() }],
      expenses: []
    };
    await mutateStore(store => store.trips.push(trip), `Create TripSynch trip ${trip.id}`);
    res.status(201).json({ trip: publicTrip(trip), memberId, secret });
  } catch (error) { next(error); }
});

app.post("/api/join", async (req, res, next) => {
  try {
    const code = clean(req.body.code, 8).toUpperCase();
    const name = clean(req.body.name, 60);
    if (!code || !name) return res.status(400).json({ error: "Invite code and member name are required" });
    const memberId = makeId();
    const secret = makeId(24);
    let trip;
    await mutateStore(store => {
      trip = store.trips.find(item => item.code === code);
      if (!trip) { const error = new Error("Trip not found"); error.status = 404; throw error; }
      trip.memberSecrets ||= {};
      trip.memberSecrets[memberId] = hash(secret);
      trip.members.push({ id: memberId, name, joinedAt: new Date().toISOString() });
    }, `Join TripSynch trip ${code}`);
    res.json({ trip: publicTrip(trip), memberId, secret });
  } catch (error) { next(error); }
});

app.get("/api/trips/:id", async (req, res, next) => {
  try {
    const { data } = await readStore();
    const trip = data.trips.find(item => item.id === req.params.id);
    if (!trip) return res.status(404).json({ error: "Trip not found" });
    authorize(req, trip);
    res.setHeader("Cache-Control", "no-store");
    res.json(publicTrip(trip));
  } catch (error) { next(error); }
});

app.post("/api/trips/:id/expenses", async (req, res, next) => {
  try {
    let trip;

    await mutateStore(store => {
      trip = store.trips.find(item => item.id === req.params.id);

      if (!trip) {
        const error = new Error("Trip not found");
        error.status = 404;
        throw error;
      }

      authorize(req, trip);

      const description = clean(req.body.description, 100);
      const amount = Number(req.body.amount);
      const paidBy = clean(req.body.paidBy);

      const splitAmong = Array.isArray(req.body.splitAmong)
        ? [...new Set(req.body.splitAmong.map(clean))]
        : [];

      const memberIds = new Set(
        trip.members.map(member => member.id)
      );

      console.log("================================");
      console.log("DESCRIPTION:", description);
      console.log("AMOUNT:", amount);
      console.log("PAIDBY:", paidBy);
      console.log("SPLITAMONG:", splitAmong);
      console.log("MEMBER IDS:", [...memberIds]);

      console.log("CHECK_DESCRIPTION", !!description);
      console.log(
        "CHECK_AMOUNT",
        Number.isFinite(amount) && amount > 0
      );
      console.log(
        "CHECK_PAIDBY",
        memberIds.has(paidBy)
      );
      console.log(
        "CHECK_SPLIT",
        splitAmong.length > 0
      );
      console.log(
        "CHECK_SPLIT_MEMBERS",
        !splitAmong.some(id => !memberIds.has(id))
      );

      if (
        !description ||
        !Number.isFinite(amount) ||
        amount <= 0 ||
        !memberIds.has(paidBy) ||
        !splitAmong.length ||
        splitAmong.some(id => !memberIds.has(id))
      ) {
        return res.status(400).json({
          description,
          amount,
          paidBy,
          splitAmong,
          memberIds: [...memberIds]
        });
      }

      trip.expenses.push({
        id: makeId(),
        description,
        amount: Number(amount.toFixed(2)),
        paidBy,
        splitAmong,
        createdBy: clean(req.body.actorId),
        createdAt: new Date().toISOString()
      });
    }, `Add TripSynch expense ${req.params.id}`);

    res.status(201).json(publicTrip(trip));

  } catch (error) {
    next(error);
  }
});

app.delete("/api/trips/:id", async (req, res, next) => {
  try {
    await mutateStore(store => {
      const index = store.trips.findIndex(item => item.id === req.params.id);
      if (index < 0) { const error = new Error("Trip not found"); error.status = 404; throw error; }
      const trip = store.trips[index];
      authorize(req, trip, true);
      if (clean(req.body.actorId) !== trip.ownerId) { const error = new Error("Only the trip creator can end this trip"); error.status = 403; throw error; }
      store.trips.splice(index, 1);
    }, `Delete TripSynch trip ${req.params.id}`);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.get("/api/qr", async (req, res, next) => {
  try {
    const text = clean(req.query.text, 1000);
    if (!text) return res.status(400).json({ error: "QR text is required" });
    const image = await QRCode.toBuffer(text, { width: 420, margin: 2, color: { dark: "#102a2a", light: "#ffffff" } });
    res.type("png").setHeader("Cache-Control", "public,max-age=3600").send(image);
  } catch (error) { next(error); }
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.status ? error.message : "Server error" });
});
app.listen(PORT, () => console.log(`TripSynch API listening on ${PORT}`));
