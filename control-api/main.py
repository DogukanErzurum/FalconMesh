from __future__ import annotations

import json
from pathlib import Path
from datetime import datetime, timezone
from typing import Dict, Any, Set, Optional, List

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Body
from fastapi.responses import JSONResponse

app = FastAPI(title="FalconMesh Control API")


def utc_iso() -> str:
    # UI'da temiz görünmesi için microsecond kırp
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


# --- stores ---
LAST: Dict[str, Dict[str, Any]] = {}  # node_id -> last telemetry payload

WS_TELEM: Set[WebSocket] = set()
WS_UAV: Set[WebSocket] = set()
UAV_WS_NODE: Dict[WebSocket, str] = {}

# --- Mission v1.2 schema ---
# Coordinate system (MVP):
#  - x,y are generic planar coords for now (later: lat/lon)
#  - alt_m, speed_mps retained for waypoint flight
#  - base/target/staging are points with radius_m
MISSION: Dict[str, Any] = {
    "id": None,
    "created_ts": None,
    "updated_ts": None,

    # mission pathing
    "waypoints": [],  # list of {x,y,alt_m,speed_mps}

    # v1.2 additions (mil-sim)
    "base": None,  # {x,y,radius_m}
    "staging_points": [],  # list[{x,y,radius_m,hold_s?}]
    "target": None,  # {x,y,radius_m}

    # battery policy (sim/autopilot)
    "battery_policy": {
        "rtb_below_pct": 20,     # battery % threshold to trigger RTB
        "resume_above_pct": 90,  # battery % threshold to resume mission
    },
}

# --- mission persistence ---
MISSION_PATH = Path("/data/mission.json")


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _validate_waypoints(waypoints: Any) -> Optional[str]:
    """
    waypoints: list[ {x,y,alt_m,speed_mps} ]
    MVP doğrulama: tipler sayı olmalı ve alanlar eksiksiz olmalı
    """
    if not isinstance(waypoints, list):
        return "waypoints must be a list"

    for i, wp in enumerate(waypoints):
        if not isinstance(wp, dict):
            return f"waypoints[{i}] must be an object"
        for k in ("x", "y", "alt_m", "speed_mps"):
            if k not in wp:
                return f"waypoints[{i}].{k} missing"
            if not _is_number(wp[k]):
                return f"waypoints[{i}].{k} must be number"
    return None


def _validate_point(obj: Any, name: str, require_radius: bool = True) -> Optional[str]:
    """
    point schema: {x,y,radius_m?}
    """
    if obj is None:
        return None
    if not isinstance(obj, dict):
        return f"{name} must be an object or null"
    for k in ("x", "y"):
        if k not in obj:
            return f"{name}.{k} missing"
        if not _is_number(obj[k]):
            return f"{name}.{k} must be number"
    if require_radius:
        if "radius_m" not in obj:
            return f"{name}.radius_m missing"
        if not _is_number(obj["radius_m"]):
            return f"{name}.radius_m must be number"
    return None


def _validate_staging_points(obj: Any) -> Optional[str]:
    """
    staging_points: list[{x,y,radius_m,hold_s?}]
    """
    if obj is None:
        return None
    if not isinstance(obj, list):
        return "staging_points must be a list"
    for i, p in enumerate(obj):
        if not isinstance(p, dict):
            return f"staging_points[{i}] must be an object"
        for k in ("x", "y", "radius_m"):
            if k not in p:
                return f"staging_points[{i}].{k} missing"
            if not _is_number(p[k]):
                return f"staging_points[{i}].{k} must be number"
        if "hold_s" in p and p["hold_s"] is not None and not _is_number(p["hold_s"]):
            return f"staging_points[{i}].hold_s must be number"
    return None


def _validate_battery_policy(obj: Any) -> Optional[str]:
    """
    battery_policy: {rtb_below_pct, resume_above_pct}
    """
    if obj is None:
        return None
    if not isinstance(obj, dict):
        return "battery_policy must be an object"
    for k in ("rtb_below_pct", "resume_above_pct"):
        if k not in obj:
            return f"battery_policy.{k} missing"
        if not _is_number(obj[k]):
            return f"battery_policy.{k} must be number"
    # basic sanity
    rtb = float(obj["rtb_below_pct"])
    res = float(obj["resume_above_pct"])
    if rtb < 0 or rtb > 100 or res < 0 or res > 100:
        return "battery_policy values must be in [0,100]"
    if rtb >= res:
        return "battery_policy.rtb_below_pct must be < resume_above_pct"
    return None


