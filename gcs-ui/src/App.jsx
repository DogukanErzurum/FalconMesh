import { useEffect, useMemo, useState } from "react";
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

  async function fetchAll() {
    try {
      setErr("");
      const h = await fetch("/health");
      const hjson = await h.json();
      setHealth(hjson);

      const r = await fetch("/api/nodes");
      const j = await r.json();
      setNodes(j.nodes || []);
    } catch (e) {
      setErr(String(e));
    }
  }

  useEffect(() => {
    fetchAll();
    const t = setInterval(fetchAll, 1000);
    return () => clearInterval(t);
  }, []);

  const sorted = useMemo(() => {
    return [...nodes].sort((a, b) => (a.node_id || "").localeCompare(b.node_id || ""));
  }, [nodes]);

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <div className="title">FalconMesh GCS</div>
          <div className="subtitle">Swarm Telemetry Dashboard (v1)</div>
        </div>

        <div className="right">
          <div className={badgeClass(!!health && health.ok)}>
            {health?.ok ? "CONTROL API: OK" : "CONTROL API: OFFLINE"}
          </div>
          <div className="meta">
            Nodes: <b>{health?.nodes ?? 0}</b> • WS: <b>{health?.ws_clients ?? 0}</b>
          </div>
        </div>
      </header>

      {err ? (
        <div className="error">
          <b>UI Error:</b> {err}
        </div>
      ) : null}

      <main className="content">
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
                    <td>{n.state}</td>
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
                      No nodes yet. Waiting for ingest…
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </main>

      <footer className="footer">
        FalconMesh • Control plane: <span className="mono">/health</span> • Nodes:{" "}
        <span className="mono">/api/nodes</span>
      </footer>
    </div>
  );
}
