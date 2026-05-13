import crypto from "crypto";

function nowIso() {
  return new Date().toISOString();
}

function stripTags(s) {
  if (typeof s !== "string") return "";
  return s.replace(/<[^>]*>/g, "").trim();
}

export function getUserByUsername(db, username) {
  return db
    .prepare(
      `SELECT u.id, u.username, u.password_hash, u.role, u.squad_id, u.display_name,
              s.key AS squad_key, s.name AS squad_name, s.treasury_balance
       FROM users u
       LEFT JOIN squads s ON s.id = u.squad_id
       WHERE u.username = ?`
    )
    .get(username);
}

export function getUserById(db, id) {
  return db
    .prepare(
      `SELECT u.id, u.username, u.role, u.squad_id, u.display_name,
              s.key AS squad_key, s.name AS squad_name, s.treasury_balance
       FROM users u
       LEFT JOIN squads s ON s.id = u.squad_id
       WHERE u.id = ?`
    )
    .get(id);
}

export function getLiveRound(db) {
  return db
    .prepare(
      `SELECT id, status, item_name, min_bid, description, squad_affiliation, xp_stats,
              contribution_info, image_url, created_at
       FROM rounds WHERE status = 'live' ORDER BY id DESC LIMIT 1`
    )
    .get();
}

export function getCurrentHighBid(db, roundId) {
  const row = db
    .prepare(
      `SELECT b.amount, b.squad_id, s.key AS squad_key, s.name AS squad_name
       FROM bids b
       JOIN squads s ON s.id = b.squad_id
       WHERE b.round_id = ?
       ORDER BY b.amount DESC, b.id ASC
       LIMIT 1`
    )
    .get(roundId);
  return row || null;
}

export function getSkipsForRound(db, roundId) {
  return db
    .prepare(
      `SELECT rs.squad_id, s.key AS squad_key, s.name AS squad_name
       FROM round_skips rs
       JOIN squads s ON s.id = rs.squad_id
       WHERE rs.round_id = ?`
    )
    .all(roundId);
}

export function getAllSquads(db) {
  return db
    .prepare(`SELECT id, key, name, treasury_balance FROM squads ORDER BY id ASC`)
    .all();
}

