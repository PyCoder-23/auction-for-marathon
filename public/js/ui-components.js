export function toast(message, kind = "info") {
  let el = document.getElementById("toast-root");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast-root";
    el.style.cssText =
      "position:fixed;bottom:1.25rem;right:1.25rem;z-index:2000;display:flex;flex-direction:column;gap:0.5rem;max-width:min(360px,90vw);pointer-events:none;";
    document.body.appendChild(el);
  }
  const t = document.createElement("div");
  t.textContent = message;
  t.style.cssText = `pointer-events:auto;padding:0.65rem 0.85rem;font-size:0.85rem;font-family:var(--font-mono);border:1px solid rgba(0,255,157,0.4);background:rgba(5,8,10,0.95);color:#e6edf3;animation:feed-flash 0.5s ease-out;`;
  if (kind === "error") {
    t.style.borderColor = "rgba(255,77,109,0.6)";
    t.style.color = "#ffb8c4";
  }
  el.appendChild(t);
  setTimeout(() => {
    t.style.opacity = "0";
    t.style.transition = "opacity 0.4s";
    setTimeout(() => t.remove(), 400);
  }, 4200);
}

export function showResultOverlay(payload) {
  let root = document.getElementById("result-overlay");
  if (root) root.remove();
  root = document.createElement("div");
  root.id = "result-overlay";
  root.className = "overlay-backdrop";
  root.innerHTML = `
    <div class="hud-panel overlay-card">
      <h2>${payload.title}</h2>
      <p>${payload.body}</p>
      <p class="shimmer-text" style="font-size:1.1rem;margin-top:0.75rem">${payload.sub || ""}</p>
      <div style="margin-top:1.5rem">
        <button type="button" class="btn btn-primary" id="result-overlay-close">ACKNOWLEDGE</button>
      </div>
    </div>
  `;
  document.body.appendChild(root);
  root.querySelector("#result-overlay-close").onclick = () => root.remove();
  root.addEventListener("click", (e) => {
    if (e.target === root) root.remove();
  });
}
