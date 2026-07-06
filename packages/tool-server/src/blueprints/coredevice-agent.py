#!/usr/bin/env python3
"""Persistent CoreDevice agent — one long-lived process per physical iPhone.

Replaces per-call `pymobiledevice3` CLI spawns (each ~0.8s, ~0.5s just the
Python import) with a single process that connects the RSD tunnel once, holds
the touchscreen media-stream session + screenshot service open, and executes
newline-delimited JSON commands on stdin, replying with one JSON line each.

Reuses pymobiledevice3's own CLI helpers so behaviour is identical to the
`developer core-device …` commands (dwell-drag tap, mainTouchscreen reports,
Indigo hardware buttons, screen-capture PNG).

Protocol (one JSON object per line):
  <- {"udid": "...", "port": 49151}                 (argv, not stdin)
  -> {"ready": true}                                 (or {"ready": false, "error": "..."})
  <- {"id": 1, "op": "screenshot"}
  -> {"id": 1, "ok": true, "image_b64": "..."}
  <- {"id": 2, "op": "tap", "x": 32768, "y": 20000}          (x/y already 0..65535)
  <- {"id": 3, "op": "swipe", "x1":.., "y1":.., "x2":.., "y2":.., "steps":19, "duration":0.3}
  <- {"id": 4, "op": "button", "name": "home"}
  <- {"id": 5, "op": "homescreen"}                            (springboard icon grid)
  -> {"id": N, "ok": true, ...}  |  {"id": N, "error": "...", "gated_9021": bool}
"""
import asyncio
import base64
import contextlib
import json
import sys

from pymobiledevice3.remote.remote_service_discovery import RemoteServiceDiscoveryService
from pymobiledevice3.remote.core_device.hid_service import (
    touch_session,
    IndigoHIDService,
    DIGITIZER_SURFACE_MAIN_TOUCHSCREEN,
)
from pymobiledevice3.remote.core_device.screen_capture_service import ScreenCaptureService
from pymobiledevice3.services.springboard import SpringBoardServicesService
from pymobiledevice3.cli.developer.core_device import _do_drag, _send_button_press, _NAMED_BUTTONS

import urllib.request


def _resolve_rsd(udid: str, port: int):
    payload = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=4))
    entry = payload.get(udid) or []
    t = entry[0] if entry else {}
    addr, tport = t.get("tunnel-address"), t.get("tunnel-port")
    if not addr or not tport:
        raise RuntimeError(f"no active tunnel registered for {udid} on tunneld :{port}")
    return addr, int(tport)


async def _maybe_await(v):
    return await v if asyncio.iscoroutine(v) else v


class Agent:
    def __init__(self, udid: str, port: int):
        self.udid = udid
        self.port = port
        self.rsd = None
        self.stack = contextlib.AsyncExitStack()
        self.touch = None  # UniversalHIDServiceService, held open (media stream stays warm)

    async def connect(self):
        addr, tport = _resolve_rsd(self.udid, self.port)
        self.rsd = RemoteServiceDiscoveryService((addr, tport))
        await self.rsd.connect()

    async def _ensure_touch(self):
        # Lazily open (and keep) the touchscreen media-stream session — the auth
        # gate backboardd needs for injected touches. Kept warm so taps don't pay
        # the media-stream startup each time.
        if self.touch is None:
            self.touch = await self.stack.enter_async_context(touch_session(self.rsd))
        return self.touch

    async def op_screenshot(self, _):
        # ScreenCaptureService delivers one PNG per open (the stream ends after
        # the frame), so open a fresh one each call — cheap now the interpreter
        # and tunnel are already warm.
        async with ScreenCaptureService(self.rsd) as screen:
            resp = await screen.capture_screenshot()
        return {"image_b64": base64.b64encode(resp["image"]).decode("ascii")}

    async def op_tap(self, msg):
        svc = await self._ensure_touch()
        x, y = int(msg["x"]), int(msg["y"])
        # Zero-dwell taps are dropped by iOS; emit a short held drag with a tiny
        # move away from the edge (mirrors core-device.ts / the CLI drag path).
        y2 = y + 96 if y <= 65535 - 120 else y - 96
        await _do_drag(svc, x, y, x, y2, 3, 0.15, tsid=DIGITIZER_SURFACE_MAIN_TOUCHSCREEN)
        return {}

    async def op_swipe(self, msg):
        svc = await self._ensure_touch()
        await _do_drag(
            svc, int(msg["x1"]), int(msg["y1"]), int(msg["x2"]), int(msg["y2"]),
            int(msg.get("steps", 19)), float(msg.get("duration", 0.3)),
            tsid=DIGITIZER_SURFACE_MAIN_TOUCHSCREEN,
        )
        return {}

    async def op_button(self, msg):
        name = msg["name"]
        if name not in _NAMED_BUTTONS:
            raise RuntimeError(f"unknown button '{name}'")
        usage_page, usage_code, hold = _NAMED_BUTTONS[name]
        async with IndigoHIDService(self.rsd) as svc:
            await _send_button_press(svc, usage_page, usage_code, "press", hold)
        return {}

    async def op_homescreen(self, _):
        sb = SpringBoardServicesService(lockdown=self.rsd)
        icons = await _maybe_await(sb.get_icon_state())
        metrics = await _maybe_await(sb.get_homescreen_icon_metrics())
        return {"icon_state": icons, "metrics": metrics}

    async def op_ping(self, _):
        return {"pong": True}

    async def dispatch(self, msg):
        op = msg.get("op")
        fn = getattr(self, f"op_{op}", None)
        if fn is None:
            raise RuntimeError(f"unknown op '{op}'")
        return await fn(msg)

    async def close(self):
        with contextlib.suppress(Exception):
            await self.stack.aclose()
        if self.rsd is not None:
            with contextlib.suppress(Exception):
                await self.rsd.close()


def _is_9021(text: str) -> bool:
    import re
    return bool(re.search(r"core\s*device\s*error\W*9021", text, re.I) or re.search(r"\b9021\b", text))


async def main():
    udid = sys.argv[1]
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 49151
    agent = Agent(udid, port)
    out = sys.stdout

    def emit(obj):
        # default=str keeps a stray plist type (bytes/datetime in springboard
        # icon state) from crashing serialization mid-session.
        out.write(json.dumps(obj, default=str) + "\n")
        out.flush()

    try:
        await agent.connect()
    except Exception as e:  # noqa: BLE001
        emit({"ready": False, "error": str(e)})
        return
    emit({"ready": True})

    loop = asyncio.get_event_loop()
    reader = asyncio.StreamReader()
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)

    while True:
        line = await reader.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:  # noqa: BLE001
            emit({"error": "bad json"})
            continue
        mid = msg.get("id")
        try:
            result = await agent.dispatch(msg)
            emit({"id": mid, "ok": True, **result})
        except Exception as e:  # noqa: BLE001
            text = f"{type(e).__name__}: {e}"
            emit({"id": mid, "error": text, "gated_9021": _is_9021(text)})

    await agent.close()


if __name__ == "__main__":
    asyncio.run(main())
