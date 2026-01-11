from __future__ import annotations

import os
import json
import time
import math
import random
import threading
from datetime import datetime, timezone
from typing import Any, Dict, Optional, List, Tuple

import requests

# Optional WS command channel
try:
    import websocket  # websocket-client
except Exception:
    websocket = None

NODE_ID = os.getenv("NODE_ID", "uav-1")
CONTROL_API_URL = os.getenv("CONTROL_API_URL", "http://control-api:8000")

# ------------------------
# Shared state + overrides
# ------------------------
STATE_LOCK = threading.Lock()

# Manual override commands from /api/command (WS):
#   None means autopilot runs normally
MANUAL_OVERRIDE: Optional[str] = None  # "HOLD" | "RTB" | "FORM_UP" | None

# Autopilot state machine (mission-driven)
AP_STATE = "IDLE"  # IDLE | ENROUTE_STAGE | HOLDING | ENROUTE_TARGET | ON_TARGET | RTB | LANDING | CHARGING

ROLE = "follower"

# ------------------------
# Simple 2D kinematics
# ------------------------
x = random.uniform(-60, 60)
y = random.uniform(-60, 60)
heading_deg = random.uniform(0, 360)
speed_mps = random.uniform(10, 18)
alt_m = random.uniform(120, 180)

battery_pct = random.uniform(60, 95)

# charging/drain tuning (MVP)
BASE_DRAIN_PER_SEC = 0.02
SPEED_DRAIN_K = 0.001
CHARGE_PER_SEC = 1.2  # ~1.2% per sec => fast sim for demo

# Mission cache
MISSION_LOCK = threading.Lock()
MISSION: Dict[str, Any] = {
    "id": None,
    "created_ts": None,
    "updated_ts": None,
    "waypoints": [],
    "base": None,
    "staging_points": [],
    "target": None,
    "battery_policy": {"rtb_below_pct": 20, "resume_above_pct": 90},
}

# Progress within mission
PROG_LOCK = threading.Lock()
stage_index = 0
holding_until_ts: Optional[float] = None  # epoch seconds, for HOLDING


def utc_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def dist(ax: float, ay: float, bx: float, by: float) -> float:
    return math.hypot(bx - ax, by - ay)


def heading_to(ax: float, ay: float, bx: float, by: float) -> float:
    # heading degrees 0..360, using atan2(dy, dx)
    dx, dy = (bx - ax), (by - ay)
    return (math.degrees(math.atan2(dy, dx)) + 360.0) % 360.0


def move_toward(ax: float, ay: float, bx: float, by: float, speed: float, dt: float) -> Tuple[float, float, float]:
    """
    Move from (ax,ay) toward (bx,by) at speed for dt.
    Returns new (x,y,heading_deg).
    """
    d = dist(ax, ay, bx, by)
    if d < 1e-6:
        return ax, ay, heading_deg
    hdg = heading_to(ax, ay, bx, by)
    step = min(d, speed * dt)
    rad = math.radians(hdg)
    nx = ax + math.cos(rad) * step
    ny = ay + math.sin(rad) * step
    return nx, ny, hdg


def _get_mission() -> Dict[str, Any]:
    with MISSION_LOCK:
        return dict(MISSION)


def _set_mission(m: Dict[str, Any]) -> None:
    with MISSION_LOCK:
        # shallow replace, keep defaults if missing
        MISSION["id"] = m.get("id")
        MISSION["created_ts"] = m.get("created_ts")
        MISSION["updated_ts"] = m.get("updated_ts")
        MISSION["waypoints"] = m.get("waypoints", []) if isinstance(m.get("waypoints"), list) else []
        MISSION["base"] = m.get("base")
        MISSION["target"] = m.get("target")
        sp = m.get("staging_points", [])
        MISSION["staging_points"] = sp if isinstance(sp, list) else []
        bp = m.get("battery_policy", {})
        if isinstance(bp, dict):
            # merge into defaults
            if "rtb_below_pct" in bp:
                MISSION["battery_policy"]["rtb_below_pct"] = float(bp["rtb_below_pct"])
            if "resume_above_pct" in bp:
                MISSION["battery_policy"]["resume_above_pct"] = float(bp["resume_above_pct"])


