(function () {
  const hudStatusEl = () => document.getElementById("fm-hud-status");
  const listEl = () => document.getElementById("fm-uav-list");
  const detailsEl = () => document.getElementById("fm-uav-details");

  function setHudStatus(t) {
    const el = hudStatusEl();
    if (el) el.textContent = t;
  }

  // Temporary anchor (Ankara). Next step: true base lat/lon from mission.
  let anchorLat = 39.9334;
  let anchorLon = 32.8597;

  const map = L.map("fm-map", { zoomControl: true, attributionControl: true }).setView(
    [anchorLat, anchorLon],
    16
  );

  // Esri World Imagery (satellite)
  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19 }
  ).addTo(map);

  function xyToLatLon(x, y) {
    const lat = anchorLat + y / 111320.0;
    const lon = anchorLon + x / (111320.0 * Math.cos((anchorLat * Math.PI) / 180));
    return [lat, lon];
  }

  function pointToLatLon(p) {
    if (!p || typeof p !== "object") return null;
    if (typeof p.lat === "number" && typeof p.lon === "number") return [p.lat, p.lon];
    if (typeof p.x === "number" && typeof p.y === "number") return xyToLatLon(p.x, p.y);
    return null;
  }

  const drones = new Map();
  const trails = new Map();
  const markers = new Map();
  const polylines = new Map();

  let selectedNodeId = null;

  function makeDroneIcon(headingDeg, selected) {
    const rot = (typeof headingDeg === "number" ? headingDeg : 0).toFixed(1);
    const cls = selected ? "fm-drone selected" : "fm-drone";
    return L.divIcon({
      className: "",
      html: `<div class="${cls}" style="transform: rotate(${rot}deg); transform-origin: 50% 50%;"></div>`,
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
  }

  function ensureDrone(nodeId, latlng, headingDeg) {
    if (!markers.has(nodeId)) {
      const mk = L.marker(latlng, { icon: makeDroneIcon(headingDeg, false) }).addTo(map);
      mk.on("click", () => {
        selectedNodeId = nodeId;
        renderHud();
        refreshAllIcons();
      });
      markers.set(nodeId, mk);

      const pl = L.polyline([], { weight: 2, opacity: 0.8 }).addTo(map);
      polylines.set(nodeId, pl);
    }
  }

  function refreshAllIcons() {
    for (const [nodeId, mk] of markers.entries()) {
      const d = drones.get(nodeId);
      const heading = d?.vel?.heading_deg ?? d?.heading_deg ?? 0;
      mk.setIcon(makeDroneIcon(heading, nodeId === selectedNodeId));
    }
  }

  let missionLayers = { baseCircle: null, targetCircle: null, stagingCircles: [] };

  function clearMissionOverlay() {
    if (missionLayers.baseCircle) map.removeLayer(missionLayers.baseCircle);
    if (missionLayers.targetCircle) map.removeLayer(missionLayers.targetCircle);
    for (const c of missionLayers.stagingCircles) map.removeLayer(c);
    missionLayers = { baseCircle: null, targetCircle: null, stagingCircles: [] };
  }

  function drawMissionOverlay(mission) {
    clearMissionOverlay();
    if (!mission || typeof mission !== "object") return;

    if (mission.base) {
      const ll = pointToLatLon(mission.base);
      if (ll) {
        const r = typeof mission.base.radius_m === "number" ? mission.base.radius_m : 80;
        missionLayers.baseCircle = L.circle(ll, { radius: r, weight: 2, opacity: 0.9, fillOpacity: 0.08 })
          .addTo(map)
          .bindTooltip("BASE", { permanent: true, direction: "center" });

        // if base has lat/lon, lock anchor to it
        if (typeof mission.base.lat === "number" && typeof mission.base.lon === "number") {
          anchorLat = mission.base.lat;
          anchorLon = mission.base.lon;
        }
      }
    }

    if (Array.isArray(mission.staging_points)) {
      mission.staging_points.forEach((p, idx) => {
        const ll = pointToLatLon(p);
        if (!ll) return;
        const r = typeof p.radius_m === "number" ? p.radius_m : 60;
        const c = L.circle(ll, { radius: r, weight: 2, opacity: 0.9, fillOpacity: 0.05 })
          .addTo(map)
          .bindTooltip(`S${idx + 1}`, { permanent: true, direction: "center" });
        missionLayers.stagingCircles.push(c);
      });
    }

    if (mission.target) {
      const ll = pointToLatLon(mission.target);
      if (ll) {
        const r = typeof mission.target.radius_m === "number" ? mission.target.radius_m : 50;
        missionLayers.targetCircle = L.circle(ll, { radius: r, weight: 2, opacity: 0.9, fillOpacity: 0.06 })
          .addTo(map)
          .bindTooltip("TGT", { permanent: true, direction: "center" });
      }
    }
  }

  function renderHud() {
    const l = listEl();
    if (l) {
      const ids = [...drones.keys()].sort();
      l.innerHTML = ids
        .map((id) => {
          const d = drones.get(id);
          const st = d?.state ?? "-";
          const b = d?.battery?.pct ?? d?.battery_pct ?? "-";
          const active = id === selectedNodeId ? "active" : "";
          return `<button class="${active}" data-id="${id}">${id}  •  ${st}  •  BAT ${b}</button>`;
        })
        .join("");

      for (const btn of l.querySelectorAll("button[data-id]")) {
        btn.addEventListener("click", () => {
          selectedNodeId = btn.getAttribute("data-id");
          renderHud();
          refreshAllIcons();
          const mk = markers.get(selectedNodeId);
          if (mk) map.panTo(mk.getLatLng());
        });
      }
    }

    const dEl = detailsEl();
    if (dEl) {
      const d = selectedNodeId ? drones.get(selectedNodeId) : null;
      if (!d) {
        dEl.innerHTML = `<div class="fm-small">(select a UAV)</div>`;
      } else {
        const pos = d.pos || {};
        const vel = d.vel || {};
        const nav = d.nav || {};
        const bat = d.battery || {};

        dEl.innerHTML = `
          <div class="fm-row"><span>ID</span><span class="fm-badge">${selectedNodeId}</span></div>
          <div class="fm-row"><span>STATE</span><span>${d.state ?? "-"}</span></div>
          <div class="fm-row"><span>BAT</span><span>${bat.pct ?? d.battery_pct ?? "-"}</span></div>
          <div class="fm-row"><span>ALT</span><span>${pos.alt_m ?? "-"}</span></div>
          <div class="fm-row"><span>SPD</span><span>${vel.speed_mps ?? d.speed_mps ?? "-"}</span></div>
          <div class="fm-row"><span>HDG</span><span>${vel.heading_deg ?? d.heading_deg ?? "-"}</span></div>
          <div class="fm-row"><span>GOAL</span><span>${nav.active_goal ?? "-"}</span></div>
          <div class="fm-row"><span>D2BASE</span><span>${nav.dist_to_base_m ?? "-"}</span></div>
        `;
      }
    }
  }

  function wsUrl(path) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}${path}`;
  }

  function connectWs() {
    setHudStatus("WS CONNECTING");
    let ws;
    try {
      ws = new WebSocket(wsUrl("/ws/telemetry"));
    } catch (e) {
      setHudStatus("WS INIT ERROR");
      return;
    }

    ws.onopen = () => setHudStatus("WS OK");
    ws.onerror = () => setHudStatus("WS ERROR");
    ws.onclose = () => {
      setHudStatus("WS CLOSED • RETRY");
      setTimeout(connectWs, 1500);
    };

    ws.onmessage = (ev) => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }

      if (msg && msg.type === "snapshot" && Array.isArray(msg.nodes)) {
        msg.nodes.forEach((n) => applyTelemetry(n));
        renderHud();
        refreshAllIcons();
        return;
      }

      if (msg && msg.type === "mission_update" && msg.mission) {
        drawMissionOverlay(msg.mission);
        return;
      }

      if (msg && msg.node_id) {
        applyTelemetry(msg);
        renderHud();
        refreshAllIcons();
      }
    };
  }

  function applyTelemetry(t) {
    if (!t || !t.node_id) return;
    drones.set(t.node_id, t);

    let latlng = null;
    if (t.pos && typeof t.pos.lat === "number" && typeof t.pos.lon === "number") {
      latlng = [t.pos.lat, t.pos.lon];
    } else if (t.pos && typeof t.pos.x === "number" && typeof t.pos.y === "number") {
      latlng = xyToLatLon(t.pos.x, t.pos.y);
    } else if (typeof t.x === "number" && typeof t.y === "number") {
      latlng = xyToLatLon(t.x, t.y);
    }
    if (!latlng) return;

    const heading = t?.vel?.heading_deg ?? t?.heading_deg ?? 0;
    ensureDrone(t.node_id, latlng, heading);

    const mk = markers.get(t.node_id);
    if (mk) mk.setLatLng(latlng);

    const buf = trails.get(t.node_id) || [];
    buf.push({ lat: latlng[0], lon: latlng[1] });
    while (buf.length > 200) buf.shift();
    trails.set(t.node_id, buf);

    const pl = polylines.get(t.node_id);
    if (pl) pl.setLatLngs(buf.map((p) => [p.lat, p.lon]));

    if (!selectedNodeId) selectedNodeId = t.node_id;
  }

  async function fetchMissionOnce() {
    try {
      const r = await fetch("/api/mission", { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      if (j && j.mission) drawMissionOverlay(j.mission);
    } catch (_) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      fetchMissionOnce();
      connectWs();
      renderHud();
    });
  } else {
    fetchMissionOnce();
    connectWs();
    renderHud();
  }
})();
