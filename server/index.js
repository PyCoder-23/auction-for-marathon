import 'dotenv/config'
import http from "http";
import path from "path";
import fs from "fs";
import express from "express";
import session from "express-session";
import rateLimit from "express-rate-limit";
import bcrypt from "bcrypt";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";

import { openDb, migrate, seedSquads, ensureSeeded } from "./db.js";
import {
  getUserByUsername,
  getUserById,
  createLiveRound,
  recordSkip,
  placeBid,
  finalizeRound,
  getHistoryPage,
  getAuditLogs,
  buildPublicState,
  issueWsToken,
} from "./auction.js";
import { requireAuth, requireAdmin, requireLeader, sessionUserPayload } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const publicDir = path.join(rootDir, "public");
console.log(process.env.ADMIN_USER)
console.log(process.env.ADMIN_PASS)
const db = openDb();
migrate(db);
await ensureSeeded(db);

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "256kb" }));

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret || sessionSecret.length < 16) {
  console.error("SESSION_SECRET must be set and at least 16 characters.");
  process.exit(1);
}

const sessionMiddleware = session({
  name: "marathon.sid",
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
});

app.use(sessionMiddleware);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
});

const wsTokenStore = new Map();
const WS_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function storeWsToken(userId, token) {
  wsTokenStore.set(token, { userId, expires: Date.now() + WS_TOKEN_TTL_MS });
}

function validateWsToken(token) {
  const row = wsTokenStore.get(token);
  if (!row) return null;
  if (Date.now() > row.expires) {
    wsTokenStore.delete(token);
    return null;
  }
  return row.userId;
}

/** @type {Set<import('ws').WebSocket>} */
const sockets = new Set();
/** @type {Map<import('ws').WebSocket, { userId: number, displayName: string }>} */
const socketMeta = new Map();

function serializeEvents(events) {
  return events.map((e) => ({
    id: e.id,
    roundId: e.round_id,
    type: e.event_type,
    squadId: e.squad_id,
    squadName: e.squad_name,
    squadKey: e.squad_key,
    createdAt: e.created_at,
    meta: e.meta_json ? JSON.parse(e.meta_json) : null,
  }));
}

function broadcast() {
  const state = buildPublicState(db);
  state.events = serializeEvents(state.events);
  const presenceMap = new Map();
  for (const meta of socketMeta.values()) {
    presenceMap.set(meta.userId, { id: meta.userId, displayName: meta.displayName });
  }
  const presence = [...presenceMap.values()];
  const payload = JSON.stringify({ type: "state", state, presence });
  for (const ws of sockets) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

app.post("/api/login", loginLimiter, async (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  if (!username || !password) {
    res.status(400).json({ error: "Username and password required." });
    return;
  }
  const user = getUserByUsername(db, username);
  if (!user) {
    res.status(401).json({ error: "Invalid credentials." });
    return;
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    res.status(401).json({ error: "Invalid credentials." });
    return;
  }

  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;
  req.session.displayName = user.display_name;
  req.session.squadId = user.squad_id ?? null;
  req.session.squadKey = user.squad_key ?? null;
  req.session.squadName = user.squad_name ?? null;

  const wsToken = issueWsToken();
  storeWsToken(user.id, wsToken);

  res.json({
    user: sessionUserPayload(req.session),
    wsToken,
  });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("marathon.sid");
    res.json({ ok: true });
  });
});

app.get("/api/me", (req, res) => {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const fresh = getUserById(db, req.session.userId);
  if (!fresh) {
    req.session.destroy(() => {});
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.json({
    user: {
      id: fresh.id,
      username: fresh.username,
      role: fresh.role,
      displayName: fresh.display_name,
      squadId: fresh.squad_id,
      squadKey: fresh.squad_key,
      squadName: fresh.squad_name,
      treasury: fresh.treasury_balance ?? null,
    },
  });
});

app.post("/api/ws-token", requireAuth, (req, res) => {
  const token = issueWsToken();
  storeWsToken(req.session.userId, token);
  res.json({ wsToken: token });
});

app.get("/api/state", requireAuth, (req, res) => {
  const state = buildPublicState(db);
  state.events = serializeEvents(state.events);
  res.json(state);
});

app.post("/api/rounds", requireAuth, requireAdmin, (req, res) => {
  const result = createLiveRound(db, req.session.userId, req.body);
  if (!result.ok) {
    res.status(400).json({ error: result.message, code: result.code });
    return;
  }
  broadcast();
  res.json({ ok: true, roundId: result.roundId });
});

app.post("/api/rounds/:id/finalize", requireAuth, requireAdmin, (req, res) => {
  const roundId = Number(req.params.id);
  if (!Number.isInteger(roundId)) {
    res.status(400).json({ error: "Invalid round id." });
    return;
  }
  const result = finalizeRound(db, roundId, req.session.userId);
  if (!result.ok) {
    res.status(400).json({ error: result.message, code: result.code });
    return;
  }
  broadcast();
  res.json(result);
});

app.post("/api/rounds/:id/bid", requireAuth, requireLeader, (req, res) => {
  const roundId = Number(req.params.id);
  if (!Number.isInteger(roundId)) {
    res.status(400).json({ error: "Invalid round id." });
    return;
  }
  const user = getUserById(db, req.session.userId);
  const result = placeBid(db, roundId, user, req.body?.amount);
  if (!result.ok) {
    res.status(400).json({ error: result.message, code: result.code });
    broadcast();
    return;
  }
  broadcast();
  res.json({ ok: true, amount: result.amount });
});

app.post("/api/rounds/:id/skip", requireAuth, requireLeader, (req, res) => {
  const roundId = Number(req.params.id);
  if (!Number.isInteger(roundId)) {
    res.status(400).json({ error: "Invalid round id." });
    return;
  }
  const user = getUserById(db, req.session.userId);
  const result = recordSkip(db, roundId, user);
  if (!result.ok) {
    res.status(400).json({ error: result.message, code: result.code });
    return;
  }
  broadcast();
  res.json({ ok: true });
});

app.get("/api/history", requireAuth, (req, res) => {
  const sort = String(req.query.sort || "created_at");
  const dir = String(req.query.dir || "desc");
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const page = getHistoryPage(db, { sort, dir, limit, offset });
  res.json(page);
});

app.get("/api/logs", requireAuth, requireAdmin, (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  const rows = getAuditLogs(db, limit);
  res.json({
    rows: rows.map((r) => ({
      id: r.id,
      roundId: r.round_id,
      type: r.event_type,
      createdAt: r.created_at,
      squadName: r.squad_name,
      username: r.username,
      meta: r.meta_json ? JSON.parse(r.meta_json) : null,
    })),
  });
});

if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

app.use((req, res) => {
  if (req.path.startsWith("/api")) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(404).send("Not found");
});

const server = http.createServer(app);

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const host = request.headers.host;
  if (!host) {
    socket.destroy();
    return;
  }
  let url;
  try {
    url = new URL(request.url || "", `http://${host}`);
  } catch {
    socket.destroy();
    return;
  }
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  const token = url.searchParams.get("token");
  const userId = token ? validateWsToken(token) : null;
  if (!userId) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  const user = getUserById(db, userId);
  if (!user) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, user);
  });
});

wss.on("connection", (ws, user) => {
  sockets.add(ws);
  socketMeta.set(ws, { userId: user.id, displayName: user.display_name });
  broadcast();

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg?.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
    }
  });

  ws.on("close", () => {
    sockets.delete(ws);
    socketMeta.delete(ws);
    broadcast();
  });
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
  console.log(`Marathon Auction server listening on http://localhost:${port}`);
});
