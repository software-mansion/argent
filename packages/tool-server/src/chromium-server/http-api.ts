import { Router, type Request, type Response } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage, Server } from "node:http";
import type { ButtonType, ChromiumServer, KeyDirection, Rotation, TouchType } from "./types";

/**
 * Express router mirroring sim-server's HTTP surface, scoped per Chromium
 * device id. Mounted under `/chromium-server/:id/...` by the tool-server so
 * the preview UI / external consumers can drive a Chromium app the same way
 * they drive a simulator. Endpoints intentionally mirror sim-server names so
 * a generic client can be written once.
 *
 * Routes:
 *   POST /api/screenshot         { rotation?, scale?, downscaler? } → { url, path }
 *   POST /api/clipboard/text     { text } → { status: "ok" }
 *   POST /api/fps                { report: bool } → { status: "ok" }
 *   POST /api/navigate           { url } → { status: "ok" }     [extra: not in sim-server]
 *   POST /api/reload             {} → { status: "ok" }          [extra]
 *   POST /api/history/back       {} → { moved: bool }           [extra]
 *   POST /api/history/forward    {} → { moved: bool }           [extra]
 *   GET  /viewport               → { width, height, devicePixelRatio }
 *
 * Plus an MJPEG endpoint `GET /stream.mjpeg` mounted directly by the
 * `attachMjpegEndpoint` helper because Express+streaming response bodies are
 * awkward without manually flushing.
 */
export function createChromiumServerRouter(server: ChromiumServer): Router {
  const router = Router();
  router.use((req, _res, next) => {
    // JSON parsing isn't pre-wired on this sub-router — the tool-server uses
    // express.json() at the top level, but make the dependency obvious here so
    // the router is reusable outside the tool-server.
    if (!req.body) req.body = {};
    next();
  });

  router.post("/api/screenshot", async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      const out = await server.captureScreenshot({
        rotation: body.rotation as Rotation | undefined,
        scale: typeof body.scale === "number" ? body.scale : undefined,
        downscaler: body.downscaler,
        id: typeof body.id === "string" ? body.id : undefined,
      });
      res.json(out);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/clipboard/text", async (req: Request, res: Response) => {
    const text = req.body?.text;
    if (typeof text !== "string") {
      res.status(400).json({ error: "body.text must be a string" });
      return;
    }
    try {
      await server.setClipboardText(text);
      res.json({ status: "ok" });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/fps", (req: Request, res: Response) => {
    const report = req.body?.report;
    if (typeof report !== "boolean") {
      res.status(400).json({ error: "body.report must be a boolean" });
      return;
    }
    server.setFpsReporting(report);
    res.json({ status: "ok" });
  });

  router.post("/api/navigate", async (req: Request, res: Response) => {
    const url = req.body?.url;
    if (typeof url !== "string") {
      res.status(400).json({ error: "body.url must be a string" });
      return;
    }
    try {
      await server.navigate(url);
      res.json({ status: "ok" });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/reload", async (_req: Request, res: Response) => {
    try {
      await server.reload();
      res.json({ status: "ok" });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/history/back", async (_req: Request, res: Response) => {
    try {
      await server.goBack();
      res.json({ status: "ok" });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/history/forward", async (_req: Request, res: Response) => {
    try {
      await server.goForward();
      res.json({ status: "ok" });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/viewport", (_req: Request, res: Response) => {
    res.json(server.getViewport());
  });

  // MJPEG stream — Chromium's screencast format is already JPEG, so the loop
  // is just "subscribe → write multipart body → unsubscribe on close". One
  // screencast session is shared across all MJPEG clients via the refcounted
  // ScreencastManager.
  router.get("/stream.mjpeg", async (req: Request, res: Response) => {
    res.status(200);
    res.setHeader("Content-Type", "multipart/x-mixed-replace;boundary=NextFrame");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");

    const onFrame = (frame: { data: string }) => {
      const jpeg = Buffer.from(frame.data, "base64");
      res.write(
        `--NextFrame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`
      );
      res.write(jpeg);
      res.write("\r\n");
    };
    server.events.on("frame", onFrame);

    let session: { stop: () => Promise<void> } | null = null;
    try {
      session = await server.startScreencast({ format: "jpeg", quality: 70 });
    } catch {
      server.events.off("frame", onFrame);
      res.end();
      return;
    }

    const cleanup = async () => {
      server.events.off("frame", onFrame);
      try {
        await session?.stop();
      } catch {
        /* ignore */
      }
    };
    req.on("close", () => {
      cleanup().catch(() => {
        /* ignore */
      });
    });
  });

  return router;
}

interface WsRequest {
  id?: string;
  cmd: string;
  // Touch
  type?: TouchType | string;
  x?: number;
  y?: number;
  second_x?: number | null;
  second_y?: number | null;
  // Key
  direction?: KeyDirection;
  code?: number;
  key?: string;
  text?: string;
  codeName?: string;
  // Button
  button?: ButtonType;
  // Rotate
  rotation?: Rotation;
  // Wheel
  dx?: number;
  dy?: number;
  // Clipboard
  enabled?: boolean;
}

/**
 * Attach a WebSocket endpoint at `<base>/ws` for the given Chromium server.
 * Mirrors sim-server's WS contract: each message is `{ id, cmd, ...payload }`
 * and the response is `{ id, status: "ok"|"error", message? }`. Server-pushed
 * events (FPS reports) are JSON-encoded with the original event name.
 *
 * Lives in this file rather than the Express router because Express doesn't
 * own the HTTP upgrade handshake — the `ws` library does.
 *
 * `authorizeUpgrade` gates every handshake (Host / Origin guard). Because the
 * `ws` library — not Express — owns the upgrade, none of the HTTP middleware
 * (Host guard, auth) runs here, so this is the only place the same-origin /
 * DNS-rebinding defense can be applied to the control channel.
 */
export function attachChromiumServerWebsocket(
  httpServer: Server,
  basePath: string,
  resolveServer: (req: IncomingMessage) => ChromiumServer | null,
  authorizeUpgrade: (req: IncomingMessage) => boolean
): WebSocketServer {
  // noServer mode: we handle the upgrade ourselves so we can route by URL.
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "";
    if (!url.startsWith(basePath) || !url.endsWith("/ws")) return;
    // Reject cross-origin / DNS-rebinding handshakes before the socket is bound
    // to a device. Without this, any web page could open this control channel
    // cross-origin (CSWSH) and inject synthetic input — the HTTP Host/auth
    // middleware never runs on an upgrade. Checked before resolveServer so a
    // cross-origin probe can't even learn whether a device exists.
    if (!authorizeUpgrade(req)) {
      socket.destroy();
      return;
    }
    const server = resolveServer(req);
    if (!server) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      bindWsToServer(ws, server);
    });
  });
  return wss;
}