def load_mission_from_disk() -> None:
    def norm(ts: Any) -> Any:
        if not isinstance(ts, str) or not ts.endswith("Z"):
            return ts
        # "2026-01-10T14:51:56.236713Z" -> "2026-01-10T14:51:56Z"
        if "." in ts:
            return ts.split(".", 1)[0] + "Z"
        return ts

    try:
        if MISSION_PATH.exists():
            data = json.loads(MISSION_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                # core
                MISSION["id"] = data.get("id")
                MISSION["created_ts"] = norm(data.get("created_ts"))
                MISSION["updated_ts"] = norm(data.get("updated_ts"))

                wps = data.get("waypoints", [])
                MISSION["waypoints"] = wps if isinstance(wps, list) else []

                # v1.2 fields (may be missing)
                MISSION["base"] = data.get("base")
                sp = data.get("staging_points", [])
                MISSION["staging_points"] = sp if isinstance(sp, list) else []
                MISSION["target"] = data.get("target")

                bp = data.get("battery_policy")
                if isinstance(bp, dict):
                    # merge into defaults
                    MISSION["battery_policy"]["rtb_below_pct"] = bp.get("rtb_below_pct", MISSION["battery_policy"]["rtb_below_pct"])
                    MISSION["battery_policy"]["resume_above_pct"] = bp.get("resume_above_pct", MISSION["battery_policy"]["resume_above_pct"])

                changed = False

                # migration: eski mission.json'da updated_ts yoksa doldur
                if MISSION.get("id") and not MISSION.get("updated_ts"):
                    MISSION["updated_ts"] = MISSION.get("created_ts") or utc_iso()
                    changed = True

                # migration: staging_points missing -> []
                if "staging_points" not in data:
                    MISSION["staging_points"] = []
                    changed = True

                # migration: battery_policy missing -> defaults already set
                if "battery_policy" not in data:
                    changed = True

                # Validate loaded mission lightly; if invalid, keep but don't crash
                # (MVP approach)

                if changed:
                    save_mission_to_disk()
    except Exception as e:
        # MVP ama en azından log'a düşsün
        print(f"[load_mission_from_disk] error: {e}")


def save_mission_to_disk() -> None:
    try:
        MISSION_PATH.parent.mkdir(parents=True, exist_ok=True)
        MISSION_PATH.write_text(
            json.dumps(MISSION, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception:
        # sessiz geç (MVP)
        pass


# --- helpers ---
async def ws_broadcast_json(clients: Set[WebSocket], msg: dict) -> None:
    """Best-effort broadcast. Removes dead sockets."""
    dead = []
    for ws in list(clients):
        try:
            await ws.send_json(msg)
        except Exception:
            dead.append(ws)
    for ws in dead:
        clients.discard(ws)


@app.on_event("startup")
async def _startup():
    load_mission_from_disk()


# --- HTTP endpoints ---
@app.get("/health")
def health():
    return {
        "ok": True,
        "ts": utc_iso(),
        "nodes": len(LAST),
        "ws_telem": len(WS_TELEM),
        "ws_uav": len(WS_UAV),
    }


@app.get("/api/nodes")
def nodes():
    return {"ts": utc_iso(), "nodes": list(LAST.values())}


@app.get("/api/mission")
def get_mission():
    return {"ts": utc_iso(), "mission": MISSION}


@app.post("/api/mission")
async def set_mission(body: dict = Body(...)):
    """
    Mission v1.2 Accepts:
      {
        "id"?: str,
        "waypoints"?: [{x,y,alt_m,speed_mps}],
        "base"?: {x,y,radius_m},
        "staging_points"?: [{x,y,radius_m,hold_s?}],
        "target"?: {x,y,radius_m},
        "battery_policy"?: {rtb_below_pct, resume_above_pct}
      }
    """
    # waypoints optional now (if omitted keep existing)
    if "waypoints" in body:
        waypoints = body.get("waypoints", [])
        err = _validate_waypoints(waypoints)
        if err:
            return JSONResponse(status_code=400, content={"ok": False, "error": err})
    else:
        waypoints = MISSION.get("waypoints", [])

    mid = body.get("id")
    if mid is not None and not isinstance(mid, str):
        return JSONResponse(status_code=400, content={"ok": False, "error": "id must be string or null"})

    # v1.2 validate extras if provided
    base = body.get("base", MISSION.get("base"))
    target = body.get("target", MISSION.get("target"))
    staging_points = body.get("staging_points", MISSION.get("staging_points", []))
    battery_policy = body.get("battery_policy", MISSION.get("battery_policy"))

    err = _validate_point(base, "base")
    if err:
        return JSONResponse(status_code=400, content={"ok": False, "error": err})
    err = _validate_point(target, "target")
    if err:
        return JSONResponse(status_code=400, content={"ok": False, "error": err})
    err = _validate_staging_points(staging_points)
    if err:
        return JSONResponse(status_code=400, content={"ok": False, "error": err})
    err = _validate_battery_policy(battery_policy)
    if err:
        return JSONResponse(status_code=400, content={"ok": False, "error": err})

    now = utc_iso()

    # id yoksa üret (timestamp ile)
    if not mid:
        mid = MISSION.get("id") or f"mission-{now}"

    # created_ts sadece ilk defa set edilir (mevcut mission varsa korunur)
    if MISSION["created_ts"] is None or MISSION["id"] is None:
        MISSION["created_ts"] = now

    MISSION["id"] = mid
    MISSION["updated_ts"] = now

    # apply fields
    MISSION["waypoints"] = waypoints
    MISSION["base"] = base
    MISSION["target"] = target
    MISSION["staging_points"] = staging_points

    # merge battery policy into defaults
    if isinstance(battery_policy, dict):
        MISSION["battery_policy"]["rtb_below_pct"] = float(battery_policy["rtb_below_pct"])
        MISSION["battery_policy"]["resume_above_pct"] = float(battery_policy["resume_above_pct"])

    save_mission_to_disk()

    await ws_broadcast_json(
        WS_TELEM,
        {"type": "mission_update", "ts": now, "mission": MISSION},
    )

    return {"ok": True, "ts": now, "mission": MISSION}


@app.delete("/api/mission")
async def clear_mission():
    now = utc_iso()
    MISSION["id"] = None
    MISSION["created_ts"] = None
    MISSION["updated_ts"] = now  # reset zamanı görünsün

    MISSION["waypoints"] = []
    MISSION["base"] = None
    MISSION["staging_points"] = []
    MISSION["target"] = None
    # battery policy defaults stay (do not wipe)

    save_mission_to_disk()

    await ws_broadcast_json(
        WS_TELEM,
        {"type": "mission_update", "ts": now, "mission": MISSION},
    )

    return {"ok": True, "ts": now, "mission": MISSION}


@app.post("/ingest")
async def ingest(payload: Dict[str, Any]):
    node_id = payload.get("node_id")
    if not node_id:
        return JSONResponse({"ok": False, "err": "missing node_id"}, status_code=400)

    LAST[node_id] = payload

    # broadcast telemetry to GCS subscribers
    dead = []
    for ws in list(WS_TELEM):
        try:
            await ws.send_json(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        WS_TELEM.discard(ws)

    return {"ok": True, "ts": utc_iso()}


@app.post("/api/command")
async def command(cmd: Dict[str, Any]):
    """
    Command schema:
      {
        "target": "uav-1" | "all",
        "command": "HOLD" | "RTB" | "FORM_UP" | "RESUME",
        "params": {... optional ...}
      }
    """
    target = cmd.get("target")
    command = cmd.get("command")
    params = cmd.get("params", {})

    if target not in ("all",) and not (isinstance(target, str) and target.startswith("uav-")):
        return JSONResponse({"ok": False, "err": "invalid target"}, status_code=400)
    if command not in ("HOLD", "RTB", "FORM_UP", "RESUME"):
        return JSONResponse({"ok": False, "err": "invalid command"}, status_code=400)

    msg = {"type": "command", "ts": utc_iso(), "target": target, "command": command, "params": params}

    dead = []
    delivered = 0
    for ws in list(WS_UAV):
        try:
            node = UAV_WS_NODE.get(ws)
            if target == "all" or node == target:
                await ws.send_json(msg)
                delivered += 1
        except Exception:
            dead.append(ws)

    for ws in dead:
        WS_UAV.discard(ws)
        UAV_WS_NODE.pop(ws, None)

    return {"ok": True, "ts": utc_iso(), "delivered": delivered}


# --- WebSocket endpoints ---
@app.websocket("/ws/telemetry")
async def ws_telemetry(ws: WebSocket):
    await ws.accept()
    WS_TELEM.add(ws)

    # snapshot on connect
    try:
        await ws.send_json({"type": "snapshot", "ts": utc_iso(), "nodes": list(LAST.values())})
        await ws.send_json({"type": "mission_update", "ts": utc_iso(), "mission": MISSION})
    except Exception:
        WS_TELEM.discard(ws)
        return

    try:
        while True:
            _ = await ws.receive_text()
    except WebSocketDisconnect:
        WS_TELEM.discard(ws)
    except Exception:
        WS_TELEM.discard(ws)


@app.websocket("/ws/uav")
async def ws_uav(ws: WebSocket, node_id: Optional[str] = None):
    """
    UAV connects here with query: /ws/uav?node_id=uav-1
    """
    await ws.accept()
    if not node_id:
        await ws.send_json({"ok": False, "err": "missing node_id"})
        await ws.close()
        return

    WS_UAV.add(ws)
    UAV_WS_NODE[ws] = node_id

    try:
        while True:
            _ = await ws.receive_text()
    except WebSocketDisconnect:
        WS_UAV.discard(ws)
        UAV_WS_NODE.pop(ws, None)
    except Exception:
        WS_UAV.discard(ws)
        UAV_WS_NODE.pop(ws, None)
