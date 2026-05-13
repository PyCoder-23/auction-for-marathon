export function createAuctionSocket({ onState, onError }) {
  let ws;
  let closed = false;
  let reconnectTimer;

  function wsBase() {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}`;
  }

  function connect(token) {
    if (closed) return;
    const url = `${wsBase()}/ws?token=${encodeURIComponent(token)}`;
    ws = new WebSocket(url);

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "state" && onState) onState(msg.state, msg.presence);
      } catch (e) {
        if (onError) onError(e);
      }
    };

    ws.onclose = () => {
      if (closed) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(async () => {
        try {
          const mod = await import("./auth.js");
          const { mintWsToken } = mod;
          const { wsToken } = await mintWsToken();
          sessionStorage.setItem("marathon_ws", wsToken);
          connect(wsToken);
        } catch (e) {
          if (onError) onError(e);
          reconnectTimer = setTimeout(() => {
            const t = sessionStorage.getItem("marathon_ws");
            if (t) connect(t);
          }, 3000);
        }
      }, 1200);
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  return {
    start(token) {
      closed = false;
      connect(token);
    },
    stop() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
    },
  };
}
