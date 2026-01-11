(function () {
  // ---------- DOM helpers ----------
  const outEl = () => document.getElementById("fm-mission-json");
  const statusEl = () => document.getElementById("fm-mission-status");

  function setStatus(text) {
    const el = statusEl();
    if (el) el.textContent = text;
  }

  // ISO timestamp'i UI için güzelleştir:
  // "2026-01-10T14:51:56Z" -> "2026-01-10 14:51:56"
  function fmtIso(ts) {
    if (!ts || typeof ts !== "string") return "-";
    return ts.replace("T", " ").replace("Z", "");
  }

  function renderMission(missionObj) {
    const el = outEl();
    if (!el) return;

    // JSON'da timestamp alanlarını formatlı göster
    const mDisp = (() => {
      try {
        return {
          ...missionObj,
          created_ts: fmtIso(missionObj?.created_ts),
          updated_ts: fmtIso(missionObj?.updated_ts),
        };
      } catch (_) {
        return missionObj;
      }
    })();

    try {
      el.textContent = JSON.stringify(mDisp, null, 2);
    } catch (e) {
      el.textContent = String(mDisp);
    }

    // küçük özet
    try {
      const id = missionObj?.id ?? "-";
      const n = Array.isArray(missionObj?.waypoints) ? missionObj.waypoints.length : 0;

      // updated: mission.updated_ts'den saat çek (yoksa "-")
      const upd = fmtIso(missionObj?.updated_ts);
      const updTime = upd !== "-" && upd.includes(" ") ? upd.split(" ")[1] : "-";

      setStatus(`id=${id} • wp=${n} • updated=${updTime}`);
    } catch (_) {}
  }

  // ---------- REST: initial snapshot ----------
  async function fetchInitial() {
    try {
      const r = await fetch("/api/mission", { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      if (j && j.mission) renderMission(j.mission);
      else setStatus("no mission");
    } catch (e) {
      setStatus("REST error");
    }
  }

  // ---------- WS: live updates (from /ws/telemetry) ----------
  function wsUrl(path) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}${path}`;
  }

  function connectWs() {
    let ws;
    try {
      ws = new WebSocket(wsUrl("/ws/telemetry"));
    } catch (e) {
      setStatus("WS init error");
      return;
    }

    ws.onopen = () => setStatus("WS connected");
    ws.onerror = () => setStatus("WS error");
    ws.onclose = () => {
      setStatus("WS closed • retrying...");
      setTimeout(connectWs, 1500);
    };

    ws.onmessage = (ev) => {
      // control-api WS_TELEM artık send_text(JSON) gönderiyor (payload string)
      let msg = null;
      try {
        msg = JSON.parse(ev.data);
      } catch (_) {
        // bazı durumlarda telemetry payload direkt gelebilir (dict string)
        return;
      }

      // Mission update broadcast
      if (msg && msg.type === "mission_update" && msg.mission) {
        renderMission(msg.mission);
        return;
      }
    };
  }

  // ---------- boot ----------
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      fetchInitial();
      connectWs();
    });
  } else {
    fetchInitial();
    connectWs();
  }
})();
