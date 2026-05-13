import * as api from "./auth.js";

let rows = [];
let sortKey = "created_at";
let sortDir = "desc";
let filter = "";

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

function fmt(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function render() {
  const tbody = document.getElementById("hist-body");
  const empty = document.getElementById("hist-empty");
  const q = filter.trim().toLowerCase();
  let list = rows.filter((r) => !q || (r.item_name || "").toLowerCase().includes(q));

  list = [...list].sort((a, b) => {
    let va = a[sortKey];
    let vb = b[sortKey];
    if (sortKey === "winning_amount") {
      va = va == null ? -1 : va;
      vb = vb == null ? -1 : vb;
    }
    if (va == null) va = "";
    if (vb == null) vb = "";
    if (typeof va === "string") {
      va = va.toLowerCase();
      vb = String(vb).toLowerCase();
    }
    const c = va < vb ? -1 : va > vb ? 1 : 0;
    return sortDir === "asc" ? c : -c;
  });

  tbody.innerHTML = "";
  if (!list.length) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  for (const r of list) {
    const tr = document.createElement("tr");
    const result = r.unsold
      ? `<span style="color:var(--danger)">UNSOLD</span>`
      : `${escapeHtml(r.winner_squad_name || "")}`;
    const win = r.unsold ? "—" : new Intl.NumberFormat().format(r.winning_amount ?? 0);
    tr.innerHTML = `
      <td>${escapeHtml(r.item_name)}</td>
      <td>${escapeHtml(fmt(r.created_at))}</td>
      <td>${escapeHtml(fmt(r.finalized_at))}</td>
      <td>${result}</td>
      <td>${win}</td>
    `;
    tbody.appendChild(tr);
  }
}

document.querySelectorAll("#hist-table th[data-sort]").forEach((th) => {
  th.addEventListener("click", () => {
    const k = th.getAttribute("data-sort");
    if (sortKey === k) sortDir = sortDir === "asc" ? "desc" : "asc";
    else {
      sortKey = k;
      sortDir = "desc";
    }
    render();
  });
});

document.getElementById("filter-q").addEventListener("input", (e) => {
  filter = e.target.value;
  render();
});

document.getElementById("btn-logout").onclick = async () => {
  await api.logout();
  sessionStorage.removeItem("marathon_ws");
  window.location.href = "/login.html";
};

const authed = await api.me().then(() => true).catch(() => false);
if (!authed) {
  window.location.href = "/login.html";
} else {
  const data = await api.fetchHistory({ limit: 100, offset: 0, sort: "created_at", dir: "desc" });
  rows = data.rows || [];
  render();
}