export function appendEvent(db, { roundId, eventType, squadId, userId, meta }) {
  db.prepare(
    `INSERT INTO auction_events (round_id, event_type, squad_id, user_id, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    roundId ?? null,
    eventType,
    squadId ?? null,
    userId ?? null,
    meta ? JSON.stringify(meta) : null,
    nowIso()
  );
}

export function getRecentEvents(db, limit = 100) {
  return db
    .prepare(
      `SELECT e.id, e.round_id, e.event_type, e.squad_id, e.user_id, e.meta_json, e.created_at,
              s.name AS squad_name, s.key AS squad_key
       FROM auction_events e
       LEFT JOIN squads s ON s.id = e.squad_id
       ORDER BY e.id DESC
       LIMIT ?`
    )
    .all(limit)
    .reverse();
}

export function createLiveRound(db, adminUserId, body) {
  const existing = getLiveRound(db);
  if (existing) {
    return {
      ok: false,
      code: "ROUND_ALREADY_LIVE",
      message: "Finalize the current round before starting another.",
    };
  }

  const itemName = stripTags(String(body.itemName || body.item_name || "")).slice(0, 200);
  const minBid = Number(body.minBid ?? body.min_bid);
  const description = stripTags(String(body.description || "")).slice(0, 2000);
  const squadAffiliation =
    body.squadAffiliation != null ? stripTags(String(body.squadAffiliation)).slice(0, 200) : null;
  const xpStats = body.xpStats != null ? stripTags(String(body.xpStats)).slice(0, 500) : null;
  const contributionInfo =
    body.contributionInfo != null ? stripTags(String(body.contributionInfo)).slice(0, 500) : null;
  const imageUrl = body.imageUrl != null ? stripTags(String(body.imageUrl)).slice(0, 500) : null;

  if (!itemName) {
    return { ok: false, code: "INVALID_ITEM", message: "Item name is required." };
  }
  if (!Number.isInteger(minBid) || minBid < 1) {
    return { ok: false, code: "INVALID_MIN_BID", message: "Minimum bid must be a positive integer." };
  }

  const t = nowIso();
  const info = db
    .prepare(
      `INSERT INTO rounds (status, item_name, min_bid, description, squad_affiliation, xp_stats, contribution_info, image_url, created_at, unsold)
     VALUES ('live', ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    )
    .run(itemName, minBid, description, squadAffiliation, xpStats, contributionInfo, imageUrl, t);

  const roundId = info.lastInsertRowid;
  appendEvent(db, {
    roundId,
    eventType: "ROUND_LIVE",
    squadId: null,
    userId: adminUserId,
    meta: { itemName, minBid },
  });

  return { ok: true, roundId };
}

export function recordSkip(db, roundId, user) {
  const round = db.prepare("SELECT id, status FROM rounds WHERE id = ?").get(roundId);
  if (!round || round.status !== "live") {
    return { ok: false, code: "ROUND_NOT_LIVE", message: "No live auction round." };
  }
  if (user.role !== "squad_leader" || !user.squad_id) {
    return { ok: false, code: "FORBIDDEN", message: "Only squad leaders can skip." };
  }

  const existing = db
    .prepare("SELECT 1 FROM round_skips WHERE round_id = ? AND squad_id = ?")
    .get(roundId, user.squad_id);
  if (existing) {
    return { ok: false, code: "ALREADY_SKIPPED", message: "Your squad has already skipped this round." };
  }

  db.prepare(
    `INSERT INTO round_skips (round_id, squad_id, user_id, skipped_at) VALUES (?, ?, ?, ?)`
  ).run(roundId, user.squad_id, user.id, nowIso());

  appendEvent(db, {
    roundId,
    eventType: "SKIP",
    squadId: user.squad_id,
    userId: user.id,
    meta: { squadName: user.squad_name },
  });

  return { ok: true };
}

export function placeBid(db, roundId, user, rawAmount) {
  const round = db.prepare("SELECT id, status, min_bid FROM rounds WHERE id = ?").get(roundId);
  if (!round || round.status !== "live") {
    return { ok: false, code: "ROUND_NOT_LIVE", message: "No live auction round." };
  }
  if (user.role !== "squad_leader" || !user.squad_id) {
    return { ok: false, code: "FORBIDDEN", message: "Only squad leaders can bid." };
  }

  const skipped = db
    .prepare("SELECT 1 FROM round_skips WHERE round_id = ? AND squad_id = ?")
    .get(roundId, user.squad_id);
  if (skipped) {
    return { ok: false, code: "ALREADY_SKIPPED", message: "You have skipped this round." };
  }

  const amount = typeof rawAmount === "string" ? parseInt(rawAmount, 10) : Number(rawAmount);
  if (!Number.isInteger(amount)) {
    appendEvent(db, {
      roundId,
      eventType: "BID_INVALID",
      squadId: user.squad_id,
      userId: user.id,
      meta: { code: "NOT_INTEGER", squadName: user.squad_name },
    });
    return { ok: false, code: "NOT_INTEGER", message: "Bid must be an integer." };
  }

  if (amount < round.min_bid) {
    appendEvent(db, {
      roundId,
      eventType: "BID_INVALID",
      squadId: user.squad_id,
      userId: user.id,
      meta: { code: "BELOW_MIN", amount, min: round.min_bid, squadName: user.squad_name },
    });
    return { ok: false, code: "BELOW_MIN", message: `Bid must be at least ${round.min_bid}.` };
  }

  const high = getCurrentHighBid(db, roundId);
  if (high && amount <= high.amount) {
    appendEvent(db, {
      roundId,
      eventType: "BID_INVALID",
      squadId: user.squad_id,
      userId: user.id,
      meta: { code: "NOT_ABOVE_HIGH", amount, high: high.amount, squadName: user.squad_name },
    });
    return {
      ok: false,
      code: "NOT_ABOVE_HIGH",
      message: `Bid must be higher than the current high (${high.amount}).`,
    };
  }

  const treasury = db.prepare("SELECT treasury_balance FROM squads WHERE id = ?").get(user.squad_id)
    .treasury_balance;
  if (amount > treasury) {
    appendEvent(db, {
      roundId,
      eventType: "BID_INVALID",
      squadId: user.squad_id,
      userId: user.id,
      meta: { code: "EXCEEDS_TREASURY", amount, treasury, squadName: user.squad_name },
    });
    return { ok: false, code: "EXCEEDS_TREASURY", message: "Bid exceeds your squad treasury." };
  }

  const t = nowIso();
  db.prepare(
    `INSERT INTO bids (round_id, squad_id, user_id, amount, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(roundId, user.squad_id, user.id, amount, t);

  appendEvent(db, {
    roundId,
    eventType: "BID",
    squadId: user.squad_id,
    userId: user.id,
    meta: { amount, squadName: user.squad_name },
  });

  return { ok: true, amount, high: amount };
}

export function finalizeRound(db, roundId, adminUserId) {
  const round = db.prepare(`SELECT id, status, item_name, min_bid FROM rounds WHERE id = ?`).get(roundId);
  if (!round || round.status !== "live") {
    return { ok: false, code: "ROUND_NOT_LIVE", message: "Round is not live." };
  }

  const high = getCurrentHighBid(db, roundId);
  const t = nowIso();

  const tx = db.transaction(() => {
    if (!high) {
      db.prepare(
        `UPDATE rounds SET status = 'finalized', finalized_at = ?, unsold = 1, winner_squad_id = NULL, winning_amount = NULL WHERE id = ?`
      ).run(t, roundId);
      appendEvent(db, {
        roundId,
        eventType: "FINALIZED_UNSOLD",
        squadId: null,
        userId: adminUserId,
        meta: { itemName: round.item_name },
      });
      return { unsold: true };
    }

    db.prepare(`UPDATE squads SET treasury_balance = treasury_balance - ? WHERE id = ?`).run(
      high.amount,
      high.squad_id
    );

    db.prepare(`INSERT INTO ledger (squad_id, delta, reason, round_id, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      high.squad_id,
      -high.amount,
      "AUCTION_WIN",
      roundId,
      t
    );

    db.prepare(
      `UPDATE rounds SET status = 'finalized', finalized_at = ?, unsold = 0, winner_squad_id = ?, winning_amount = ? WHERE id = ?`
    ).run(t, high.squad_id, high.amount, roundId);

    appendEvent(db, {
      roundId,
      eventType: "FINALIZED_SOLD",
      squadId: high.squad_id,
      userId: adminUserId,
      meta: {
        itemName: round.item_name,
        amount: high.amount,
        winnerSquad: high.squad_name,
        winnerKey: high.squad_key,
      },
    });

    return {
      unsold: false,
      winnerSquadId: high.squad_id,
      winnerSquadName: high.squad_name,
      winnerSquadKey: high.squad_key,
      winningAmount: high.amount,
    };
  });

  const result = tx();
  return { ok: true, ...result };
}

