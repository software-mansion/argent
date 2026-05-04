import express, { Request, Response } from "express";
import type { Registry } from "@argent/registry";
import { ToolNotFoundError } from "@argent/registry";
import { createIdleTimer } from "./utils/idle-timer";
import { DependencyMissingError, ensureDeps } from "./utils/check-deps";
import { formatErrorForAgent } from "./utils/format-error";
import { getUpdateState, isUpdateNoteSuppressed, suppressUpdateNote } from "./utils/update-checker";
import { buildUpdateNote } from "./update-utils";
import { createPreviewRouter } from "./preview";
import {
  assertSupported,
  NotImplementedOnPlatformError,
  UnsupportedOperationError,
} from "./utils/capability";
import { resolveDevice } from "./utils/device-info";

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
    (_req, res, next) => {
      // Track the request as in flight so the idle timer cannot fire
      // mid-execution for long-running tools (xctrace export, RN build,
      // etc.). Release on response finish OR connection close so an
      // aborted request doesn't leak a permanent +1.
      const release = idleTimer.beginRequest();
      res.on("close", release);
      res.on("finish", release);
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

      // Capability gate fires BEFORE the global requires preflight: an
      // android serial calling an iOS-only tool should get a clean
      // "unsupported on android" error, not a misleading "xcrun missing".
      // Cross-platform tools double-check inside their dispatch helper, so
      // non-HTTP callers (run-sequence, flow-run) are also covered.
      //
      // Tools spell the device parameter two ways — `udid` (legacy iOS-only
      // tools and gestures) and `device_id` (debugger / profiler / network
      // tools). Honour both so an Android serial reaching an iOS-only
      // device_id-tool is rejected at the gate instead of falling through
      // to the deeper blueprint error (which surfaces as a generic 500).
      const deviceArg =
        typeof parsedData?.udid === "string"
          ? parsedData.udid
          : typeof parsedData?.device_id === "string"
            ? parsedData.device_id
            : null;
      if (def.capability && deviceArg) {
        try {
          const device = resolveDevice(deviceArg);
          assertSupported(def.id, def.capability, device);
        } catch (err) {
          if (err instanceof UnsupportedOperationError) {
            res.status(400).json({ error: err.message });
            return;
          }
          throw err;
        }
      }

      // Global host-binary preflight: tools with `requires: ['xcrun' | 'adb',
      // ...]` get a 424 Failed Dependency with an install hint instead of a
      // deep ENOENT from a child-process call. For cross-platform tools where
      // the binary requirement differs per branch, the per-platform
      // `PlatformImpl.requires` fires inside `dispatchByPlatform` after the
      // device is classified — leave `def.requires` empty in that case.
      if (def.requires && def.requires.length > 0) {
        try {
          await ensureDeps(def.requires);
        } catch (err) {
          if (err instanceof DependencyMissingError) {
            res.status(424).json({ error: err.message, missing: err.missing });
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
        // Walk the cause chain so a registry ToolExecutionError wrapping
        // a DependencyMissingError still maps cleanly to 424 instead of a
        // generic 500. Tools that ensureDep() inside execute() bypass the
        // global preflight; this is their fall-back surface.
        const depErr = findDependencyMissing(err);
        if (depErr) {
          res.status(424).json({ error: depErr.message, missing: depErr.missing });
          return;
        }
        if (err instanceof UnsupportedOperationError) {
          res.status(400).json({ error: err.message });
          return;
        }
        if (err instanceof NotImplementedOnPlatformError) {
          res.status(501).json({
            error: err.message,
            toolId: err.toolId,
            platform: err.platform,
            hint: err.hint,
          });
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
