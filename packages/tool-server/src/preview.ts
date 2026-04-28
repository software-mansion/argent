import fs from "node:fs";
import path from "node:path";
import type { Request, Response, Router } from "express";
import express from "express";
import type { Registry } from "@argent/registry";
import { SIMULATOR_SERVER_NAMESPACE, type SimulatorServerApi } from "./blueprints/simulator-server";
import { listSimulatorsTool } from "./tools/simulator/list-simulators";
import type { ActionEventBus } from "./events";

function findUiHtml(): string | null {
  // Candidate paths (first match wins):
  //   1. bundled: sibling `preview-ui/index.html` next to the compiled bundle
  //   2. dev (built tool-server): `packages/ui/index.html` at workspace root
  //   3. dev (ts-node src): `packages/ui/index.html` at workspace root
  const candidates = [
    path.join(__dirname, "preview-ui", "index.html"),
    path.resolve(__dirname, "..", "..", "..", "ui", "index.html"),
    path.resolve(__dirname, "..", "..", "ui", "index.html"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function wsUrlFromHttp(httpUrl: string): string {
  const u = new URL(httpUrl);
  const scheme = u.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${u.host}/ws`;
}

/**
 * Best-effort: turn on the simulator-server's built-in pointer trail so that
 * agent taps and swipes leave a visible trace baked into the MJPEG stream.
 * Failure is silent — the overlay still works without it.
 */
async function enablePointerTrail(apiUrl: string, length: number): Promise<void> {
  // Cap how long we'll wait for the simulator-server to acknowledge — if it's
  // hung or doesn't implement the endpoint, we don't want to block the
  // /preview/simulator-server/:udid response.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    await fetch(`${apiUrl.replace(/\/$/, "")}/api/pointer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trail: length }),
      signal: controller.signal,
    });
  } catch {
    // No-op: simulator-server may not be running yet, or may not support it.
  } finally {
    clearTimeout(timer);
  }
}

export function createPreviewRouter(registry: Registry, actionBus: ActionEventBus): Router {
  const router = express.Router();

  router.get("/simulators", async (_req: Request, res: Response) => {
    try {
      const data = await registry.invokeTool<{
        simulators: Array<{
          udid: string;
          name: string;
          state: string;
          runtime: string;
          isAvailable: boolean;
        }>;
      }>(listSimulatorsTool.id);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/simulator-server/:udid", async (req: Request, res: Response) => {
    const udid = req.params.udid!;
    try {
      const api = await registry.resolveService<SimulatorServerApi>(
        `${SIMULATOR_SERVER_NAMESPACE}:${udid}`
      );
      // The UI just attached to a simulator-server — turn on the pointer trail
      // so finger paths show up baked into the stream. Best-effort.
      void enablePointerTrail(api.apiUrl, 24);
      res.json({
        udid,
        apiUrl: api.apiUrl,
        streamUrl: api.streamUrl,
        wsUrl: wsUrlFromHttp(api.apiUrl),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Server-Sent Events stream of every tool invocation. The preview UI uses
  // this to overlay the agent's actions on top of the simulator video.
  router.get("/events", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    // Wrap every write so a transport-level error (client gone, broken pipe)
    // tears the subscription down once instead of cascading throws through
    // each subsequent publish or heartbeat tick.
    let closed = false;
    const safeWrite = (chunk: string): void => {
      if (closed) return;
      try {
        res.write(chunk);
      } catch {
        teardown();
      }
    };

    // Initial comment so the client knows the stream opened.
    safeWrite(`: connected\n\n`);

    const heartbeat = setInterval(() => {
      // Keep proxies from closing the connection on idle.
      safeWrite(`: ping\n\n`);
    }, 15000);

    const unsubscribe = actionBus.subscribe((event) => {
      // SSE: one logical message per tool-call phase. Stringify defensively
      // — a tool that returns a circular structure shouldn't kill the stream.
      let payload: string;
      try {
        payload = JSON.stringify(event);
      } catch {
        payload = JSON.stringify({
          id: event.id,
          name: event.name,
          phase: event.phase,
          ts: event.ts,
          error: "unserializable result",
        });
      }
      safeWrite(`event: action\ndata: ${payload}\n\n`);
    });

    function teardown(): void {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      try {
        res.end();
      } catch {
        // Already torn down by the transport — nothing to do.
      }
    }

    req.on("close", teardown);
  });

  router.get("/", (_req: Request, res: Response) => {
    const p = findUiHtml();
    if (!p) {
      res.status(404).type("text/plain").send("Preview UI not found");
      return;
    }
    // Dev-style no-cache so edits to packages/ui/index.html are picked up on
    // reload without the user having to hard-refresh.
    res.set("Cache-Control", "no-store, must-revalidate");
    res.type("text/html").sendFile(p);
  });

  return router;
}
