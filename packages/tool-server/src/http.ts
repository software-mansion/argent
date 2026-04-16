import express, { Request, Response } from "express";
import type { Registry } from "@argent/registry";
import { ToolNotFoundError } from "@argent/registry";
import { createIdleTimer } from "./utils/idle-timer";
import { formatErrorForAgent } from "./utils/format-error";
import { getUpdateState, isUpdateNoteSuppressed, suppressUpdateNote } from "./utils/update-checker";
import { buildUpdateNote } from "./update-utils";

const AUTO_SUPPRESS_MS = 30 * 60 * 1000; // 30 minutes

// ── HTTP app ────────────────────────────────────────────────────────

export interface HttpAppOptions {
  idleTimeoutMs?: number;
  onIdle?: () => void;
  onShutdown?: () => void;
}

export interface HttpAppHandle {
  app: express.Application;
  /** Clears the idle timer. Call on server shutdown. */
  dispose: () => void;
  /** Timestamp of the last tool invocation (ms since epoch). Exposed for testing. */
  getLastActivityAt: () => number;
}

export function createHttpApp(registry: Registry, options?: HttpAppOptions): HttpAppHandle {
  const app = express();
  app.use(express.json());

  const idleTimer = createIdleTimer(options?.idleTimeoutMs ?? 0, options?.onIdle);

  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (_req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.get("/registry/snapshot", (_req: Request, res: Response) => {
    const snapshot = registry.getSnapshot();
    const services: Record<string, { state: string; dependents: string[] }> = {};
    for (const [urn, data] of snapshot.services) {
      services[urn] = { state: data.state, dependents: [...data.dependents] };
    }
    res.json({
      services,
      namespaces: snapshot.namespaces,
      tools: snapshot.tools,
    });
  });

  app.get("/tools", (_req: Request, res: Response) => {
    idleTimer.touch();
    const snapshot = registry.getSnapshot();
    const tools = snapshot.tools.map((id) => {
      const def = registry.getTool(id);
      const entry: {
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
        outputHint?: string;
      } = {
        name: id,
        description: def?.description ?? "",
        inputSchema: def?.inputSchema ?? { type: "object", properties: {} },
      };
      if (def?.outputHint) entry.outputHint = def.outputHint;
      return entry;
    });
    res.json({ tools });
  });

  app.post(
    "/tools/:name",
    (req, _res, next) => {
      idleTimer.touch();
      next();
    },
    async (req: Request, res: Response) => {
      const name = req.params.name!;

      const def = registry.getTool(name);
      if (!def) {
        res.status(404).json({ error: `Tool "${name}" not found` });
        return;
      }

      let parsedData = req.body;
      if (def.zodSchema) {
        const parseResult = def.zodSchema.safeParse(req.body);
        if (!parseResult.success) {
          res.status(400).json({ error: parseResult.error.message });
          return;
        }
        parsedData = parseResult.data;
      }

      const controller = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) controller.abort();
      });

      try {
        const data = await registry.invokeTool(name, parsedData, {
          signal: controller.signal,
        });
        const { updateAvailable, currentVersion, latestVersion } = getUpdateState();
        const shouldNotify = updateAvailable && !isUpdateNoteSuppressed();
        if (shouldNotify) {
          suppressUpdateNote(AUTO_SUPPRESS_MS);
        }
        res.json({
          data,
          ...(shouldNotify
            ? { note: buildUpdateNote(currentVersion, latestVersion ?? "unknown") }
            : {}),
        });
      } catch (err: unknown) {
        if (err instanceof ToolNotFoundError) {
          res.status(404).json({ error: err.message });
          return;
        }
        res.status(500).json({ error: formatErrorForAgent(err) });
      }
    }
  );

  if (options?.onShutdown) {
    const onShutdown = options.onShutdown;
    app.post("/shutdown", (_req: Request, res: Response) => {
      res.json({ ok: true });
      onShutdown();
    });
  }

  return {
    app,
    dispose: () => idleTimer.dispose(),
    getLastActivityAt: () => idleTimer.getLastActivityAt(),
  };
}