def mission_poll_loop():
    """
    Periodically fetch mission from control-api.
    MVP: polling every 2s.
    """
    url = CONTROL_API_URL.rstrip("/") + "/api/mission"
    last_id = None
    last_updated = None
    while True:
        try:
            r = requests.get(url, timeout=2, headers={"Cache-Control": "no-cache"})
            if r.ok:
                j = r.json()
                m = j.get("mission") if isinstance(j, dict) else None
                if isinstance(m, dict):
                    _set_mission(m)
                    mid = m.get("id")
                    upd = m.get("updated_ts")
                    if mid != last_id or upd != last_updated:
                        last_id, last_updated = mid, upd
                        # Mission changed -> reset progress safely
                        with PROG_LOCK:
                            global stage_index, holding_until_ts
                            stage_index = 0
                            holding_until_ts = None
        except Exception:
            pass
        time.sleep(2.0)


def _get_base_xy() -> Optional[Tuple[float, float, float]]:
    m = _get_mission()
    b = m.get("base")
    if isinstance(b, dict) and "x" in b and "y" in b:
        rx = float(b["x"])
        ry = float(b["y"])
        rr = float(b.get("radius_m", 60.0))
        return rx, ry, rr
    return None


def _get_target_xy() -> Optional[Tuple[float, float, float]]:
    m = _get_mission()
    t = m.get("target")
    if isinstance(t, dict) and "x" in t and "y" in t:
        tx = float(t["x"])
        ty = float(t["y"])
        tr = float(t.get("radius_m", 50.0))
        return tx, ty, tr
    return None


def _get_staging_list() -> List[Dict[str, Any]]:
    m = _get_mission()
    sp = m.get("staging_points", [])
    return sp if isinstance(sp, list) else []


def _get_battery_policy() -> Tuple[float, float]:
    m = _get_mission()
    bp = m.get("battery_policy", {}) or {}
    rtb = float(bp.get("rtb_below_pct", 20))
    res = float(bp.get("resume_above_pct", 90))
    return rtb, res


def _mission_available() -> bool:
    m = _get_mission()
    # mission id exists OR target/base exists; allow mission flow if base+target set
    return bool(m.get("id")) or bool(m.get("base")) or bool(m.get("target"))


