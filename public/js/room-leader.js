export function squadCardClass(key) {
  const k = String(key || "").toUpperCase();
  if (k === "ZENITH") return "zenith";
  if (k === "APEX") return "apex";
  if (k === "MERIDIAN") return "meridian";
  if (k === "HORIZON") return "horizon";
  return "zenith";
}

export function formatMoney(n) {
  if (n == null) return "—";
  return new Intl.NumberFormat(undefined).format(n);
}