export function getHistoryPage(db, { sort = "created_at", dir = "desc", limit = 50, offset = 0 }) {
  const allowed = new Set(["created_at", "finalized_at", "winning_amount", "item_name"]);
  const col = allowed.has(sort) ? sort : "created_at";
  const order = dir === "asc" ? "ASC" : "DESC";
  const orderSql = `ORDER BY r.${col} ${order}`;

  const rows = db
    .prepare(
      `SELECT r.id, r.item_name, r.min_bid, r.description, r.created_at, r.finalized_at,
              r.unsold, r.winning_amount,
              w.name AS winner_squad_name, w.key AS winner_squad_key
       FROM rounds r
       LEFT JOIN squads w ON w.id = r.winner_squad_id
       WHERE r.status = 'finalized'
       ${orderSql}
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset);

  const total = db.prepare(`SELECT COUNT(*) AS c FROM rounds WHERE status = 'finalized'`).get().c;
  return { rows, total };
}

export function getAuditLogs(db, limit = 200) {
  return db
    .prepare(
      `SELECT e.id, e.round_id, e.event_type, e.meta_json, e.created_at,
              s.name AS squad_name, u.username
       FROM auction_events e
       LEFT JOIN squads s ON s.id = e.squad_id
       LEFT JOIN users u ON u.id = e.user_id
       ORDER BY e.id DESC
       LIMIT ?`
    )
    .all(limit);
}

export function buildPublicState(db) {
  const squads = getAllSquads(db);
  const live = getLiveRound(db);
  let high = null;
  let skips = [];
  if (live) {
    high = getCurrentHighBid(db, live.id);
    skips = getSkipsForRound(db, live.id);
  }

  const skipSet = new Set(skips.map((s) => s.squad_id));
  let bidSquads = new Set();
  if (live) {
    const bidRows = db
      .prepare(`SELECT DISTINCT squad_id FROM bids WHERE round_id = ?`)
      .all(live.id);
    bidSquads = new Set(bidRows.map((r) => r.squad_id));
  }
  const squadStates = squads.map((s) => ({
    id: s.id,
    key: s.key,
    name: s.name,
    treasury: s.treasury_balance,
    skipped: live ? skipSet.has(s.id) : false,
    hasBid: live ? bidSquads.has(s.id) : false,
  }));

  return {
    liveRound: live
      ? {
          id: live.id,
          itemName: live.item_name,
          minBid: live.min_bid,
          description: live.description,
          squadAffiliation: live.squad_affiliation,
          xpStats: live.xp_stats,
          contributionInfo: live.contribution_info,
          imageUrl: live.image_url,
          createdAt: live.created_at,
          highBid: high
            ? { amount: high.amount, squadKey: high.squad_key, squadName: high.squad_name }
            : null,
        }
      : null,
    squads: squadStates,
    events: getRecentEvents(db, 100),
  };
}

export function issueWsToken() {
  return crypto.randomBytes(24).toString("hex");
}