function bindWsToServer(ws: WebSocket, server: ChromiumServer): void {
  const sendJson = (payload: unknown) => {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      /* client gone */
    }
  };
  const onFps = (report: { fps: number; windowMs: number }) =>
    sendJson({ event: "fpsReport", ...report });
  const onFrame = (frame: { sessionId: number }) =>
    sendJson({ event: "frame", sessionId: frame.sessionId });
  server.events.on("fpsReport", onFps);
  // Optional: clients subscribed to the WS may not want every frame echoed; we
  // only signal the sessionId so they can correlate without paying for base64
  // payloads on this channel. MJPEG clients use the dedicated /stream.mjpeg.
  server.events.on("frame", onFrame);

  ws.on("close", () => {
    server.events.off("fpsReport", onFps);
    server.events.off("frame", onFrame);
  });

  ws.on("message", async (raw) => {
    const text = Buffer.isBuffer(raw)
      ? raw.toString()
      : Array.isArray(raw)
        ? Buffer.concat(raw).toString()
        : Buffer.from(raw).toString();
    let msg: WsRequest;
    try {
      msg = JSON.parse(text) as WsRequest;
    } catch (err) {
      sendJson({ status: "error", message: `parse error: ${(err as Error).message}` });
      return;
    }
    const id = msg.id;
    try {
      const result = await handleWsCommand(msg, server);
      sendJson({ id, status: "ok", ...result });
    } catch (err) {
      sendJson({ id, status: "error", message: err instanceof Error ? err.message : String(err) });
    }
  });
}

async function handleWsCommand(
  msg: WsRequest,
  server: ChromiumServer
): Promise<Record<string, unknown>> {
  switch (msg.cmd) {
    case "touch": {
      const touchType = msg.type as TouchType;
      const x = msg.x ?? 0;
      const y = msg.y ?? 0;
      const second =
        typeof msg.second_x === "number" && typeof msg.second_y === "number"
          ? { x: msg.second_x, y: msg.second_y }
          : null;
      await server.sendTouch(touchType, { x, y }, second);
      return {};
    }
    case "key": {
      const direction = (msg.direction ?? "Down") as KeyDirection;
      await server.sendKey(direction, {
        code: typeof msg.code === "number" ? msg.code : undefined,
        key: msg.key,
        text: msg.text,
        codeName: msg.codeName,
      });
      return {};
    }
    case "button": {
      const direction = (msg.direction ?? "Down") as KeyDirection;
      await server.sendButton(msg.button as ButtonType, direction);
      return {};
    }
    case "rotate": {
      await server.sendRotate(msg.rotation as Rotation);
      return {};
    }
    case "wheel": {
      await server.sendWheel({ x: msg.x ?? 0, y: msg.y ?? 0 }, msg.dx ?? 0, msg.dy ?? 0);
      return {};
    }
    case "clipboardSync": {
      await server.setClipboardSync(!!msg.enabled);
      return {};
    }
    default:
      throw new Error(`Unknown ws cmd: ${msg.cmd}`);
  }
}
