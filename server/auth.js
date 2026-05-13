export function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.session?.userId || req.session.role !== "head_admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}

export function requireLeader(req, res, next) {
  if (!req.session?.userId || req.session.role !== "squad_leader") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}

export function sessionUserPayload(session) {
  return {
    id: session.userId,
    username: session.username,
    role: session.role,
    displayName: session.displayName,
    squadId: session.squadId ?? null,
    squadKey: session.squadKey ?? null,
    squadName: session.squadName ?? null,
  };
}
