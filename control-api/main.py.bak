from __future__ import annotations

from datetime import datetime, timezone
from typing import Dict, Any, Set, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

app = FastAPI(title="FalconMesh Control API", version="0.3.0")

# last known telemetry per node_id
LAST: Dict[str, Dict[str, Any]] = {}

# telemetry subscribers (GCS)
WS_TELEM: Set[WebSocket] = set()

# command subscribers (UAVs)
WS_UAV: Set[WebSocket] = set()

# map websocket -> node_id for UAV connections
UAV_WS_NODE: Dict[WebSocket, str] = {}

def utc_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

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

    # deliver to UAV sockets
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

@app.websocket("/ws/telemetry")
async def ws_telemetry(ws: WebSocket):
    await ws.accept()
    WS_TELEM.add(ws)

    # snapshot on connect
    try:
        await ws.send_json({"type": "snapshot", "ts": utc_iso(), "nodes": list(LAST.values())})
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
        # keep alive, optionally receive pings
        while True:
            _ = await ws.receive_text()
    except WebSocketDisconnect:
        WS_UAV.discard(ws)
        UAV_WS_NODE.pop(ws, None)
    except Exception:
        WS_UAV.discard(ws)
        UAV_WS_NODE.pop(ws, None)
