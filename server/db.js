import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcrypt";
import { openDatabaseSync } from "./sqlite-db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

const DEFAULT_DB = path.join(rootDir, "data.sqlite");

export function openDb() {
  const file = process.env.SQLITE_PATH || DEFAULT_DB;
  const db = openDatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS squads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      treasury_balance INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('head_admin', 'squad_leader')),
      squad_id INTEGER REFERENCES squads(id),
      display_name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL CHECK (status IN ('live', 'finalized')),
      item_name TEXT NOT NULL,
      min_bid INTEGER NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      squad_affiliation TEXT,
      xp_stats TEXT,
      contribution_info TEXT,
      image_url TEXT,
      created_at TEXT NOT NULL,
      finalized_at TEXT,
      winner_squad_id INTEGER REFERENCES squads(id),
      winning_amount INTEGER,
      unsold INTEGER NOT NULL DEFAULT 0 CHECK (unsold IN (0, 1))
    );

    CREATE TABLE IF NOT EXISTS bids (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL REFERENCES rounds(id),
      squad_id INTEGER NOT NULL REFERENCES squads(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      amount INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS round_skips (
      round_id INTEGER NOT NULL REFERENCES rounds(id),
      squad_id INTEGER NOT NULL REFERENCES squads(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      skipped_at TEXT NOT NULL,
      PRIMARY KEY (round_id, squad_id)
    );

    CREATE TABLE IF NOT EXISTS auction_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER REFERENCES rounds(id),
      event_type TEXT NOT NULL,
      squad_id INTEGER REFERENCES squads(id),
      user_id INTEGER REFERENCES users(id),
      meta_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      squad_id INTEGER NOT NULL REFERENCES squads(id),
      delta INTEGER NOT NULL,
      reason TEXT NOT NULL,
      round_id INTEGER REFERENCES rounds(id),
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_rounds_status ON rounds(status);
    CREATE INDEX IF NOT EXISTS idx_bids_round ON bids(round_id);
    CREATE INDEX IF NOT EXISTS idx_events_created ON auction_events(created_at DESC);
  `);

  // Migrations for Player auctions
  try { db.exec("ALTER TABLE rounds ADD COLUMN item_type TEXT NOT NULL DEFAULT 'item'"); } catch {}
  try { db.exec("ALTER TABLE rounds ADD COLUMN owner_squad_id INTEGER REFERENCES squads(id)"); } catch {}
  try { db.exec("ALTER TABLE rounds ADD COLUMN phase INTEGER NOT NULL DEFAULT 1"); } catch {}
  try { db.exec("ALTER TABLE rounds ADD COLUMN phase1_winner_id INTEGER REFERENCES squads(id)"); } catch {}
}

const SQUADS = [
  { key: "ZENITH", name: "Zenith Sentinels" },
  { key: "APEX", name: "Apex Titans" },
  { key: "MERIDIAN", name: "Meridian Arbiters" },
  { key: "HORIZON", name: "Horizon Vanguards" },
];

export function seedSquads(db) {
  const initial = Number(process.env.INITIAL_TREASURY || 10000);
  const ins = db.prepare(
    `INSERT INTO squads (key, name, treasury_balance) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET name = excluded.name`
  );
  for (const s of SQUADS) {
    ins.run(s.key, s.name, initial);
  }
}

export async function seedUsers(db) {
  const adminUser = process.env.ADMIN_USER;
  const adminPass = process.env.ADMIN_PASS;
  if (!adminUser || !adminPass) {
    throw new Error("ADMIN_USER and ADMIN_PASS are required for first-time seeding");
  }

  const pairs = [
    ["ZENITH", process.env.ZENITH_USER, process.env.ZENITH_PASS],
    ["APEX", process.env.APEX_USER, process.env.APEX_PASS],
    ["MERIDIAN", process.env.MERIDIAN_USER, process.env.MERIDIAN_PASS],
    ["HORIZON", process.env.HORIZON_USER, process.env.HORIZON_PASS],
  ];
  for (const [key, u, p] of pairs) {
    if (!u || !p) {
      throw new Error(
        `${key}_USER and ${key}_PASS are required (e.g. ZENITH_USER, ZENITH_PASS)`
      );
    }
  }

  const getSquad = db.prepare("SELECT id FROM squads WHERE key = ?");
  const upsertUser = db.prepare(`
    INSERT INTO users (username, password_hash, role, squad_id, display_name)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET
      password_hash = excluded.password_hash,
      role = excluded.role,
      squad_id = excluded.squad_id,
      display_name = excluded.display_name
  `);

  const hash = await bcrypt.hash(adminPass, 11);
  upsertUser.run(adminUser, hash, "head_admin", null, "Head Admin");

  const displayNames = {
    ZENITH: "Zenith Sentinels Leader",
    APEX: "Apex Titans Leader",
    MERIDIAN: "Meridian Arbiters Leader",
    HORIZON: "Horizon Vanguards Leader",
  };

  for (const [key, u, p] of pairs) {
    const squadId = getSquad.get(key).id;
    const h = await bcrypt.hash(p, 11);
    upsertUser.run(u, h, "squad_leader", squadId, displayNames[key]);
  }
}

export async function ensureSeeded(db) {
  const n = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
  if (n === 0) {
    seedSquads(db);
    await seedUsers(db);
    return;
  }
  seedSquads(db);
}