def autopilot_step(dt: float) -> Dict[str, Any]:
    """
    One tick of autopilot logic and motion integration.
    Returns telemetry payload for /ingest.
    """
    global x, y, heading_deg, speed_mps, alt_m, battery_pct, AP_STATE, holding_until_ts, stage_index

    now_epoch = time.time()

    # Manual override from WS command channel
    with STATE_LOCK:
        override = MANUAL_OVERRIDE

    # Load mission snapshot
    m = _get_mission()
    base = _get_base_xy()
    target = _get_target_xy()
    staging = _get_staging_list()
    rtb_below, resume_above = _get_battery_policy()

    # Derive active goal for telemetry
    active_goal_name = None
    goal_x = None
    goal_y = None
    goal_r = None

    # --- Battery-triggered RTB if mission running ---
    if override is None and _mission_available():
        if battery_pct <= rtb_below and AP_STATE not in ("RTB", "LANDING", "CHARGING"):
            AP_STATE = "RTB"
            holding_until_ts = None

    # --- Manual overrides take priority ---
    if override == "HOLD":
        # stop movement
        v_speed = 0.0
        active_goal_name = "HOLD"
    elif override == "FORM_UP":
        # converge to ring around base if base exists else origin
        cx, cy = (0.0, 0.0)
        if base:
            cx, cy, _ = base
        r = math.hypot(x - cx, y - cy)
        target_r = 35.0
        if r > 1e-6:
            dr = (target_r - r) * 0.2
            x += ((x - cx) / r) * dr
            y += ((y - cy) / r) * dr
        v_speed = 12.0
        active_goal_name = "FORM_UP"
    elif override == "RTB":
        # go to base if exists else origin
        if base:
            bx, by, br = base
        else:
            bx, by, br = 0.0, 0.0, 60.0
        x, y, heading_deg = move_toward(x, y, bx, by, speed=18.0, dt=dt)
        v_speed = 18.0
        active_goal_name = "RTB"
        goal_x, goal_y, goal_r = bx, by, br
    else:
        # --- Autopilot mission-driven state machine ---
        if not _mission_available():
            AP_STATE = "IDLE"

        if AP_STATE == "IDLE":
            # if base exists, drift toward it slowly; else idle in place
            if base:
                bx, by, br = base
                d = dist(x, y, bx, by)
                if d > br:
                    x, y, heading_deg = move_toward(x, y, bx, by, speed=10.0, dt=dt)
                    v_speed = 10.0
                    active_goal_name = "BASE"
                    goal_x, goal_y, goal_r = bx, by, br
                else:
                    v_speed = 0.0
                    active_goal_name = "BASE"
                    goal_x, goal_y, goal_r = bx, by, br
            else:
                v_speed = 0.0

            # if we have target/base, start mission
            if base and target:
                AP_STATE = "ENROUTE_STAGE" if len(staging) > 0 else "ENROUTE_TARGET"

        elif AP_STATE == "ENROUTE_STAGE":
            if stage_index >= len(staging):
                AP_STATE = "ENROUTE_TARGET"
                v_speed = 0.0
            else:
                p = staging[stage_index]
                sx, sy = float(p["x"]), float(p["y"])
                sr = float(p.get("radius_m", 60.0))
                spd = float(p.get("speed_mps", 16.0)) if isinstance(p, dict) else 16.0
                x, y, heading_deg = move_toward(x, y, sx, sy, speed=spd, dt=dt)
                v_speed = spd
                active_goal_name = f"STAGE[{stage_index}]"
                goal_x, goal_y, goal_r = sx, sy, sr

                if dist(x, y, sx, sy) <= sr:
                    # arrived -> hold if requested
                    hold_s = float(p.get("hold_s", 0.0)) if "hold_s" in p and p.get("hold_s") is not None else 0.0
                    if hold_s > 0:
                        AP_STATE = "HOLDING"
                        holding_until_ts = now_epoch + hold_s
                    else:
                        stage_index += 1

        elif AP_STATE == "HOLDING":
            v_speed = 0.0
            active_goal_name = f"HOLD[{stage_index}]"
            # continue after hold time
            if holding_until_ts is None or now_epoch >= holding_until_ts:
                holding_until_ts = None
                stage_index += 1
                AP_STATE = "ENROUTE_STAGE" if stage_index < len(staging) else "ENROUTE_TARGET"

        elif AP_STATE == "ENROUTE_TARGET":
            if not target:
                v_speed = 0.0
            else:
                tx, ty, tr = target
                # choose speed from first waypoint if exists else default
                wp0 = m.get("waypoints", [])
                spd = 18.0
                if isinstance(wp0, list) and len(wp0) > 0 and isinstance(wp0[0], dict) and "speed_mps" in wp0[0]:
                    try:
                        spd = float(wp0[0]["speed_mps"])
                    except Exception:
                        spd = 18.0

                x, y, heading_deg = move_toward(x, y, tx, ty, speed=spd, dt=dt)
                v_speed = spd
                active_goal_name = "TARGET"
                goal_x, goal_y, goal_r = tx, ty, tr

                if dist(x, y, tx, ty) <= tr:
                    AP_STATE = "ON_TARGET"

        elif AP_STATE == "ON_TARGET":
            v_speed = 0.0
            active_goal_name = "ON_TARGET"
            if target:
                tx, ty, tr = target
                goal_x, goal_y, goal_r = tx, ty, tr

        elif AP_STATE == "RTB":
            # go to base if exists else origin
            if base:
                bx, by, br = base
            else:
                bx, by, br = 0.0, 0.0, 60.0
            x, y, heading_deg = move_toward(x, y, bx, by, speed=18.0, dt=dt)
            v_speed = 18.0
            active_goal_name = "RTB"
            goal_x, goal_y, goal_r = bx, by, br

            if dist(x, y, bx, by) <= br:
                AP_STATE = "LANDING"

        elif AP_STATE == "LANDING":
            # simple: immediately transition to charging, altitude -> 0
            alt_m = max(0.0, alt_m - 40.0 * dt)
            v_speed = 0.0
            active_goal_name = "LANDING"
            if alt_m <= 1.0:
                alt_m = 0.0
                AP_STATE = "CHARGING"

        elif AP_STATE == "CHARGING":
            v_speed = 0.0
            active_goal_name = "CHARGING"
            # charge battery quickly
            battery_pct = clamp(battery_pct + CHARGE_PER_SEC * dt, 0.0, 100.0)

            # Once charged enough, resume mission
            if battery_pct >= resume_above and base and target:
                # take off quickly
                alt_m = max(alt_m, 120.0)
                AP_STATE = "ENROUTE_STAGE" if len(staging) > 0 else "ENROUTE_TARGET"

        else:
            # unknown state fallback
            v_speed = 0.0
            AP_STATE = "IDLE"

    # If not charging, simulate battery drain
    if AP_STATE not in ("CHARGING",) and override != "HOLD":
        battery_pct = clamp(battery_pct - (BASE_DRAIN_PER_SEC + SPEED_DRAIN_K * float(max(v_speed, 0.0))) * dt, 0.0, 100.0)

    # If in flight states, keep altitude at least some value
    if AP_STATE in ("ENROUTE_STAGE", "ENROUTE_TARGET", "RTB", "ON_TARGET", "IDLE") and alt_m <= 5.0:
        alt_m = 120.0

    # nav metrics
    dist_to_goal = None
    if goal_x is not None and goal_y is not None:
        dist_to_goal = dist(x, y, goal_x, goal_y)

    dist_to_base = None
    if base:
        bx, by, _ = base
        dist_to_base = dist(x, y, bx, by)

    payload = {
        "ts": utc_iso(),
        "node_id": NODE_ID,
        "role": ROLE,
        "state": AP_STATE if override is None else override,

        "pos": {"x": round(x, 2), "y": round(y, 2), "alt_m": round(float(alt_m), 1)},
        "vel": {"speed_mps": round(float(v_speed), 1), "heading_deg": round(float(heading_deg), 1)},

        "battery": {"pct": round(float(battery_pct), 1)},
        "nav": {
            "active_goal": active_goal_name,
            "stage_index": int(stage_index),
            "dist_to_goal_m": round(float(dist_to_goal), 1) if dist_to_goal is not None else None,
            "dist_to_base_m": round(float(dist_to_base), 1) if dist_to_base is not None else None,
        },

        # include mission id for correlation
        "mission_id": m.get("id"),
    }
    return payload


