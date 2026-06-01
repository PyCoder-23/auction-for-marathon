async function api(path, options = {}) {
  const opts = {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  };
  if (opts.body && typeof opts.body === "object" && !(opts.body instanceof FormData)) {
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, opts);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text || "Invalid response" };
  }
  if (!res.ok) {
    const err = new Error(data?.error || res.statusText);
    err.code = data?.code;
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

export async function login(username, password) {
  return api("/api/login", { method: "POST", body: { username, password } });
}

export async function logout() {
  return api("/api/logout", { method: "POST" });
}

export async function me() {
  return api("/api/me");
}

export async function getState() {
  return api("/api/state");
}

export async function mintWsToken() {
  return api("/api/ws-token", { method: "POST", body: {} });
}

export async function createRound(body) {
  return api("/api/rounds", { method: "POST", body });
}

export async function finalizeRound(roundId) {
  return api(`/api/rounds/${roundId}/finalize`, { method: "POST", body: {} });
}

export async function placeBid(roundId, amount) {
  return api(`/api/rounds/${roundId}/bid`, { method: "POST", body: { amount } });
}

export async function skipRound(roundId) {
  return api(`/api/rounds/${roundId}/skip`, { method: "POST", body: {} });
}

export async function fetchHistory(params = {}) {
  const q = new URLSearchParams(params);
  return api(`/api/history?${q}`);
}

export async function fetchLogs(limit = 200) {
  return api(`/api/logs?limit=${limit}`);
}

export function redirect(path) {
  window.location.href = path;
}

export async function setSquadTreasury(squadId, amount) {
  return api(`/api/squads/${squadId}/treasury`, { method: "POST", body: { amount } });
}

export async function advancePhase(roundId) {
  return api(`/api/rounds/${roundId}/advance`, { method: "POST", body: {} });
}
