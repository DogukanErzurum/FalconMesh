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

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <div className="title">FalconMesh GCS</div>
          <div className="subtitle">Swarm Telemetry Dashboard (v1 • WS)</div>
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
        <div className="grid">
          <div className="card">
            <div className="cardTitle">Command Panel</div>

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

            <div className="btnRow">
              <button className="btn" disabled={sending} onClick={() => sendCommand("HOLD")}>
                HOLD
              </button>
              <button className="btn" disabled={sending} onClick={() => sendCommand("FORM_UP")}>
                FORM_UP
              </button>
              <button className="btn" disabled={sending} onClick={() => sendCommand("RTB")}>
                RTB
              </button>
              <button className="btn primary" disabled={sending} onClick={() => sendCommand("RESUME")}>
                RESUME
              </button>
            </div>

            <div className="hint">
              {lastCmd ? (
                <>
                  Last command: <span className="mono">{lastCmd.command}</span> →{" "}
                  <span className="mono">{lastCmd.target}</span> (delivered:{" "}
                  <span className="mono">{lastCmd.delivered}</span>) @{" "}
                  <span className="mono">{fmtTs(lastCmd.ts)}</span>
                </>
              ) : (
                <>Tip: Select a UAV and send HOLD/RTB/FORM_UP/RESUME. State should update live.</>
              )}
            </div>
          </div>

          <div className="card">
            <div className="cardTitle">Live Nodes</div>
            <div className="tableWrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>node_id</th>
                    <th>role</th>
                    <th>state</th>
                    <th>pos (x,y)</th>
                    <th>heading</th>
                    <th>speed</th>
                    <th>battery</th>
                    <th>ts</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((n) => (
                    <tr key={n.node_id}>
                      <td className="mono">{n.node_id}</td>
                      <td>{n.role}</td>
                      <td className="stateCell">{n.state}</td>
                      <td className="mono">
                        {n.pos?.x ?? "-"}, {n.pos?.y ?? "-"}
                      </td>
                      <td className="mono">{n.heading_deg ?? "-"}</td>
                      <td className="mono">{n.speed_mps ?? "-"}</td>
                      <td className="mono">{n.battery_pct ?? "-"}</td>
                      <td className="mono">{fmtTs(n.ts)}</td>
                    </tr>
                  ))}
                  {sorted.length === 0 ? (
                    <tr>
                      <td colSpan="8" style={{ opacity: 0.7 }}>
                        No nodes yet. Waiting for WS snapshot/telemetry…
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </main>

      <footer className="footer">
        FalconMesh • WS: <span className="mono">/ws/telemetry</span> • Commands:{" "}
        <span className="mono">POST /api/command</span>
      </footer>
    </div>
  );
}