def ingest_loop():
    url = CONTROL_API_URL.rstrip("/") + "/ingest"
    last = time.time()
    while True:
        now = time.time()
        dt = max(0.0, now - last)
        last = now

        payload = autopilot_step(dt)

        try:
            requests.post(url, json=payload, timeout=2)
        except Exception:
            pass

        time.sleep(1.0)


def ws_command_loop():
    """
    Connect to Control API UAV WS channel and update MANUAL_OVERRIDE on commands.
    Requires websocket-client. If missing, loop exits silently.
    """
    global MANUAL_OVERRIDE
    if websocket is None:
        return

    ws_url = CONTROL_API_URL.rstrip("/").replace("http://", "ws://").replace("https://", "wss://")
    ws_url = f"{ws_url}/ws/uav?node_id={NODE_ID}"

    def on_message(ws, message):
        global MANUAL_OVERRIDE
        try:
            msg = json.loads(message)
            if msg.get("type") != "command":
                return
            target = msg.get("target")
            cmd = msg.get("command")
            if target not in ("all", NODE_ID):
                return
            if cmd not in ("HOLD", "RTB", "FORM_UP", "RESUME"):
                return

            with STATE_LOCK:
                if cmd == "RESUME":
                    MANUAL_OVERRIDE = None
                else:
                    MANUAL_OVERRIDE = cmd
        except Exception:
            return

    def on_open(ws):
        # keepalive ping thread
        def ping():
            while True:
                try:
                    ws.send("ping")
                except Exception:
                    break
                time.sleep(10)

        threading.Thread(target=ping, daemon=True).start()

    while True:
        try:
            ws = websocket.WebSocketApp(ws_url, on_open=on_open, on_message=on_message)
            ws.run_forever(ping_interval=0)  # we do our own ping
        except Exception:
            pass
        time.sleep(2)


def main():
    # Start mission polling
    t0 = threading.Thread(target=mission_poll_loop, daemon=True)
    t0.start()

    # Telemetry ingest loop
    t1 = threading.Thread(target=ingest_loop, daemon=True)
    t1.start()

    # Optional WS command loop
    t2 = threading.Thread(target=ws_command_loop, daemon=True)
    t2.start()

    print(json.dumps({"ts": utc_iso(), "node_id": NODE_ID, "msg": "agent started", "control_api": CONTROL_API_URL}))
    while True:
        time.sleep(60)


if __name__ == "__main__":
    main()
