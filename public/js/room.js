import * as api from "./auth.js";
import { createAuctionSocket } from "./ws-client.js";
import { toast, showResultOverlay } from "./ui-components.js";
import { collectRoundPayload, resetRoundForm } from "./room-admin.js";
import { squadCardClass, formatMoney } from "./room-leader.js";

let user = null;
let lastLiveRoundId = null;
const overlayShown = new Set();
let socketCtl = null;

function el(id) {
  return document.getElementById(id);
}

function fmtTime(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
}

function renderPresence(presence) {
  const root = el("presence-list");
  if (!root) return;
  root.innerHTML = "";
  (presence || []).forEach((p) => {
    const s = document.createElement("span");
    s.className = "presence-chip";
    s.textContent = p.displayName;
    root.appendChild(s);
  });
}

function renderFeed(events) {
  const root = el("feed-body");
  if (!root) return;
  root.innerHTML = "";
  (events || []).forEach((e) => {
    const row = document.createElement("div");
    let cls = "feed-row";
    if (e.type === "BID_INVALID") cls += " warn";
    if (e.type === "FINALIZED_UNSOLD") cls += " critical";
    row.className = cls;
    const meta = e.meta || {};
    let text = `${e.type}`;
    if (e.type === "BID") text = `${meta.squadName || e.squadName} bid ${formatMoney(meta.amount)}`;
    else if (e.type === "SKIP") text = `${meta.squadName || e.squadName} skipped`;
    else if (e.type === "BID_INVALID") text = `${meta.squadName || e.squadName} invalid: ${meta.code || "?"}`;
    else if (e.type === "ROUND_LIVE") text = `LIVE — ${meta.itemName} (min ${formatMoney(meta.minBid)})`;
    else if (e.type === "FINALIZED_SOLD")
      text = `SOLD — ${meta.itemName} → ${meta.winnerSquad} for ${formatMoney(meta.amount)}`;
    else if (e.type === "FINALIZED_UNSOLD") text = `UNSOLD — ${meta.itemName}`;
    row.innerHTML = `<span class="feed-time">${fmtTime(e.createdAt)}</span> ${text}`;
    root.appendChild(row);
  });
  root.scrollTop = root.scrollHeight;
}

function maybeShowFinalizeOverlay(state) {
  const curId = state.liveRound?.id ?? null;
  if (lastLiveRoundId != null && curId == null) {
    const rid = lastLiveRoundId;
    for (let i = (state.events || []).length - 1; i >= 0; i--) {
      const e = state.events[i];
      if (e.roundId === rid && (e.type === "FINALIZED_SOLD" || e.type === "FINALIZED_UNSOLD")) {
        if (!overlayShown.has(rid)) {
          overlayShown.add(rid);
          if (e.type === "FINALIZED_SOLD") {
            const m = e.meta || {};
            showResultOverlay({
              title: "LOT CLOSED — SOLD",
              body: m.itemName || "Item",
              sub: `${m.winnerSquad} · ${formatMoney(m.amount)} credits`,
            });
          } else {
            const m = e.meta || {};
            showResultOverlay({
              title: "LOT CLOSED — UNSOLD",
              body: m.itemName || "Item",
              sub: "No qualifying bids at finalize",
            });
          }
        }
        break;
      }
    }
  }
  lastLiveRoundId = curId;
}

