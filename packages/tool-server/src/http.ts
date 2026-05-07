import express, { Request, Response } from "express";
import type { Registry } from "@argent/registry";
import { ToolNotFoundError } from "@argent/registry";
import { createIdleTimer } from "./utils/idle-timer";
import { formatErrorForAgent } from "./utils/format-error";
import { getUpdateState, isUpdateNoteSuppressed, suppressUpdateNote } from "./utils/update-checker";
import { buildUpdateNote } from "./update-utils";
import { createPreviewRouter } from "./preview";
import { DependencyMissingError, ensureDeps } from "./utils/check-deps";
import {
  assertSupported,
  NotImplementedOnPlatformError,
  UnsupportedOperationError,
} from "./utils/capability";
import { resolveDevice } from "./utils/device-info";

const AUTO_SUPPRESS_MS = 30 * 60 * 1000; // 30 minutes

const AUTH_TOKEN_ENV = "ARGENT_AUTH_TOKEN";
const BEARER_PREFIX = "Bearer ";

// Constant-time comparison so a leaked token can't be recovered byte-by-byte
// via response-timing measurements. Both strings must be the same length to
// avoid leaking length information either; we pad/truncate to a fixed compare
// width of the expected token's length.
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) return null;
  return authHeader.slice(BEARER_PREFIX.length).trim() || null;
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

// Loopback hostnames the browser is allowed to address us by. The
// tool-server binds to 127.0.0.1 only, but a public attacker page that
// briefly DNS-rebinds its own hostname to 127.0.0.1 can still reach us
// — the Host header is the only signal that distinguishes that traffic
// from a legitimate same-origin request, so we gate on it.
const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

function extractHostname(host: string): string {
  // IPv6 literals are bracketed: "[::1]:8080" → "::1"
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(1, end);
  }
  const colon = host.indexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

export function createHttpApp(registry: Registry, options?: HttpAppOptions): HttpAppHandle {
  const app = express();
  app.use(express.json());

  const idleTimer = createIdleTimer(options?.idleTimeoutMs ?? 0, options?.onIdle);

  // Reject requests whose Host header points to anything other than a
  // loopback hostname. Closes the DNS-rebinding bypass, where a public
  // origin's hostname briefly resolves to 127.0.0.1 and the browser dutifully
  // forwards the rebound origin's cookies/CSRF state to us. Runs before the
  // auth gate so a rebound public origin doesn't even reach the token check.
  app.use((req, res, next) => {
    const host = req.headers.host;
    if (!host) {
      res.status(400).json({ error: "Missing Host header" });
      return;
    }
    const hostname = extractHostname(host);
    if (!ALLOWED_HOSTNAMES.has(hostname)) {
      res.status(403).json({
        error:
          `Refusing request with Host "${host}". The tool-server only accepts ` +
          `loopback hostnames (127.0.0.1, localhost, ::1) to defend against ` +
          `DNS-rebinding. If you are reaching this from your own client, use ` +
          `127.0.0.1 instead of a public hostname.`,
      });
      return;
    }
    next();
  });

  // Auth token snapshotted at startup. The launcher generates this and passes
  // it in via env (see ensureToolsServer). Empty string ⇒ auth disabled, which
  // is supported only for local dev (`npm run dev`); in that case stderr gets
  // a one-shot warning so the operator notices.
  const expectedToken = process.env[AUTH_TOKEN_ENV] ?? "";
  if (!expectedToken) {
    process.stderr.write(
      `[tool-server] WARNING: ${AUTH_TOKEN_ENV} is not set; running with authentication disabled. ` +
        `Any local process can drive the tool-server. This is only safe for development.\n`
    );
  }

  // Authorization gate. Runs after Host validation and before any handler.
  // /preview is intentionally exempt because it is user-facing and was not
  // gated before; tightening it is a follow-up.
  app.use((req, res, next) => {
    if (!expectedToken) {
      next();
      return;
    }
    if (req.path.startsWith("/preview")) {
      next();
      return;
    }
    const provided = extractBearerToken(req.headers.authorization);
    if (!provided || !constantTimeEqual(provided, expectedToken)) {
      res.status(401).json({
        error:
          "Missing or invalid Authorization header. Tool-server requires " +
          "`Authorization: Bearer <token>` where <token> matches the value in " +
          "~/.argent/tool-server.json.",
      });
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

      // Capability gate fires BEFORE the global requires preflight: an
      // android serial calling an iOS-only tool should get a clean
      // "unsupported on android" error, not a misleading "xcrun missing".
      // Cross-platform tools double-check inside their dispatch helper, so
      // non-HTTP callers (run-sequence, flow-run) are also covered.
      if (def.capability && parsedData && typeof parsedData.udid === "string") {
        try {
          const device = resolveDevice(parsedData.udid);
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
        if (err instanceof DependencyMissingError) {
          res.status(424).json({ error: err.message, missing: err.missing });
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
