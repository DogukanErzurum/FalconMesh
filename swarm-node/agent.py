from __future__ import annotations

import os
import json
import time
import math
import random
import threading
from datetime import datetime, timezone

import requests

# Optional WS command channel
try:
    import websocket  # websocket-client
except Exception:
    websocket = None

NODE_ID = os.getenv("NODE_ID", "uav-1")
CONTROL_API_URL = os.getenv("CONTROL_API_URL", "http://control-api:8000")

# shared state
STATE_LOCK = threading.Lock()
STATE = "NORMAL"  # NORMAL | HOLD | RTB | FORM_UP
ROLE = "follower"

# simple 2D kinematics
x = random.uniform(-60, 60)
y = random.uniform(-60, 60)
heading = random.uniform(0, 360)
speed = random.uniform(6, 22)
battery = random.uniform(60, 95)

def utc_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

def clamp(v, lo, hi):
    return max(lo, min(hi, v))

def tick_motion(dt: float):
    global x, y, heading, speed, battery

    with STATE_LOCK:
        st = STATE

    # simple behaviors
    if st == "HOLD":
        speed_local = 0.0
    elif st == "RTB":
        # go toward origin
        dx, dy = -x, -y
        heading_local = (math.degrees(math.atan2(dy, dx)) + 360) % 360
        heading = heading_local
        speed_local = 18.0
    elif st == "FORM_UP":
        # mild convergence to a ring around origin
        r = math.hypot(x, y)
        target_r = 35.0
        if r > 1e-6:
            # radial correction
            dr = (target_r - r) * 0.2
            x += (x / r) * dr
            y += (y / r) * dr
        speed_local = 12.0
    else:
        speed_local = speed

    # move
    rad = math.radians(heading)
    x += math.cos(rad) * speed_local * dt
    y += math.sin(rad) * speed_local * dt

    # wander heading slightly in NORMAL/FORM_UP
    if st in ("NORMAL", "FORM_UP"):
        heading = (heading + random.uniform(-8, 8)) % 360

    # battery drain
    battery = clamp(battery - (0.02 + 0.001 * speed_local), 0, 100)

    # net stats placeholder
    net = {"rtt_ms": 0, "loss_pct": 0}

    payload = {
        "ts": utc_iso(),
        "node_id": NODE_ID,
        "role": ROLE,
        "state": st,
        "pos": {"x": round(x, 2), "y": round(y, 2)},
        "heading_deg": round(heading, 1),
        "speed_mps": round(speed_local, 1),
        "battery_pct": round(battery, 1),
        "net": net,
    }
    return payload

def ingest_loop():
    url = CONTROL_API_URL.rstrip("/") + "/ingest"
    last = time.time()
    while True:
        now = time.time()
        dt = now - last
        last = now
        payload = tick_motion(dt)
        try:
            requests.post(url, json=payload, timeout=2)
        except Exception:
            pass
        time.sleep(1.0)

def ws_command_loop():
    """
    Connect to Control API UAV WS channel and update STATE on commands.
    Requires websocket-client. If missing, loop exits silently.
    """
    if websocket is None:
        return

    ws_url = CONTROL_API_URL.rstrip("/").replace("http://", "ws://").replace("https://", "wss://")
    ws_url = f"{ws_url}/ws/uav?node_id={NODE_ID}"

    def on_message(ws, message):
        global STATE
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
                STATE = "NORMAL" if cmd == "RESUME" else cmd
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
    t1 = threading.Thread(target=ingest_loop, daemon=True)
    t1.start()

    t2 = threading.Thread(target=ws_command_loop, daemon=True)
    t2.start()

    print(json.dumps({"ts": utc_iso(), "node_id": NODE_ID, "msg": "agent started", "control_api": CONTROL_API_URL}))
    while True:
        time.sleep(60)

if __name__ == "__main__":
    main()
