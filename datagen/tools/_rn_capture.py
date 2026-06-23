#!/usr/bin/env python3
"""RN pokemon real-capture driver. Drives the live app via the tool-server HTTP API,
records the OPTIMAL path per task with verbatim debugger-component-tree text, and emits
RawTrajectory JSON. Self-verification = each task is captured from a clean restart-app,
and the final state is asserted by a predicate on the last discovery tree.

NOT app source — every observation is the real tool output from navigating blind.
"""
import json, os, subprocess, sys, time, urllib.request

DISC = os.path.expanduser("~/.argent/tool-server.json")
with open(DISC) as f:
    d = json.load(f)
BASE = f"http://{d.get('host','127.0.0.1')}:{d['port']}"
TOKEN = d.get("token", "")
UDID = "6DBF83B4-F341-4F8D-B48D-CD8FF312CCFB"
PORT = 8082
BUNDLE = "com.latekvo.pokemon"


def call(name, args):
    body = json.dumps(args).encode()
    req = urllib.request.Request(f"{BASE}/tools/{name}", data=body,
                                 headers={"Content-Type": "application/json",
                                          "Authorization": f"Bearer {TOKEN}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def tree():
    """Return verbatim debugger-component-tree text (the RN discovery output)."""
    r = call("debugger-component-tree", {"device_id": UDID, "port": PORT})
    if "error" in r:
        raise RuntimeError(r["error"])
    return r["data"]


def tap(x, y):
    call("gesture-tap", {"udid": UDID, "x": x, "y": y})


def restart_clean():
    call("restart-app", {"udid": UDID, "bundleId": BUNDLE})
    # poll for debugger reconnect (~2s typical, allow up to 14s)
    for _ in range(7):
        time.sleep(2)
        try:
            st = call("debugger-status", {"device_id": UDID, "port": PORT})
            if st.get("data", {}).get("connected"):
                time.sleep(1.0)
                return
        except Exception:
            pass
    raise RuntimeError("debugger did not reconnect after restart")


# Each task: id, kind, difficulty, gestures, task text, finalAnswer,
# build(rec) -> drives the app calling rec.discover()/rec.act(...), and a verify predicate
# on the final tree text.
class Recorder:
    def __init__(self):
        self.steps = []

    def discover(self, onScreenOnly=True):
        args = {"device_id": UDID, "port": PORT}
        if not onScreenOnly:
            args["onScreenOnly"] = False
        r = call("debugger-component-tree", args)
        if "error" in r:
            raise RuntimeError(r["error"])
        t = r["data"]
        self.steps.append({"call": {"name": "debugger-component-tree", "arguments": args},
                           "observation": {"text": t}})
        return t

    def tap(self, x, y):
        tap(x, y)
        time.sleep(1.6)
        self.steps.append({"call": {"name": "gesture-tap",
                                    "arguments": {"udid": UDID, "x": x, "y": y}},
                           "observation": {"text": "", "hasScreenshot": True}})

    def scroll(self, x, y, dx, dy):
        call("gesture-scroll", {"udid": UDID, "x": x, "y": y, "deltaX": dx, "deltaY": dy})
        time.sleep(1.4)
        self.steps.append({"call": {"name": "gesture-scroll",
                                    "arguments": {"udid": UDID, "x": x, "y": y,
                                                  "deltaX": dx, "deltaY": dy}},
                           "observation": {"text": "", "hasScreenshot": True}})

    def swipe(self, fx, fy, tx, ty):
        call("gesture-swipe", {"udid": UDID, "fromX": fx, "fromY": fy, "toX": tx, "toY": ty})
        time.sleep(1.4)
        self.steps.append({"call": {"name": "gesture-swipe",
                                    "arguments": {"udid": UDID, "fromX": fx, "fromY": fy,
                                                  "toX": tx, "toY": ty}},
                           "observation": {"text": "", "hasScreenshot": True}})

    def keyboard(self, **kw):
        call("keyboard", {"udid": UDID, **kw})
        time.sleep(1.4)
        self.steps.append({"call": {"name": "keyboard",
                                    "arguments": {"udid": UDID, **kw}},
                           "observation": {"text": "", "hasScreenshot": True}})
