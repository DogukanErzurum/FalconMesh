import json
import os
import random
import time
from datetime import datetime, timezone
from urllib import request, error

NODE_ID = os.getenv("NODE_ID", "uav-unknown")
ROLE = os.getenv("ROLE", "follower")
STATE = os.getenv("STATE", "NORMAL")
HZ = float(os.getenv("HZ", "1"))

CONTROL_API_URL = os.getenv("CONTROL_API_URL", "").rstrip("/")
INGEST_PATH = os.getenv("INGEST_PATH", "/ingest")
INGEST_TIMEOUT = float(os.getenv("INGEST_TIMEOUT", "1.5"))

x = float(os.getenv("START_X", str(random.uniform(-50, 50))))
y = float(os.getenv("START_Y", str(random.uniform(-50, 50))))
heading = float(os.getenv("START_HEADING", str(random.uniform(0, 359))))
speed = float(os.getenv("START_SPEED", str(random.uniform(8, 22))))
battery = float(os.getenv("START_BATT", str(random.uniform(70, 100))))

def utc_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

def ingest(payload: dict) -> None:
    if not CONTROL_API_URL:
        return
    url = f"{CONTROL_API_URL}{INGEST_PATH}"
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with request.urlopen(req, timeout=INGEST_TIMEOUT) as resp:
            _ = resp.read()
    except Exception:
        # do not crash node on ingest issues
        return

while True:
    heading = (heading + random.uniform(-5, 5)) % 360
    speed = max(0.0, min(35.0, speed + random.uniform(-0.8, 0.8)))

    x += random.uniform(-1.5, 1.5)
    y += random.uniform(-1.5, 1.5)

    battery = max(0.0, battery - random.uniform(0.01, 0.08))

    msg = {
        "ts": utc_iso(),
        "node_id": NODE_ID,
        "role": ROLE,
        "state": STATE,
        "pos": {"x": round(x, 2), "y": round(y, 2)},
        "heading_deg": round(heading, 1),
        "speed_mps": round(speed, 1),
        "battery_pct": round(battery, 1),
        "net": {"rtt_ms": 0, "loss_pct": 0},
    }

    # local log (for debugging)
    print(json.dumps(msg, ensure_ascii=False), flush=True)

    # send to control plane
    ingest(msg)

    time.sleep(1.0 / HZ)
