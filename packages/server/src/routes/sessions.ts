import { Router, Request, Response } from "express";
import { SessionManager } from "../services/SessionManager";
import { Config, DeviceOrientation, TouchType, ButtonName } from "../types/index";

export function createSessionsRouter(sessionManager: SessionManager, config: Config): Router {
  const router = Router();

  // POST /sessions
  router.post("/", async (req: Request, res: Response) => {
    const { udid, token, replay, showTouches } = req.body as {
      udid?: string;
      token?: string;
      replay?: boolean;
      showTouches?: boolean;
    };

    if (!udid) {
      res.status(400).json({ error: "udid is required" });
      return;
    }

    try {
      const session = await sessionManager.create(udid, {
        token,
        replay: replay !== undefined ? Boolean(replay) : config.replay,
        showTouches: showTouches !== undefined ? Boolean(showTouches) : config.showTouches,
      });
      res.status(201).json(session);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /sessions
  router.get("/", (_req: Request, res: Response) => {
    res.json(sessionManager.list());
  });

  // GET /sessions/:id
  router.get("/:id", (req: Request, res: Response) => {
    const internal = sessionManager.get(req.params.id);
    if (!internal) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json(sessionManager.toPublic(internal));
  });

  // DELETE /sessions/:id
  router.delete("/:id", (req: Request, res: Response) => {
    const destroyed = sessionManager.destroy(req.params.id);
    if (!destroyed) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.status(204).send();
  });

  // PUT /sessions/:id/token
  router.put("/:id/token", (req: Request, res: Response) => {
    const internal = sessionManager.get(req.params.id);
    if (!internal) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const { token } = req.body as { token?: string };
    if (!token) {
      res.status(400).json({ error: "token is required" });
      return;
    }
    internal.process.updateToken(token);
    res.json({ success: true });
  });

  // PUT /sessions/:id/settings
  router.put("/:id/settings", (req: Request, res: Response) => {
    const internal = sessionManager.get(req.params.id);
    if (!internal) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const { replay, showTouches } = req.body as { replay?: boolean; showTouches?: boolean };
    if (replay !== undefined) {
      internal.process.setReplay(Boolean(replay));
    }
    if (showTouches !== undefined) {
      internal.process.setShowTouches(Boolean(showTouches));
    }
    res.json(internal.process.currentSettings);
  });

  // GET /sessions/:id/stream
  router.get("/:id/stream", (req: Request, res: Response) => {
    const internal = sessionManager.get(req.params.id);
    if (!internal) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({ streamUrl: internal.process.streamUrl });
  });

  // POST /sessions/:id/screenshot
  router.post("/:id/screenshot", async (req: Request, res: Response) => {
    const internal = sessionManager.get(req.params.id);
    if (!internal) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const { rotation } = req.body as { rotation?: DeviceOrientation };
    try {
      const result = await internal.process.screenshot(rotation);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /sessions/:id/record/start
  router.post("/:id/record/start", (req: Request, res: Response) => {
    const internal = sessionManager.get(req.params.id);
    if (!internal) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    internal.process.startRecording();
    res.json({ success: true });
  });

  // POST /sessions/:id/record/stop — stops and saves in one request
  router.post("/:id/record/stop", async (req: Request, res: Response) => {
    const internal = sessionManager.get(req.params.id);
    if (!internal) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const { rotation } = req.body as { rotation?: DeviceOrientation };
    try {
      const result = await internal.process.stopAndSaveRecording(rotation ?? "Portrait");
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /sessions/:id/replay
  router.post("/:id/replay", async (req: Request, res: Response) => {
    const internal = sessionManager.get(req.params.id);
    if (!internal) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    if (!internal.process.currentSettings.replay) {
      res.status(409).json({ error: "Replay is not enabled for this session" });
      return;
    }
    const { rotation, durations } = req.body as {
      rotation?: DeviceOrientation;
      durations?: number[];
    };
    try {
      const results = await internal.process.saveReplay(
        rotation ?? "Portrait",
        Array.isArray(durations) && durations.length > 0 ? durations : [5, 10, 30]
      );
      res.json(results);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /sessions/:id/input/touch
  router.post("/:id/input/touch", (req: Request, res: Response) => {
    const internal = sessionManager.get(req.params.id);
    if (!internal) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const { type, points } = req.body as {
      type?: TouchType;
      points?: Array<{ x: number; y: number }>;
    };
    if (!type || !Array.isArray(points) || points.length === 0) {
      res.status(400).json({ error: "type and points[] are required" });
      return;
    }
    internal.process.touch(type, points);
    res.json({ success: true });
  });

  // POST /sessions/:id/input/key
  router.post("/:id/input/key", (req: Request, res: Response) => {
    const internal = sessionManager.get(req.params.id);
    if (!internal) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const { direction, keyCode } = req.body as {
      direction?: "Down" | "Up";
      keyCode?: number;
    };
    if (!direction || keyCode === undefined) {
      res.status(400).json({ error: "direction and keyCode are required" });
      return;
    }
    internal.process.key(direction, keyCode);
    res.json({ success: true });
  });

  // POST /sessions/:id/input/button
  router.post("/:id/input/button", (req: Request, res: Response) => {
    const internal = sessionManager.get(req.params.id);
    if (!internal) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const { direction, button } = req.body as {
      direction?: "Down" | "Up";
      button?: ButtonName;
    };
    if (!direction || !button) {
      res.status(400).json({ error: "direction and button are required" });
      return;
    }
    internal.process.button(direction, button);
    res.json({ success: true });
  });

  // POST /sessions/:id/input/rotate
  router.post("/:id/input/rotate", (req: Request, res: Response) => {
    const internal = sessionManager.get(req.params.id);
    if (!internal) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const { orientation } = req.body as { orientation?: DeviceOrientation };
    if (!orientation) {
      res.status(400).json({ error: "orientation is required" });
      return;
    }
    internal.process.rotate(orientation);
    res.json({ success: true });
  });

  // POST /sessions/:id/input/paste
  router.post("/:id/input/paste", (req: Request, res: Response) => {
    const internal = sessionManager.get(req.params.id);
    if (!internal) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const { text } = req.body as { text?: string };
    if (text === undefined) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    internal.process.paste(text);
    res.json({ success: true });
  });

  // POST /sessions/:id/input/scroll
  router.post("/:id/input/scroll", (req: Request, res: Response) => {
    const internal = sessionManager.get(req.params.id);
    if (!internal) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const { x, y, deltaX, deltaY } = req.body as {
      x?: number;
      y?: number;
      deltaX?: number;
      deltaY?: number;
    };
    if (x === undefined || y === undefined || deltaX === undefined || deltaY === undefined) {
      res.status(400).json({ error: "x, y, deltaX, and deltaY are required" });
      return;
    }
    internal.process.scroll(x, y, deltaX, deltaY);
    res.json({ success: true });
  });

  // GET /sessions/:id/events — SSE stream
  router.get("/:id/events", (req: Request, res: Response) => {
    const internal = sessionManager.get(req.params.id);
    if (!internal) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.flushHeaders();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const onScreenshotReady = (d: unknown) => send("screenshot_ready", d);
    const onScreenshotError = (d: unknown) => send("screenshot_error", d);
    const onVideoReady = (d: unknown) => send("video_ready", d);
    const onVideoError = (d: unknown) => send("video_error", d);
    const onFpsReport = (d: unknown) => send("fps_report", d);
    const onExit = (code: unknown) => send("exit", { code });

    const proc = internal.process;
    proc.on("screenshot_ready", onScreenshotReady);
    proc.on("screenshot_error", onScreenshotError);
    proc.on("video_ready", onVideoReady);
    proc.on("video_error", onVideoError);
    proc.on("fps_report", onFpsReport);
    proc.on("exit", onExit);

    req.on("close", () => {
      proc.off("screenshot_ready", onScreenshotReady);
      proc.off("screenshot_error", onScreenshotError);
      proc.off("video_ready", onVideoReady);
      proc.off("video_error", onVideoError);
      proc.off("fps_report", onFpsReport);
      proc.off("exit", onExit);
    });
  });

  return router;
}
