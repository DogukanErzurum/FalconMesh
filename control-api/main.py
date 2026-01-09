from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Dict, Any, List, Set

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import JSONResponse

app = FastAPI(title="FalconMesh Control API", version="0.1.0")

# last known telemetry per node_id
LAST: Dict[str, Dict[str, Any]] = {}

# connected websocket clients
WS_CLIENTS: Set[WebSocket] = set()

def utc_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

@app.get("/health")
def health():
    return {"ok": True, "ts": utc_iso(), "nodes": len(LAST), "ws_clients": len(WS_CLIENTS)}

@app.get("/api/nodes")
def nodes():
    # return last known state for each node
    return {"ts": utc_iso(), "nodes": list(LAST.values())}

@app.post("/ingest")
async def ingest(req: Request):
    try:
        payload = await req.json()
        node_id = payload.get("node_id")
        if not node_id:
            return JSONResponse({"ok": False, "error": "missing node_id"}, status_code=400)

        LAST[node_id] = payload

        # broadcast to websocket clients
        msg = json.dumps(payload, ensure_ascii=False)
        dead: List[WebSocket] = []
        for ws in list(WS_CLIENTS):
            try:
                await ws.send_text(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            WS_CLIENTS.discard(ws)

        return {"ok": True}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=400)

@app.websocket("/ws/telemetry")
async def ws_telemetry(ws: WebSocket):
    await ws.accept()
    WS_CLIENTS.add(ws)
    try:
        # send snapshot on connect
        for node in LAST.values():
            await ws.send_text(json.dumps(node, ensure_ascii=False))
        while True:
            # keep connection; client may send pings
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        WS_CLIENTS.discard(ws)
