import * as api from "./auth.js";

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

document.getElementById("btn-logout").onclick = async () => {
  await api.logout();
  sessionStorage.removeItem("marathon_ws");
  window.location.href = "/login.html";
};

const u = await api.me().catch(() => null);
if (!u || u.user.role !== "head_admin") {
  window.location.href = "/room.html";
} else {
  const { rows } = await api.fetchLogs(300);
  const tbody = document.getElementById("log-body");
  for (const r of rows) {
    const tr = document.createElement("tr");
    const meta = r.meta ? JSON.stringify(r.meta) : "";
    tr.innerHTML = `
      <td>${escapeHtml(r.createdAt)}</td>
      <td>${escapeHtml(r.type)}</td>
      <td>${escapeHtml(r.username || "—")}</td>
      <td>${escapeHtml(r.squadName || "—")}</td>
      <td>${r.roundId ?? "—"}</td>
      <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(meta)}">${escapeHtml(meta)}</td>
    `;
    tbody.appendChild(tr);
  }
}
