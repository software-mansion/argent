import express, { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { FAILURE_CODES, type FailureSignal, type Registry } from "@argent/registry";
import { AI_CLIENTS, AI_CLIENT_NAME_PATTERN, type AiTelemetryProps } from "@argent/telemetry";
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

function findDependencyMissing(err: unknown): DependencyMissingError | null {
  return findErrorInCauseChain(err, DependencyMissingError);
}

function findErrorInCauseChain<T extends Error>(
  err: unknown,
  ctor: new (...args: never[]) => T
): T | null {
  let current: unknown = err;
  // Bounded to avoid pathological cycles; in practice the chain is ≤ 2 links.
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    if (current instanceof ctor) return current;
    current = current.cause;
  }
  return null;
}

function extractDeviceArg(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (typeof record.udid === "string") return record.udid;
  if (typeof record.device_id === "string") return record.device_id;
  return null;
}

type InvocationMeta = { platform?: "ios" | "android" } & AiTelemetryProps;
// Only coarse platform context is retained for failure telemetry. The raw
// device id (UDID / serial) is used transiently to infer platform and never
// stored or forwarded.
type HttpFailureMeta = { platform?: "ios" | "android" } & AiTelemetryProps;

function inferPlatform(deviceId: string | null): "ios" | "android" | null {
  if (!deviceId) return null;
  try {
    return resolveDevice(deviceId).platform;
  } catch {
    return null;
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// The MCP server forwards the coarse AI-client identity as request headers (it
// lives in a different process). We re-validate here against the same allowlist /
// pattern the sanitizer enforces, so a misbehaving client can't inject arbitrary
// values into telemetry. The free-form name is only retained when the client is
// `other` — mirroring the producer and the documented `AiTelemetryProps` contract,
// so a recognized (or absent) client can never carry a stray name.
function extractAiTelemetryMeta(req: Request): AiTelemetryProps {
  const meta: AiTelemetryProps = {};
  const client = firstHeader(req.headers["x-argent-ai-client"]);
  if (client && (AI_CLIENTS as readonly string[]).includes(client)) {
    meta.ai_client = client as AiTelemetryProps["ai_client"];
  }
  const clientName = firstHeader(req.headers["x-argent-ai-client-name"]);
  if (meta.ai_client === "other" && clientName && AI_CLIENT_NAME_PATTERN.test(clientName)) {
    meta.ai_client_name = clientName;
  }
  return meta;
}

function extractInvocationMeta(
  hasCapability: boolean,
  data: unknown,
  aiMeta: AiTelemetryProps
): InvocationMeta | null {
  const meta: InvocationMeta = { ...aiMeta };
  if (hasCapability && data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const deviceArg = extractDeviceArg(record);
    if (deviceArg) {
      meta.platform = resolveDevice(deviceArg).platform;
    } else if (typeof record.avdName === "string") {
      meta.platform = "android";
    }
  }
  return Object.keys(meta).length > 0 ? meta : null;
}

// ── HTTP app ────────────────────────────────────────────────────────

export interface HttpAppOptions {
  idleTimeoutMs?: number;
  onIdle?: () => void;
  onShutdown?: () => void;
  /**
   * Address the server is bound to (the launcher's `ARGENT_HOST`). Defaults to
   * loopback. When the operator deliberately binds to a routable address
   * (`argent server start --host <ip>`), that host is added to the Host-header
   * allow-list so legitimate remote clients aren't mistaken for DNS-rebinding.
   * A wildcard bind (0.0.0.0 / ::) disables the guard entirely — the machine is
   * reachable by addresses we can't enumerate, and the operator has explicitly
   * opted into network exposure (and is warned at startup).
   */
  bindHost?: string;
  /** Optional telemetry hook for per-invocation platform/device metadata. */
  recordInvocation?: (toolInvocationId: string, meta: InvocationMeta) => () => void;
  /** Optional telemetry hook for HTTP failures that happen before registry invocation. */
  recordFailure?: (
    toolId: string,
    meta: HttpFailureMeta,
    signal: FailureSignal,
    durationMs: number
  ) => void;
}

export interface HttpAppHandle {
  app: express.Application;
  /** Clears the idle timer. Call on server shutdown. */
  dispose: () => void;
  /** Timestamp of the last tool invocation (ms since epoch). Exposed for testing. */
  getLastActivityAt: () => number;
}

// Loopback hostnames the browser is allowed to address us by. The
// tool-server binds to 127.0.0.1 by default, but a public attacker page that
// briefly DNS-rebinds its own hostname to 127.0.0.1 can still reach us
// — the Host header is the only signal that distinguishes that traffic
// from a legitimate same-origin request, so we gate on it.
const LOOPBACK_HOSTNAMES = ["127.0.0.1", "localhost", "::1"];

function isLoopbackHost(host: string): boolean {
  return host === "" || LOOPBACK_HOSTNAMES.includes(host);
}

// Wildcard binds accept connections on every interface; a client can reach
// them via any of the machine's addresses, which we can't enumerate — so the
// Host guard can't be applied meaningfully and is disabled for this case.
function isWildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "::0";
}

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

  // Hostnames a client is allowed to address us by. Always includes loopback;
  // a non-loopback bind host (`argent server start --host <ip>`) is added so
  // its legitimate clients pass the guard. A wildcard bind disables the guard.
  const bindHost = options?.bindHost ?? "127.0.0.1";
  const hostGuardDisabled = isWildcardHost(bindHost);
  const allowedHostnames = new Set<string>(LOOPBACK_HOSTNAMES);
  if (!isLoopbackHost(bindHost) && !isWildcardHost(bindHost)) {
    allowedHostnames.add(bindHost);
  }

  // Reject requests whose Host header points to anything other than an
  // allowed hostname. Closes the DNS-rebinding bypass, where a public
  // origin's hostname briefly resolves to 127.0.0.1 and the browser dutifully
  // forwards the rebound origin's cookies/CSRF state to us. Runs before the
  // auth gate so a rebound public origin doesn't even reach the token check.
  app.use((req, res, next) => {
    // Server explicitly bound to all interfaces — the guard is moot (see
    // isWildcardHost) and the operator opted into network exposure.
    if (hostGuardDisabled) {
      next();
      return;
    }
    const host = req.headers.host;
    if (!host) {
      res.status(400).json({ error: "Missing Host header" });
      return;
    }
    const hostname = extractHostname(host);
    if (!allowedHostnames.has(hostname)) {
      res.status(403).json({
        error:
          `Refusing request with Host "${host}". The tool-server accepts ` +
          `loopback hostnames (127.0.0.1, localhost, ::1)` +
          (isLoopbackHost(bindHost) ? "" : ` and its bind host (${bindHost})`) +
          ` to defend against DNS-rebinding. If you are reaching this from ` +
          `your own client, use one of those instead of a public hostname.`,
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
  // The /preview subtree is exempt because it is the browser-loaded in-process
  // UI (no token available client-side); fully authenticating it needs an
  // out-of-band UI session and is a deliberate follow-up. The exemption is an
  // exact `/preview` or `/preview/`-prefixed match so a future top-level route
  // like `/preview-status` can't be silently un-gated by a bare startsWith.
  app.use((req, res, next) => {
    if (!expectedToken) {
      next();
      return;
    }
    if (req.path === "/preview" || req.path.startsWith("/preview/")) {
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
        longRunning?: boolean;
      } = {
        name: id,
        description: def?.description ?? "",
        inputSchema: def?.inputSchema ?? { type: "object", properties: {} },
      };
      if (def?.outputHint) entry.outputHint = def.outputHint;
      if (def?.alwaysLoad) entry.alwaysLoad = true;
      if (def?.searchHint) entry.searchHint = def.searchHint;
      if (def?.longRunning) entry.longRunning = true;
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
      const requestStartedAt = performance.now();
      const aiMeta = extractAiTelemetryMeta(req);

      const emitHttpFailure = (
        signal: FailureSignal,
        parsedDataForMeta: unknown = req.body
      ): void => {
        if (!options?.recordFailure) return;
        const failedDeviceArg = extractDeviceArg(parsedDataForMeta);
        const platform = inferPlatform(failedDeviceArg);
        options.recordFailure(
          name,
          {
            ...(platform ? { platform } : {}),
            ...aiMeta,
          },
          signal,
          performance.now() - requestStartedAt
        );
      };

      const def = registry.getTool(name);
      if (!def) {
        emitHttpFailure({
          error_code: FAILURE_CODES.HTTP_TOOL_NOT_FOUND,
          failure_stage: "http_lookup_tool",
          failure_area: "http",
          error_kind: "not_found",
        });
        res.status(404).json({ error: `Tool "${name}" not found` });
        return;
      }

      let parsedData = req.body;
      if (def.zodSchema) {
        const parseResult = def.zodSchema.safeParse(req.body);
        if (!parseResult.success) {
          emitHttpFailure(
            {
              error_code: FAILURE_CODES.HTTP_ZOD_VALIDATION_FAILED,
              failure_stage: "http_zod_validation",
              failure_area: "http",
              error_kind: "validation",
            },
            req.body
          );
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
      const deviceArg = extractDeviceArg(parsedData);
      if (def.capability && deviceArg) {
        try {
          const device = resolveDevice(deviceArg);
          assertSupported(def.id, def.capability, device);
        } catch (err) {
          if (err instanceof UnsupportedOperationError) {
            emitHttpFailure(
              {
                error_code: FAILURE_CODES.HTTP_CAPABILITY_UNSUPPORTED_OPERATION,
                failure_stage: "http_capability_gate",
                failure_area: "http",
                error_kind: "unsupported",
              },
              parsedData
            );
            res.status(400).json({ error: err.message });
            return;
          }
          emitHttpFailure(
            {
              error_code: FAILURE_CODES.HTTP_DEVICE_RESOLUTION_FAILED,
              failure_stage: "http_capability_device_resolution",
              failure_area: "http",
              error_kind: "validation",
            },
            parsedData
          );
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
          return;
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
            emitHttpFailure(
              {
                error_code: FAILURE_CODES.HTTP_DEPENDENCY_PREFLIGHT_MISSING,
                failure_stage: "http_dependency_preflight",
                failure_area: "http",
                error_kind: "dependency_missing",
              },
              parsedData
            );
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

      // Hashing happens in the telemetry listener, not in the HTTP layer.
      const toolInvocationId = randomUUID();
      let releaseInvocationMeta: (() => void) | undefined;
      if (options?.recordInvocation) {
        const invocationMeta = extractInvocationMeta(Boolean(def.capability), parsedData, aiMeta);
        if (invocationMeta) {
          releaseInvocationMeta = options.recordInvocation(toolInvocationId, invocationMeta);
        }
      }

      try {
        const data = await registry.invokeTool(name, parsedData, {
          signal: controller.signal,
          toolInvocationId,
        });
        // Gate on `updateInstallable` (not `updateAvailable`) and advertise the
        // version the resolver would install — both account for the release-age policy.
        const { updateInstallable, currentVersion, installableVersion } = getUpdateState();
        const shouldNotify = updateInstallable && !isUpdateNoteSuppressed();
        if (shouldNotify) {
          // Best-effort: a persistence failure here must not fail the user's tool call.
          // Worst case: the note appears again on the next request.
          try {
            suppressUpdateNote(AUTO_SUPPRESS_MS);
          } catch {
            // ignore
          }
        }
        res.json({
          data,
          ...(shouldNotify
            ? { note: buildUpdateNote(currentVersion, installableVersion ?? "unknown") }
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
        const unsupportedErr = findErrorInCauseChain(err, UnsupportedOperationError);
        if (unsupportedErr) {
          res.status(400).json({ error: unsupportedErr.message });
          return;
        }
        const notImplementedErr = findErrorInCauseChain(err, NotImplementedOnPlatformError);
        if (notImplementedErr) {
          res.status(501).json({
            error: notImplementedErr.message,
            toolId: notImplementedErr.toolId,
            platform: notImplementedErr.platform,
            hint: notImplementedErr.hint,
          });
          return;
        }
        res.status(500).json({ error: formatErrorForAgent(err) });
      } finally {
        releaseInvocationMeta?.();
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
