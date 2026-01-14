import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Circle,
  useMapEvents,
  useMap,
} from "react-leaflet";

// --- helpers ---
function fmtTs(ts) {
  if (!ts) return "-";
  return ts.replace("T", " ").replace("Z", " UTC");
}
function badgeClass(ok) {
  return ok ? "badge ok" : "badge bad";
}
function isNum(v) {
  return typeof v === "number" && !Number.isNaN(v);
}
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

// --- Map click helper ---
function ClickCapture({ onClick }) {
  useMapEvents({
    click(e) {
      onClick?.(e.latlng);
    },
  });
  return null;
}

// --- Fix Leaflet sizing in grid/flex layouts ---
function MapAutoSize() {
  const map = useMap();

  useEffect(() => {
    const apply = () => {
      try {
        map.invalidateSize();
      } catch {}
    };

    const t1 = setTimeout(apply, 0);
    const t2 = setTimeout(apply, 200);
    const t3 = setTimeout(apply, 800);

    const ro = new ResizeObserver(() => apply());
    ro.observe(map.getContainer());

    window.addEventListener("resize", apply);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      ro.disconnect();
      window.removeEventListener("resize", apply);
    };
  }, [map]);

  return null;
}

export default function App() {
  const [nodes, setNodes] = useState([]);
  const [health, setHealth] = useState(null);
  const [err, setErr] = useState("");
  const [wsStatus, setWsStatus] = useState("DISCONNECTED");

  const [target, setTarget] = useState("all");
  const [sending, setSending] = useState(false);

  const [selectedNode, setSelectedNode] = useState(null);

  const [mission, setMission] = useState(null);
  const [events, setEvents] = useState([]);

  const byIdRef = useRef(new Map()); // node_id -> last state

  async function refreshHealth() {
    try {
      const h = await fetch("/health");
      setHealth(await h.json());
    } catch {
      // ignore
    }
  }

  function pushEvent(line) {
    setEvents((prev) => {
      const now = new Date()
        .toISOString()
        .replace(".000", "")
        .replace("T", " ")
        .replace("Z", " UTC");
      const next = [{ ts: now, line }, ...prev];
      return next.slice(0, 50);
    });
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
      pushEvent(`CMD ${command} → ${target} (delivered: ${j.delivered})`);
      refreshHealth();
    } catch (e) {
      setErr("Command error: " + String(e));
    } finally {
      setSending(false);
    }
  }

  async function postMissionPatch(patch) {
    const res = await fetch("/api/mission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const j = await res.json();
    if (!res.ok || !j.ok)
      throw new Error(j.error || j.err || "mission update failed");
    return j.mission;
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
      pushEvent("WS CONNECTED");
    };
    ws.onclose = () => {
      setWsStatus("DISCONNECTED");
      pushEvent("WS DISCONNECTED");
    };
    ws.onerror = () => {
      setWsStatus("ERROR");
      pushEvent("WS ERROR");
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);

        if (msg && msg.type === "snapshot") {
          setSnapshot(msg.nodes || []);
          return;
        }

        if (msg && msg.type === "mission_update") {
          setMission(msg.mission || null);
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
      try {
        ws.close();
      } catch {}
    };
  }, []);

  const sorted = useMemo(() => {
    return [...nodes].sort((a, b) =>
      (a.node_id || "").localeCompare(b.node_id || "")
    );
  }, [nodes]);

  const targets = useMemo(
    () => ["all", ...sorted.map((n) => n.node_id)],
    [sorted]
  );

  // --- Mission view helpers (prefer v2) ---
  const baseLL = mission?.base_ll || null;
  const targetLL = mission?.target_ll || null;
  const stagingLL = Array.isArray(mission?.staging) ? mission.staging : [];
  const batteryV2 = mission?.battery || null;

  // Default map center: base_ll -> first node lat/lon -> Ankara fallback
  const mapCenter = useMemo(() => {
    if (baseLL && isNum(baseLL.lat) && isNum(baseLL.lon))
      return [baseLL.lat, baseLL.lon];

    for (const n of sorted) {
      const lat = n?.pos?.lat;
      const lon = n?.pos?.lon;
      if (isNum(lat) && isNum(lon)) return [lat, lon];
    }

    return [39.9334, 32.8597]; // Ankara
  }, [baseLL, sorted]);

  async function onMapClickSetTarget(latlng) {
    try {
      const lat = latlng.lat;
      const lon = latlng.lng;

      const patch = {
        target: {
          lat,
          lon,
          alt_m: targetLL && isNum(targetLL.alt_m) ? targetLL.alt_m : 120,
          radius_m:
            targetLL && isNum(targetLL.radius_m) ? targetLL.radius_m : 120,
          task: targetLL && typeof targetLL.task === "string"
            ? targetLL.task
            : "RECON",
        },
      };

      const newMission = await postMissionPatch(patch);
      setMission(newMission);
      pushEvent(
        `TARGET set → lat=${lat.toFixed(6)} lon=${lon.toFixed(6)}`
      );
    } catch (e) {
      setErr("Mission error: " + String(e));
    }
  }

  function selectNode(id) {
    setSelectedNode(id);
    setTarget(id);
  }

  function stateColor(state) {
    const s = String(state || "UNKNOWN");
    if (s === "HOLD" || s === "HOLDING") return "stateHold";
    if (s === "RTB" || s === "ENROUTE_BASE") return "stateRTB";
    if (s === "FORM_UP") return "stateForm";
    if (s === "NORMAL") return "stateNormal";
    return "stateUnknown";
  }

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <div className="title">FalconMesh GCS</div>
          <div className="subtitle">
            Swarm Telemetry + C2 (v3 • World Map + Mission)
          </div>
        </div>

        <div className="right">
          <div className={badgeClass(wsStatus === "CONNECTED")}>
            WS: {wsStatus}
          </div>
          <div className="meta">
            Nodes: <b>{health?.nodes ?? sorted.length}</b> • WS telem:{" "}
            <b>{health?.ws_telem ?? "-"}</b> • WS uav:{" "}
            <b>{health?.ws_uav ?? "-"}</b>
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
                <label className="label">Command Target</label>
                <select
                  className="select"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  {targets.map((t) => (
                    <option key={t} value={t}>
                      {t === "all" ? "all (broadcast)" : t}
                    </option>
                  ))}
                </select>
              </div>

              <div className="hint">
                Tip: UAV marker’a tıkla → sağ panelde seçilir, komut hedefi
                otomatik olur.
              </div>
            </div>

            <div className="card">
              <div className="cardTitle">Quick Commands</div>
              <div className="btnRow">
                <button
                  className="btn"
                  disabled={sending}
                  onClick={() => sendCommand("HOLD")}
                >
                  HOLD
                </button>
                <button
                  className="btn"
                  disabled={sending}
                  onClick={() => sendCommand("FORM_UP")}
                >
                  FORM_UP
                </button>
                <button
                  className="btn"
                  disabled={sending}
                  onClick={() => sendCommand("RTB")}
                >
                  RTB
                </button>
                <button
                  className="btn primary"
                  disabled={sending}
                  onClick={() => sendCommand("RESUME")}
                >
                  RESUME
                </button>
              </div>

              <div className="hint">
                States: <span className="mono">NORMAL</span>,{" "}
                <span className="mono">HOLDING</span>,{" "}
                <span className="mono">ENROUTE_TARGET</span>,{" "}
                <span className="mono">ENROUTE_BASE</span>,{" "}
                <span className="mono">CHARGING</span>
              </div>
            </div>

            <div className="card">
              <div className="cardTitle">Mission (v2 lat/lon)</div>

              <div className="kv">
                <div className="k">Mission</div>
                <div className="v mono">{mission?.id ?? "-"}</div>
              </div>

              <div className="kv">
                <div className="k">Updated</div>
                <div className="v mono">{fmtTs(mission?.updated_ts)}</div>
              </div>

              <div className="sep" />

              <div className="kv">
                <div className="k">Base</div>
                <div className="v mono">
                  {baseLL
                    ? `${baseLL.lat}, ${baseLL.lon} r=${
                        baseLL.radius_m ?? "-"
                      }m`
                    : "-"}
                </div>
              </div>

              <div className="kv">
                <div className="k">Target</div>
                <div className="v mono">
                  {targetLL
                    ? `${targetLL.lat}, ${targetLL.lon} r=${
                        targetLL.radius_m ?? "-"
                      }m ${targetLL.task ?? ""}`
                    : "-"}
                </div>
              </div>

              <div className="kv">
                <div className="k">Battery</div>
                <div className="v mono">
                  {batteryV2
                    ? `RTB<${batteryV2.rtb_threshold_pct}%  CHG>${batteryV2.charge_to_pct}%`
                    : "-"}
                </div>
              </div>

              <div className="kv">
                <div className="k">Staging</div>
                <div className="v mono">{stagingLL.length}</div>
              </div>

              <div className="hint">
                Map’e tıkla → <b>Target Set</b> (POST /api/mission). Mission
                update WS ile anlık gelir.
              </div>
            </div>
          </aside>

          {/* CENTER MAP */}
          <section className="center">
            <div className="card mapCard">
              <div className="cardTitle">World Map</div>
              <div className="mapHint">
                Sol tık: <span className="mono">Target Set</span> • Marker tık:
                popup • Base/Target circle: mission radius
              </div>

              <div className="mapWrap leafletWrap">
                <MapContainer
                  center={mapCenter}
                  zoom={14}
                  minZoom={2}
                  maxZoom={19}
                  scrollWheelZoom={true}
                  worldCopyJump={true} // C: dünya tekrar eder, gri alan olmaz
                  style={{ height: "100%", width: "100%" }}
                >
                  <MapAutoSize />

                  {/* ✅ Street map + place names (OSM) */}
                  <TileLayer
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                    attribution="© OpenStreetMap contributors"
                    maxZoom={19}
                    keepBuffer={6}
                    updateWhenIdle={true}
                    updateWhenZooming={false}
                  />

                  <ClickCapture onClick={onMapClickSetTarget} />

                  {/* Mission base */}
                  {baseLL && isNum(baseLL.lat) && isNum(baseLL.lon) ? (
                    <>
                      <Circle
                        center={[baseLL.lat, baseLL.lon]}
                        radius={clamp(Number(baseLL.radius_m ?? 200), 10, 5000)}
                      />
                      <Marker position={[baseLL.lat, baseLL.lon]}>
                        <Popup>
                          <b>BASE</b>
                          <div className="mono">
                            {baseLL.lat}, {baseLL.lon}
                          </div>
                        </Popup>
                      </Marker>
                    </>
                  ) : null}

                  {/* Staging */}
                  {stagingLL.map((s, idx) => {
                    if (!isNum(s.lat) || !isNum(s.lon)) return null;
                    return (
                      <Circle
                        key={`stg-${idx}`}
                        center={[s.lat, s.lon]}
                        radius={clamp(Number(s.radius_m ?? 80), 10, 5000)}
                      />
                    );
                  })}

                  {/* Target */}
                  {targetLL && isNum(targetLL.lat) && isNum(targetLL.lon) ? (
                    <>
                      <Circle
                        center={[targetLL.lat, targetLL.lon]}
                        radius={clamp(
                          Number(targetLL.radius_m ?? 120),
                          10,
                          8000
                        )}
                      />
                      <Marker position={[targetLL.lat, targetLL.lon]}>
                        <Popup>
                          <b>TARGET</b>{" "}
                          <span className="mono">{targetLL.task ?? ""}</span>
                          <div className="mono">
                            {targetLL.lat}, {targetLL.lon}
                          </div>
                        </Popup>
                      </Marker>
                    </>
                  ) : null}

                  {/* UAV markers */}
                  {sorted.map((n) => {
                    const lat = n?.pos?.lat;
                    const lon = n?.pos?.lon;
                    if (!isNum(lat) || !isNum(lon)) return null;
                    const cls = stateColor(n.state);

                    return (
                      <Marker
                        key={n.node_id}
                        position={[lat, lon]}
                        eventHandlers={{ click: () => selectNode(n.node_id) }}
                      >
                        <Popup>
                          <b className={cls}>{n.node_id}</b>
                          <div className="mono">state: {n.state ?? "-"}</div>
                          <div className="mono">
                            lat/lon: {lat}, {lon}
                          </div>
                          <div className="mono">hdg: {n.heading_deg ?? "-"}</div>
                          <div className="mono">spd: {n.speed_mps ?? "-"}</div>
                          <div className="mono">
                            bat: {n.battery?.pct ?? n.battery_pct ?? "-"}
                          </div>
                        </Popup>
                      </Marker>
                    );
                  })}
                </MapContainer>
              </div>

              <div className="mapFooter">
                Selected UAV: <span className="mono">{selectedNode ?? "-"}</span>
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
                    {sorted.map((n) => {
                      const pos = n.pos || {};
                      const posStr =
                        isNum(pos.lat) && isNum(pos.lon)
                          ? `${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}`
                          : `${pos.x ?? "-"}, ${pos.y ?? "-"}`;

                      const bat = n.battery?.pct ?? n.battery_pct ?? "-";
                      return (
                        <tr
                          key={n.node_id}
                          className={n.node_id === selectedNode ? "rowSel" : ""}
                          onClick={() => selectNode(n.node_id)}
                          style={{ cursor: "pointer" }}
                        >
                          <td className="mono">{n.node_id}</td>
                          <td className="stateCell">{n.state}</td>
                          <td className="mono">{posStr}</td>
                          <td className="mono">{n.heading_deg ?? "-"}</td>
                          <td className="mono">{n.speed_mps ?? "-"}</td>
                          <td className="mono">{bat}</td>
                        </tr>
                      );
                    })}
                    {sorted.length === 0 ? (
                      <tr>
                        <td colSpan="6" style={{ opacity: 0.7 }}>
                          No nodes yet…
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>

              <div className="hint">
                Not: UAV marker’larının haritada görünmesi için telemetry{" "}
                <span className="mono">pos.lat/lon</span> vermeli.
              </div>
            </div>

            <div className="card">
              <div className="cardTitle">Event Log</div>
              <div className="logBox">
                {events.length ? (
                  events.map((e, i) => (
                    <div key={i} className="logLine">
                      <span className="mono">{e.ts}</span> {e.line}
                    </div>
                  ))
                ) : (
                  <div style={{ opacity: 0.7 }}>No events yet.</div>
                )}
              </div>
            </div>
          </aside>
        </div>
      </main>

      <footer className="footer">
        FalconMesh • WS: <span className="mono">/ws/telemetry</span> • Commands:{" "}
        <span className="mono">POST /api/command</span> • Mission:{" "}
        <span className="mono">POST /api/mission</span>
      </footer>
    </div>
  );
}
