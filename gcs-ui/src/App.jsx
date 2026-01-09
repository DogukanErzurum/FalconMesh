import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

function fmtTs(ts) {
  if (!ts) return "-";
  return ts.replace("T", " ").replace("Z", " UTC");
}

function badgeClass(ok) {
  return ok ? "badge ok" : "badge bad";
}

export default function App() {
  const [nodes, setNodes] = useState([]);
  const [health, setHealth] = useState(null);
  const [err, setErr] = useState("");
  const [wsStatus, setWsStatus] = useState("DISCONNECTED");

  const [target, setTarget] = useState("all");
  const [sending, setSending] = useState(false);
  const [lastCmd, setLastCmd] = useState(null);

  const byIdRef = useRef(new Map()); // node_id -> last state

  // MAP
  const canvasRef = useRef(null);
  const mapHitRef = useRef([]); // {node_id, cx, cy, r}
  const [selectedNode, setSelectedNode] = useState(null);

  async function refreshHealth() {
    try {
      const h = await fetch("/health");
      setHealth(await h.json());
    } catch {
      // ignore
    }
  }

  function upsertNode(n) {
    const id = n?.node_id;
    if (!id) return;
    byIdRef.current.set(id, n);
    setNodes(Array.from(byIdRef.current.values()));
  }

  function setSnapshot(arr) {
    byIdRef.current = new Map((arr || []).map((n) => [n.node_id, n]));
    setNodes(Array.from(byIdRef.current.values()));
  }

  async function sendCommand(command) {
    try {
      setSending(true);
      setErr("");
      const res = await fetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target, command, params: {} }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.err || "command failed");
      setLastCmd({ ts: j.ts, target, command, delivered: j.delivered });
      refreshHealth();
    } catch (e) {
      setErr("Command error: " + String(e));
    } finally {
      setSending(false);
    }
  }

  // WS telemetry
  useEffect(() => {
    setErr("");
    refreshHealth();

    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const wsUrl = `${proto}://${window.location.host}/ws/telemetry`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setWsStatus("CONNECTED");
      refreshHealth();
    };
    ws.onclose = () => setWsStatus("DISCONNECTED");
    ws.onerror = () => setWsStatus("ERROR");

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg && msg.type === "snapshot") {
          setSnapshot(msg.nodes || []);
          return;
        }
        upsertNode(msg);
      } catch (e) {
        setErr("WS parse error: " + String(e));
      }
    };

    const t = setInterval(refreshHealth, 2000);

    return () => {
      clearInterval(t);
      try { ws.close(); } catch {}
    };
  }, []);

  const sorted = useMemo(() => {
    return [...nodes].sort((a, b) => (a.node_id || "").localeCompare(b.node_id || ""));
  }, [nodes]);

  const targets = useMemo(() => ["all", ...sorted.map((n) => n.node_id)], [sorted]);

  // MAP draw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));

    canvas.width = w * dpr;
    canvas.height = h * dpr;

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // background
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, w, h);

    // bounds from nodes
    const xs = sorted.map((n) => n.pos?.x).filter((v) => typeof v === "number");
    const ys = sorted.map((n) => n.pos?.y).filter((v) => typeof v === "number");

    let minX = -80, maxX = 80, minY = -80, maxY = 80;
    if (xs.length && ys.length) {
      minX = Math.min(...xs);
      maxX = Math.max(...xs);
      minY = Math.min(...ys);
      maxY = Math.max(...ys);
      const padX = Math.max(10, (maxX - minX) * 0.15);
      const padY = Math.max(10, (maxY - minY) * 0.15);
      minX -= padX; maxX += padX;
      minY -= padY; maxY += padY;
    }

    const worldW = Math.max(1e-6, maxX - minX);
    const worldH = Math.max(1e-6, maxY - minY);

    const scale = Math.min((w - 24) / worldW, (h - 24) / worldH);
    const ox = 12 - minX * scale;

    function toScreen(wx, wy) {
      const sx = ox + wx * scale;
      const sy = 12 + (maxY - wy) * scale; // flip y
      return [sx, sy];
    }

    // grid
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    const grid = 50;
    for (let gx = 0; gx <= w; gx += grid) {
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke();
    }
    for (let gy = 0; gy <= h; gy += grid) {
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
    }

    // origin marker
    const [zx, zy] = toScreen(0, 0);
    ctx.fillStyle = "rgba(96,165,250,0.9)";
    ctx.beginPath(); ctx.arc(zx, zy, 3, 0, Math.PI * 2); ctx.fill();

    mapHitRef.current = [];

    for (const n of sorted) {
      const px = n.pos?.x;
      const py = n.pos?.y;
      if (typeof px !== "number" || typeof py !== "number") continue;

      const [cx, cy] = toScreen(px, py);

      const heading = typeof n.heading_deg === "number" ? n.heading_deg : 0;
      const rad = (heading * Math.PI) / 180;

      const state = n.state || "UNKNOWN";
      const isSelected = selectedNode === n.node_id;

      let fill = "rgba(229,231,235,0.90)";
      let ring = "rgba(255,255,255,0.25)";
      if (state === "HOLD") { fill = "rgba(250,204,21,0.95)"; ring = "rgba(250,204,21,0.35)"; }
      if (state === "RTB") { fill = "rgba(239,68,68,0.95)"; ring = "rgba(239,68,68,0.35)"; }
      if (state === "FORM_UP") { fill = "rgba(34,197,94,0.95)"; ring = "rgba(34,197,94,0.35)"; }
      if (state === "NORMAL") { fill = "rgba(96,165,250,0.95)"; ring = "rgba(96,165,250,0.35)"; }

      ctx.strokeStyle = isSelected ? "rgba(255,255,255,0.9)" : ring;
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.beginPath();
      ctx.arc(cx, cy, isSelected ? 14 : 12, 0, Math.PI * 2);
      ctx.stroke();

      const size = 10;
      const p1 = [cx + Math.cos(rad) * size, cy - Math.sin(rad) * size];
      const p2 = [cx + Math.cos(rad + 2.5) * size * 0.8, cy - Math.sin(rad + 2.5) * size * 0.8];
      const p3 = [cx + Math.cos(rad - 2.5) * size * 0.8, cy - Math.sin(rad - 2.5) * size * 0.8];

      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(p1[0], p1[1]);
      ctx.lineTo(p2[0], p2[1]);
      ctx.lineTo(p3[0], p3[1]);
      ctx.closePath();
      ctx.fill();

      ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace";
      ctx.fillStyle = "rgba(229,231,235,0.85)";
      ctx.fillText(n.node_id, cx + 16, cy + 4);

      mapHitRef.current.push({ node_id: n.node_id, cx, cy, r: 18 });
    }

    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  }, [sorted, selectedNode]);

  function onMapClick(e) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    let hit = null;
    for (const h of mapHitRef.current) {
      const dx = mx - h.cx;
      const dy = my - h.cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= h.r) { hit = h; break; }
    }

    if (hit) {
      setSelectedNode(hit.node_id);
      setTarget(hit.node_id);
    } else {
      setSelectedNode(null);
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <div className="title">FalconMesh GCS</div>
          <div className="subtitle">Swarm Telemetry + C2 (v2 • Tactical Map)</div>
        </div>

        <div className="right">
          <div className={badgeClass(wsStatus === "CONNECTED")}>
            WS: {wsStatus}
          </div>
          <div className="meta">
            Nodes: <b>{health?.nodes ?? sorted.length}</b> • WS telem: <b>{health?.ws_telem ?? "-"}</b> • WS uav: <b>{health?.ws_uav ?? "-"}</b>
          </div>
        </div>
      </header>

      {err ? (
        <div className="error">
          <b>Error:</b> {err}
        </div>
      ) : null}

      <main className="content">
        <div className="shell">

          {/* LEFT SIDEBAR */}
          <aside className="sidebar">
            <div className="card">
              <div className="cardTitle">Menu</div>
              <div className="nav">
                <button className="navItem active">Tactical</button>
                <button className="navItem">Fleet</button>
                <button className="navItem">Missions</button>
                <button className="navItem">Comms</button>
                <button className="navItem">Security</button>
                <button className="navItem">Settings</button>
              </div>
            </div>

            <div className="card">
              <div className="cardTitle">Filters</div>
              <div className="formRow">
                <label className="label">Target</label>
                <select className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
                  {targets.map((t) => (
                    <option key={t} value={t}>
                      {t === "all" ? "all (broadcast)" : t}
                    </option>
                  ))}
                </select>
              </div>

              <div className="hint">
                Tip: Map’te UAV’a tıkla → target otomatik seçilir.
              </div>
            </div>

            <div className="card">
              <div className="cardTitle">Quick Commands</div>
              <div className="btnRow">
                <button className="btn" disabled={sending} onClick={() => sendCommand("HOLD")}>HOLD</button>
                <button className="btn" disabled={sending} onClick={() => sendCommand("FORM_UP")}>FORM_UP</button>
                <button className="btn" disabled={sending} onClick={() => sendCommand("RTB")}>RTB</button>
                <button className="btn primary" disabled={sending} onClick={() => sendCommand("RESUME")}>RESUME</button>
              </div>

              <div className="hint">
                {lastCmd ? (
                  <>
                    Last: <span className="mono">{lastCmd.command}</span> →{" "}
                    <span className="mono">{lastCmd.target}</span> (delivered:{" "}
                    <span className="mono">{lastCmd.delivered}</span>)
                  </>
                ) : (
                  <>Henüz komut yok.</>
                )}
              </div>
            </div>
          </aside>

          {/* CENTER MAP */}
          <section className="center">
            <div className="card mapCard">
              <div className="cardTitle">Tactical Map</div>
              <div className="mapHint">
                Colors: <span className="mono">NORMAL</span>=blue, <span className="mono">FORM_UP</span>=green, <span className="mono">HOLD</span>=yellow, <span className="mono">RTB</span>=red.
              </div>
              <div className="mapWrap">
                <canvas ref={canvasRef} className="mapCanvas mapCanvasFull" onClick={onMapClick} />
              </div>
              <div className="mapFooter">
                Selected: <span className="mono">{selectedNode ?? "-"}</span>
              </div>
            </div>
          </section>

          {/* RIGHT PANEL */}
          <aside className="rightPanel">
            <div className="card">
              <div className="cardTitle">Live Nodes</div>
              <div className="tableWrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>node_id</th>
                      <th>state</th>
                      <th>pos</th>
                      <th>hdg</th>
                      <th>spd</th>
                      <th>bat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((n) => (
                      <tr key={n.node_id} className={n.node_id === selectedNode ? "rowSel" : ""}>
                        <td className="mono">{n.node_id}</td>
                        <td className="stateCell">{n.state}</td>
                        <td className="mono">{n.pos?.x ?? "-"}, {n.pos?.y ?? "-"}</td>
                        <td className="mono">{n.heading_deg ?? "-"}</td>
                        <td className="mono">{n.speed_mps ?? "-"}</td>
                        <td className="mono">{n.battery_pct ?? "-"}</td>
                      </tr>
                    ))}
                    {sorted.length === 0 ? (
                      <tr><td colSpan="6" style={{ opacity: 0.7 }}>No nodes yet…</td></tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card">
              <div className="cardTitle">Event Log</div>
              <div className="logBox">
                {lastCmd ? (
                  <div className="logLine">
                    <span className="mono">{fmtTs(lastCmd.ts)}</span>{" "}
                    CMD <span className="mono">{lastCmd.command}</span>{" "}
                    → <span className="mono">{lastCmd.target}</span>{" "}
                    delivered:<span className="mono">{lastCmd.delivered}</span>
                  </div>
                ) : (
                  <div style={{ opacity: 0.7 }}>No events yet.</div>
                )}
              </div>
            </div>
          </aside>

        </div>
      </main>

      <footer className="footer">
        FalconMesh • WS: <span className="mono">/ws/telemetry</span> • Commands: <span className="mono">POST /api/command</span>
      </footer>
    </div>
  );
}