function renderArena(state) {
  const strip = el("status-strip");
  const arenaTitle = el("arena-item-title");
  const arenaDesc = el("arena-item-desc");
  const arenaMeta = el("arena-item-extra");
  const highWrap = el("arena-high-bid");

  if (!state.liveRound) {
    strip.className = "status-strip waiting";
    strip.innerHTML = `<span class="pulse-dot"></span> STANDBY — NO LIVE LOT`;
    arenaTitle.className = "item-title shimmer-text";
    arenaTitle.textContent = "Awaiting host directive";
    arenaDesc.textContent =
      "The chamber is armed. When the Head Admin opens a lot, bidding goes live instantly across all squads.";
    arenaMeta.innerHTML = "";
    highWrap.innerHTML = "";
    return;
  }

  const r = state.liveRound;
  strip.className = "status-strip";
  strip.innerHTML = `<span class="pulse-dot"></span> LIVE LOT · ROUND #${r.id}`;
  arenaTitle.className = "item-title";
  arenaTitle.textContent = r.itemName;
  arenaDesc.textContent = r.description || "—";
  const bits = [];
  if (r.squadAffiliation) bits.push(`Affiliation: ${r.squadAffiliation}`);
  if (r.xpStats) bits.push(`XP: ${r.xpStats}`);
  if (r.contributionInfo) bits.push(`Contribution: ${r.contributionInfo}`);
  arenaMeta.innerHTML = bits.length ? bits.map((b) => `<div>${escapeHtml(b)}</div>`).join("") : "";
  if (r.imageUrl) {
    arenaMeta.innerHTML += `<div style="margin-top:0.75rem"><img src="${escapeAttr(r.imageUrl)}" alt="" style="max-width:100%;max-height:220px;border:1px solid rgba(0,255,157,0.25)"></div>`;
  }

  if (r.highBid) {
    highWrap.innerHTML = `<div class="high-bid"><span class="label">Current high</span>${formatMoney(r.highBid.amount)} <span style="font-size:0.9rem;color:var(--text-muted)">— ${escapeHtml(r.highBid.squadName)}</span></div>`;
  } else {
    highWrap.innerHTML = `<div class="high-bid"><span class="label">Current high</span><span style="color:var(--text-muted)">No bids yet · min ${formatMoney(r.minBid)}</span></div>`;
  }
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function escapeAttr(s) {
  return String(s).replace(/"/g, "&quot;");
}

function renderSquads(state) {
  const root = el("squad-strip");
  if (!root) return;
  root.innerHTML = "";
  (state.squads || []).forEach((s) => {
    const card = document.createElement("div");
    const sk = squadCardClass(s.key);
    const isSelf = user && user.role === "squad_leader" && user.squadId === s.id;
    card.className = `hud-panel squad-card ${sk}${isSelf ? " self" : ""}`;
    let statusLabel = "ACTIVE";
    let statusCls = "live";
    if (s.skipped) {
      statusLabel = "SKIPPED";
      statusCls = "skipped";
    } else if (s.hasBid) {
      statusLabel = "BIDDING";
      statusCls = "bidding";
    } else if (!state.liveRound) {
      statusLabel = "IDLE";
      statusCls = "";
    }

    let controls = "";
    if (isSelf && state.liveRound) {
      const skipped = s.skipped;
      controls = `
        <div style="margin-top:0.65rem;padding-top:0.65rem;border-top:1px solid rgba(184,190,200,0.15)">
          <label class="field" style="margin-bottom:0.5rem">
            <span style="font-size:0.6rem;letter-spacing:0.12em;color:var(--text-muted)">BID AMOUNT</span>
            <input type="number" id="bid-input" min="1" step="1" ${skipped ? "disabled" : ""} style="margin-top:0.25rem" />
          </label>
          <div class="btn-row">
            <button type="button" class="btn btn-primary" id="btn-bid" ${skipped ? "disabled" : ""}>PLACE BID</button>
            <button type="button" class="btn btn-ghost" id="btn-skip" ${skipped ? "disabled" : ""}>SKIP LOT</button>
          </div>
        </div>`;
    }

    card.innerHTML = `
      <h3>${escapeHtml(s.name)}</h3>
      <div class="squad-treasury">${formatMoney(s.treasury)}</div>
      <div class="squad-status ${statusCls}">${statusLabel}</div>
      ${controls}
    `;
    root.appendChild(card);

    if (isSelf && state.liveRound && !s.skipped) {
      card.querySelector("#btn-bid").onclick = async () => {
        const input = card.querySelector("#bid-input");
        const raw = input.value;
        try {
          await api.placeBid(state.liveRound.id, raw);
          input.value = "";
        } catch (e) {
          toast(e.message || "Bid rejected", "error");
        }
      };
      card.querySelector("#btn-skip").onclick = async () => {
        if (!confirm("Skip this lot for your squad? You cannot bid again this round.")) return;
        try {
          await api.skipRound(state.liveRound.id);
        } catch (e) {
          toast(e.message || "Skip failed", "error");
        }
      };
    }
  });
}

function renderAdmin(state) {
  const deck = el("command-deck");
  if (!deck) return;
  if (user?.role !== "head_admin") {
    deck.classList.add("hidden");
    document.querySelector(".room-grid")?.classList.add("no-admin");
    return;
  }
  document.querySelector(".room-grid")?.classList.remove("no-admin");
  deck.classList.remove("hidden");
  const fin = el("btn-finalize");
  if (fin) fin.disabled = !state.liveRound;
}

function applyState(state, presence) {
  maybeShowFinalizeOverlay(state);
  renderPresence(presence);
  renderFeed(state.events);
  renderArena(state);
  renderSquads(state);
  renderAdmin(state);
}

function spawnParticles() {
  const root = el("particles");
  if (!root) return;
  root.innerHTML = "";
  for (let i = 0; i < 24; i++) {
    const s = document.createElement("span");
    s.style.left = `${Math.random() * 100}%`;
    s.style.animationDelay = `${Math.random() * 16}s`;
    s.style.animationDuration = `${14 + Math.random() * 12}s`;
    root.appendChild(s);
  }
}

async function init() {
  spawnParticles();
  try {
    const m = await api.me();
    user = m.user;
    el("user-label").textContent = user.displayName;
  } catch {
    api.redirect("/login.html");
    return;
  }

  if (user.role === "head_admin") {
    el("nav-logs")?.classList.remove("hidden");
  }

  let token = sessionStorage.getItem("marathon_ws");
  if (!token) {
    const { wsToken } = await api.mintWsToken();
    token = wsToken;
    sessionStorage.setItem("marathon_ws", token);
  }

  const initial = await api.getState();
  lastLiveRoundId = initial.liveRound?.id ?? null;
  applyState(initial, []);

  socketCtl = createAuctionSocket({
    onState: (st, pres) => applyState(st, pres),
    onError: () => {},
  });
  socketCtl.start(token);

  const form = el("round-form");
  if (form) {
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      try {
        const body = collectRoundPayload(form);
        await api.createRound(body);
        resetRoundForm(form);
        toast("Lot is now LIVE");
      } catch (e) {
        toast(e.message || "Failed to open lot", "error");
      }
    });
  }

  const btnFin = el("btn-finalize");
  if (btnFin) {
    btnFin.onclick = async () => {
      const st = await api.getState();
      if (!st.liveRound) return;
      if (!confirm("Finalize this lot now? Treasury and history will update.")) return;
      try {
        const res = await api.finalizeRound(st.liveRound.id);
        const rid = st.liveRound.id;
        overlayShown.add(rid);
        if (res.unsold) {
          showResultOverlay({
            title: "LOT CLOSED — UNSOLD",
            body: st.liveRound.itemName,
            sub: "No qualifying bids",
          });
        } else {
          showResultOverlay({
            title: "LOT CLOSED — SOLD",
            body: st.liveRound.itemName,
            sub: `${res.winnerSquadName} · ${formatMoney(res.winningAmount)}`,
          });
        }
      } catch (e) {
        toast(e.message || "Finalize failed", "error");
      }
    };
  }

  el("btn-logout").onclick = async () => {
    socketCtl?.stop();
    await api.logout();
    sessionStorage.removeItem("marathon_ws");
    api.redirect("/login.html");
  };
}

init();
