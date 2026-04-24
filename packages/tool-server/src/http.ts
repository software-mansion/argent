import express, { Request, Response } from "express";
import type { Registry } from "@argent/registry";
import { ToolNotFoundError } from "@argent/registry";
import { createIdleTimer } from "./utils/idle-timer";
import { DependencyMissingError, ensureDeps } from "./utils/check-deps";
import { formatErrorForAgent } from "./utils/format-error";
import { getUpdateState, isUpdateNoteSuppressed, suppressUpdateNote } from "./utils/update-checker";
import { buildUpdateNote } from "./update-utils";
import { createPreviewRouter } from "./preview";

const AUTO_SUPPRESS_MS = 30 * 60 * 1000; // 30 minutes

function findDependencyMissing(err: unknown): DependencyMissingError | null {
  let current: unknown = err;
  // Bounded to avoid pathological cycles; in practice the chain is ≤ 2 links.
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    if (current instanceof DependencyMissingError) return current;
    current = current.cause;
  }
  return null;
}

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

  // Hidden (not MCP-exposed) preview UI + stream discovery endpoints.
  // MCP only consumes /tools and /tools/:name, so this subtree is invisible to agents.
  app.use("/preview", createPreviewRouter(registry));

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
        alwaysLoad?: boolean;
        searchHint?: string;
      } = {
        name: id,
        description: def?.description ?? "",
        inputSchema: def?.inputSchema ?? { type: "object", properties: {} },
      };
      if (def?.outputHint) entry.outputHint = def.outputHint;
      if (def?.alwaysLoad) entry.alwaysLoad = true;
      if (def?.searchHint) entry.searchHint = def.searchHint;
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

      // Pre-flight host-binary check: a tool declaring `requires: ['xcrun']`
      // or similar is unambiguously single-platform, so we can probe PATH
      // before touching the registry / side-effectful services. Cross-platform
      // tools leave `requires` unset and do a post-classify `ensureDep` call
      // inside their execute() instead.
      if (def.requires && def.requires.length > 0) {
        try {
          await ensureDeps(def.requires);
        } catch (err) {
          if (err instanceof DependencyMissingError) {
            res.status(424).json({ error: err.message });
            return;
          }
          throw err;
        }
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
        // A DependencyMissingError thrown from inside a cross-platform tool's
        // execute (i.e. post-`classifyDevice` `ensureDep` call) is the same
        // missing-host-binary condition as the pre-flight check, so surface
        // the same 424 status and pretty message. Walk the full cause chain
        // so a double-wrap (registry ToolExecutionError → future middleware)
        // still maps to 424 instead of silently regressing to a generic 500.
        const depErr = findDependencyMissing(err);
        if (depErr) {
          res.status(424).json({ error: depErr.message });
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
