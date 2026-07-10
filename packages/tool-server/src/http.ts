import express, { Request, Response } from "express";
import bytesUtil from "bytes";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFlagEnabled } from "@argent/configuration-core";
import { randomUUID, createHash } from "node:crypto";
import {
  FAILURE_CODES,
  type FailureSignal,
  type FileInputSpec,
  // The tool-server's coarse *device* platform (TV-agnostic). Telemetry's own
  // Platform (imported below) is a superset that also carries `tvos`/`android-tv`.
  type Platform as DevicePlatform,
  type Registry,
  type ResolvedFileInput,
} from "@argent/registry";
import {
  AI_CLIENTS,
  type AiTelemetryProps,
  type Platform as TelemetryPlatform,
} from "@argent/telemetry";
import { ToolNotFoundError } from "@argent/registry";
import { createIdleTimer, IDLE_CHECK_INTERVAL_MS } from "./utils/idle-timer";
import { DependencyMissingError, ensureDeps } from "./utils/check-deps";
import { formatErrorForAgent } from "./utils/format-error";
import { getUpdateState, isUpdateNoteSuppressed, suppressUpdateNote } from "./utils/update-checker";
import { buildUpdateNote } from "./update-utils";
import { createPreviewRouter } from "./preview";
import { makeArtifactListRoute, makeArtifactRoute } from "./artifacts";
import { FileInputError, resolveFileInputs, type UploadEntry } from "./file-inputs";
import {
  assertSupported,
  NotImplementedOnPlatformError,
  UnsupportedOperationError,
} from "./utils/capability";
import { resolveDevice } from "./utils/device-info";
import { getCachedSimulatorRuntimeKind } from "./utils/ios-devices";
import { getCachedAndroidRuntimeKind } from "./utils/adb";
import type { Server as HttpServer } from "node:http";
import {
  CHROMIUM_CDP_NAMESPACE,
  chromiumCdpRef,
  type ChromiumCdpApi,
} from "./blueprints/chromium-cdp";
import {
  attachChromiumServerWebsocket,
  createChromiumServerRouter,
} from "./chromium-server/http-api";
import { resolveDevice as resolveDeviceForWs } from "./utils/device-info";

const AUTO_SUPPRESS_MS = 30 * 60 * 1000; // 30 minutes

const AUTH_TOKEN_ENV = "ARGENT_AUTH_TOKEN";
const BEARER_PREFIX = "Bearer ";
const ARTIFACTS_LIST_ENDPOINT_FLAG = "artifacts-list-endpoint";

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

// A tool that declares a `featureFlag` is exposed (listed + invocable) only
// while that flag is enabled. Re-evaluated on every request — reading the tiny
// `~/.argent/flags.json` (and project override) each time — so toggling
// `argent enable/disable <flag>` takes effect on the next `tools/list` without
// restarting the long-lived tool-server. Tools without a `featureFlag` are
// always exposed (no flag read). A `hideWhen` predicate (also re-checked here per
// request) hides a tool against live server state even when its flag is on — used
// so `await_user_selection` vanishes during an `argent lens` CLI session.
function isToolExposed(
  def: { featureFlag?: string; hideWhen?: () => boolean } | undefined
): boolean {
  if (!def) return false;
  if (def.featureFlag && !isFlagEnabled(def.featureFlag)) return false;
  if (def.hideWhen?.()) return false;
  return true;
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

type InvocationMeta = { platform?: TelemetryPlatform } & AiTelemetryProps;
// Only coarse platform context is retained for failure telemetry. The raw
// device id (UDID / serial) is used transiently to infer platform and never
// stored or forwarded.
type HttpFailureMeta = { platform?: TelemetryPlatform } & AiTelemetryProps;

/**
 * Split a TV target out of its base mobile platform for telemetry, using only
 * the already-memoized runtime kind — never a fresh `simctl`/`adb` probe, since
 * this runs on the per-tool-call hot path. A tvOS simulator and an iPhone
 * simulator share the same UDID shape (both classify as `ios`); an Android TV
 * emulator and a phone share the `emulator-NNNN` serial shape (both `android`).
 * The device platform stays coarse (a TV is a `runtimeKind`, not its own device
 * platform — capability gating and dispatch are TV-agnostic); we refine it to
 * `tvos` / `android-tv` here for reporting only when the cache already knows the
 * kind, and leave it coarse otherwise. The first tool call on a device may land
 * before the cache is warm and report the base platform; subsequent calls, once
 * a describe/interaction path has warmed the runtime-kind cache (the per-platform
 * warmers are listed on `getCachedSimulatorRuntimeKind` /
 * `getCachedAndroidRuntimeKind`), report the TV variant.
 */
function refineTvPlatform(basePlatform: DevicePlatform, deviceId: string): TelemetryPlatform {
  if (basePlatform === "ios" && getCachedSimulatorRuntimeKind(deviceId) === "tv") {
    return "tvos";
  }
  if (basePlatform === "android" && getCachedAndroidRuntimeKind(deviceId) === "tv") {
    return "android-tv";
  }
  return basePlatform;
}

function inferPlatform(deviceId: string | null): TelemetryPlatform | null {
  if (!deviceId) return null;
  try {
    return refineTvPlatform(resolveDevice(deviceId).platform, deviceId);
  } catch {
    return null;
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// The MCP server forwards the coarse AI-client identity as a request header (it
// lives in a different process). We re-validate here against the same allowlist
// the sanitizer enforces, so a misbehaving client can't inject an arbitrary value
// into telemetry. Only the coarse client slug is carried — we never record the
// raw client name.
function extractAiTelemetryMeta(req: Request): AiTelemetryProps {
  const meta: AiTelemetryProps = {};
  const client = firstHeader(req.headers["x-argent-ai-client"]);
  if (client && (AI_CLIENTS as readonly string[]).includes(client)) {
    meta.ai_client = client as AiTelemetryProps["ai_client"];
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
    const platform = platformFromArgs(data);
    if (platform) meta.platform = platform;
  }
  return Object.keys(meta).length > 0 ? meta : null;
}

/**
 * Telemetry platform from a tool call's device arg, or null when it carries none.
 * A `udid` / `device_id` resolves through the runtime-kind cache and refines to
 * `tvos` / `android-tv` once that cache is warm (coarse `ios` / `android` until
 * then); only the `avdName`-only fallback is unconditionally coarse.
 */
function platformFromArgs(data: unknown): TelemetryPlatform | null {
  if (!data || typeof data !== "object") return null;
  const deviceArg = extractDeviceArg(data);
  if (deviceArg) return inferPlatform(deviceArg) ?? null;
  // An `avdName`-only call (boot-device before the emulator exists) has no serial
  // to resolve a runtime kind from, so it stays the coarse `android` platform.
  // Once the emulator is up, later `udid` / `device_id` calls refine an Android TV
  // AVD to `android-tv` — from the call after describe/launch has warmed the cache,
  // not the first (see `refineTvPlatform`).
  if (typeof (data as Record<string, unknown>).avdName === "string") return "android";
  return null;
}

/**
 * Attribution for a sub-tool an orchestrator dispatches: the outer request's AI
 * client is inherited unchanged, but the platform is re-derived from the child's
 * OWN device arg. Orchestrators like flow-execute carry no platform (and a flow
 * can span several devices), so the child's `udid` is the only correct source;
 * the parent's platform is the fallback when the child has no device arg.
 */
function deriveChildInvocationMeta(parentMeta: InvocationMeta, childArgs: unknown): InvocationMeta {
  const childPlatform = platformFromArgs(childArgs);
  return childPlatform ? { ...parentMeta, platform: childPlatform } : parentMeta;
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
  /** Max bytes accepted by a single `POST /upload` (tar-upload inputs). Defaults to 2 GiB. */
  maxUploadBytes?: number;
  /** Max total bytes of unconsumed uploads held on disk. Defaults to 8 GiB. */
  maxPendingUploadBytes?: number;
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
  /** Attach the per-Chromium-device WebSocket upgrade handler to the live
   * http.Server. Called once `app.listen()` has been invoked and the server
   * is bound. Splitting this out from `createHttpApp` keeps construction
   * synchronous — the WS upgrade is the only part that needs the Node server
   * instance rather than the Express app. */
  attachChromiumWebsockets: (server: HttpServer) => void;
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

// Hostname of an `Origin` request header ("http://127.0.0.1:5173" → "127.0.0.1").
// Opaque origins (the literal "null" from sandboxed iframes / file:// pages) and
// malformed values return null so they fail the allow-list check.
function hostnameFromOrigin(origin: string): string | null {
  const schemeEnd = origin.indexOf("://");
  if (schemeEnd === -1) return null;
  return extractHostname(origin.slice(schemeEnd + 3));
}

// Authorize a WebSocket upgrade for the browser-facing control channels (e.g.
// the Chromium-control WS). A WS handshake bypasses the Express Host/auth
// middleware — the `ws` library owns the upgrade — so the same defenses are
// re-applied here. The in-process preview UI is browser-loaded and can't carry
// a Bearer token (like the rest of the /preview surface), so the guard is
// origin/host-based rather than token-based:
//   • Host guard — same loopback/bind-host allow-list as HTTP requests, closing
//     the DNS-rebinding bypass.
//   • Origin guard (anti-CSWSH) — browsers always send `Origin` on a WS
//     handshake; accept only our own loopback/bind-host origin. A non-browser
//     client (Node `ws`) sends no Origin and is already constrained by the Host
//     guard above.
// A wildcard bind disables the guard (operator opted into network exposure),
// matching the HTTP Host-guard behavior.
export function isWebsocketUpgradeAllowed(
  headers: { host?: string; origin?: string },
  policy: { allowedHostnames: ReadonlySet<string>; hostGuardDisabled: boolean }
): boolean {
  if (policy.hostGuardDisabled) return true;
  const host = headers.host;
  if (!host || !policy.allowedHostnames.has(extractHostname(host))) return false;
  const origin = headers.origin;
  if (origin !== undefined) {
    const originHost = hostnameFromOrigin(origin);
    if (!originHost || !policy.allowedHostnames.has(originHost)) return false;
  }
  return true;
}

// The tool call that consumes an upload arrives right after it (same client
// invocation), so the TTL only has to outlive that gap — generously.
const UPLOAD_TTL_MS = 15 * 60 * 1000; // 15 minutes
// Bounds a single tar-upload so a bad client can't fill the host disk.
const MAX_UPLOAD_STREAM_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
// Bounds the total of unconsumed uploads, so many small ones can't do the same.
const MAX_PENDING_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024; // 8 GiB

export function createHttpApp(registry: Registry, options?: HttpAppOptions): HttpAppHandle {
  const app = express();
  // 48mb: file-input wrappers may inline base64 file content (saved PNG
  // baselines, flow YAMLs) when the client is remote. Bounds the whole encoded
  // request; the decoded per-file ceiling is enforced in file-inputs.ts.
  app.use(express.json({ limit: "48mb" }));

  const maxUploadBytes = options?.maxUploadBytes ?? MAX_UPLOAD_STREAM_BYTES;
  const maxPendingUploadBytes = options?.maxPendingUploadBytes ?? MAX_PENDING_UPLOAD_BYTES;

  // Pending tar-upload archives, keyed by uploadId. Consumed by the first tool
  // call that references them; the TTL sweeper clears orphans from aborted or
  // failed calls.
  const uploads = new Map<string, UploadEntry & { expireAt: number; bytes: number }>();
  // Bytes already written to disk (settled Map) plus bytes of streams still
  // in flight, so the cap holds against concurrent uploads — not just settled
  // ones, which a burst of parallel requests would otherwise slip past.
  let inFlightUploadBytes = 0;
  const pendingUploadBytes = (): number =>
    inFlightUploadBytes + [...uploads.values()].reduce((total, e) => total + e.bytes, 0);
  const uploadSweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of uploads) {
      if (entry.expireAt < now) {
        uploads.delete(id);
        rm(entry.tarPath, { force: true }).catch(() => {});
      }
    }
  }, 60_000);
  uploadSweeper.unref();

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

  // Artifact retrieval: streams files produced by tools (screenshots, profiler
  // exports) over the remote-aware HTTP boundary so the MCP client can fetch
  // them via TOOLS_URL instead of an unreachable 127.0.0.1 host path/URL.
  if (isFlagEnabled(ARTIFACTS_LIST_ENDPOINT_FLAG)) {
    app.get("/artifacts", makeArtifactListRoute(registry));
  }
  app.get("/artifacts/:id", makeArtifactRoute(registry));

  // Per-Chromium-device HTTP surface that mirrors sim-server's API: a
  // `/chromium-server/:id/api/*` namespace plus `/stream.mjpeg` and `/viewport`.
  // The router is mounted lazily — the first request for a given id resolves
  // the registry service (kicking off the CDP connection) and then forwards
  // every subsequent request to that already-warm session. Like /preview, this
  // surface is NOT advertised to MCP agents; tools remain the canonical way to
  // drive Chromium from an LLM. The HTTP surface is for non-agent consumers
  // (preview UI, integration tests, custom dashboards).
  app.use("/chromium-server/:deviceId", async (req: Request, res: Response, next) => {
    idleTimer.touch();
    const deviceId = req.params.deviceId as string;
    const device = resolveDevice(deviceId);
    if (device.platform !== "chromium") {
      res.status(400).json({
        error: `Device id "${deviceId}" is not a Chromium device. Use list-devices to find one.`,
      });
      return;
    }
    let server: ChromiumCdpApi;
    try {
      const ref = chromiumCdpRef(device);
      server = await registry.resolveService<ChromiumCdpApi>(ref.urn, ref.options);
    } catch (err) {
      res.status(502).json({
        error: `Could not resolve Chromium CDP session for ${deviceId}: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    // Lazily build the router per-device. Each ChromiumServer is stable for
    // the lifetime of the registry entry, so caching the router would only
    // save a few object allocations per request; building inline keeps the
    // code simple and the failure surface obvious.
    const router = createChromiumServerRouter(server.server);
    router(req, res, next);
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

  // Streaming upload for tar-upload inputs: the client tars a file or dir and
  // streams it here before the tool call. express.json() ignores this body
  // (wrong Content-Type), so we pipe it straight to disk.
  app.post("/upload", (req: Request, res: Response) => {
    idleTimer.touch();
    if (pendingUploadBytes() >= maxPendingUploadBytes) {
      res.status(507).json({
        error:
          `Pending uploads exceed the ${bytesUtil(maxPendingUploadBytes, { unitSeparator: " " })} ` +
          `storage limit; retry once earlier uploads are consumed.`,
      });
      return;
    }
    const id = randomUUID();
    const tarPath = join(tmpdir(), `argent-upload-${id}.tar.gz`);
    const ws = createWriteStream(tarPath);

    let received = 0;
    let released = false;
    // Drop this stream's in-flight contribution exactly once (on success it
    // moves into the Map; on failure it's discarded), so the running total
    // can't leak or double-count.
    const releaseInFlight = (): void => {
      if (released) return;
      released = true;
      inFlightUploadBytes -= received;
    };

    const abort = (status: number, message: string): void => {
      releaseInFlight();
      ws.destroy();
      rm(tarPath, { force: true }).catch(() => {});
      if (!res.headersSent) res.status(status).json({ error: message });
    };

    const digest = createHash("sha256");
    req.on("data", (chunk: Buffer) => {
      // Once released (aborted or finished) stop accounting — the socket may
      // keep flowing after ws.destroy(), and re-counting would leak the
      // in-flight total upward and eventually 507 every upload.
      if (released) return;
      received += chunk.length;
      inFlightUploadBytes += chunk.length;
      digest.update(chunk);
      if (received > maxUploadBytes) {
        abort(
          413,
          `Upload exceeds the ${bytesUtil(maxUploadBytes, { unitSeparator: " " })} limit.`
        );
      } else if (pendingUploadBytes() > maxPendingUploadBytes) {
        abort(
          507,
          `Pending uploads exceed the ${bytesUtil(maxPendingUploadBytes, { unitSeparator: " " })} ` +
            `storage limit; retry once earlier uploads are consumed.`
        );
      }
    });
    req.pipe(ws);
    // pipe() leaves ws open if the client disconnects mid-upload.
    req.on("close", () => {
      if (req.readableEnded) return;
      releaseInFlight();
      ws.destroy();
      rm(tarPath, { force: true }).catch(() => {});
    });
    ws.on("finish", () => {
      releaseInFlight();
      if (res.headersSent) return;
      uploads.set(id, {
        tarPath,
        sha256: digest.digest("hex"),
        expireAt: Date.now() + UPLOAD_TTL_MS,
        bytes: received,
      });
      res.json({ uploadId: id });
    });
    ws.on("error", (err: Error) => abort(500, err.message));
  });

  app.get("/tools", (_req: Request, res: Response) => {
    idleTimer.touch();
    const snapshot = registry.getSnapshot();
    const tools = snapshot.tools
      .map((id) => registry.getTool(id))
      // Hide feature-flagged tools whose flag is currently off.
      .filter((def): def is NonNullable<typeof def> => isToolExposed(def))
      .map((def) => {
        const entry: {
          name: string;
          description: string;
          inputSchema: Record<string, unknown>;
          outputHint?: string;
          fileInputs?: FileInputSpec[];
          alwaysLoad?: boolean;
          searchHint?: string;
          longRunning?: boolean;
        } = {
          name: def.id,
          description: def.description ?? "",
          inputSchema: def.inputSchema ?? { type: "object", properties: {} },
        };
        if (def.outputHint) entry.outputHint = def.outputHint;
        if (def.fileInputs && def.fileInputs.length > 0) entry.fileInputs = def.fileInputs;
        if (def.alwaysLoad) entry.alwaysLoad = true;
        if (def.searchHint) entry.searchHint = def.searchHint;
        if (def.longRunning) entry.longRunning = true;
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
      const name = req.params.name as string;
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
      // A feature-flagged tool with its flag off is hidden from /tools and
      // must not be invocable either — report it as not found (re-checked here
      // per call, so the gate tracks `argent enable/disable` without a restart).
      if (!isToolExposed(def)) {
        res.status(404).json({ error: `Tool "${name}" not found` });
        return;
      }

      // File boundary: turn any client file-input wrappers back into plain
      // server-readable paths BEFORE schema validation, so the tool's zod
      // schema only ever sees the string params it declares. 422 on a file
      // that is reachable neither in place nor via uploaded content.
      // Type kept as `any` (matching req.body) so the downstream optional-chained
      // access below — parsedData?.udid / parsedData?.device_id — type-checks as
      // it did before. The `= req.body` initializer was dead: the try always
      // assigns bodyArgs before it is read, and the catch never falls through.
      let bodyArgs: any;
      let resolvedFileInputs: Record<string, ResolvedFileInput> | undefined;
      try {
        const resolved = await resolveFileInputs(def, req.body, (id) => {
          const entry = uploads.get(id);
          if (entry) uploads.delete(id);
          return entry;
        });
        bodyArgs = resolved.args;
        resolvedFileInputs = resolved.fileInputs;
        // Materialized uploads are call-scoped: remove them once the response
        // settles, whichever way it ends (success, validation failure, tool
        // error, or client abort).
        res.once("close", () => void resolved.cleanup());
      } catch (err) {
        if (err instanceof FileInputError) {
          res.status(422).json({ error: err.message });
          return;
        }
        throw err;
      }

      let parsedData = bodyArgs;
      if (def.zodSchema) {
        const parseResult = def.zodSchema.safeParse(bodyArgs);
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
          // Reaching here means resolveDevice/assertSupported threw something
          // other than UnsupportedOperationError (today only a custom supports()
          // refiner can) — an internal fault, not a client validation error, so
          // surface it as 500/unknown rather than mislabeling it 400/validation.
          emitHttpFailure(
            {
              error_code: FAILURE_CODES.HTTP_DEVICE_RESOLUTION_FAILED,
              failure_stage: "http_capability_device_resolution",
              failure_area: "http",
              error_kind: "unknown",
            },
            parsedData
          );
          res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
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

      // A long-running tool (e.g. await_user_selection) can legitimately hold
      // the request open for many minutes while it waits on external input.
      // An in-flight invocation IS activity, so keep the idle timer warm for
      // its whole duration — otherwise the auto-shutdown reaps the server out
      // from under the still-open request. Cleared as soon as it settles.
      const keepAlive =
        def.longRunning && options?.idleTimeoutMs && options.idleTimeoutMs > 0
          ? setInterval(() => idleTimer.touch(), Math.max(1_000, IDLE_CHECK_INTERVAL_MS / 2))
          : null;
      if (keepAlive) keepAlive.unref?.();

      // Hashing happens in the telemetry listener, not in the HTTP layer.
      const toolInvocationId = randomUUID();
      let releaseInvocationMeta: (() => void) | undefined;
      // A recorder bound to THIS request's attribution, handed to orchestrator
      // tools (run-sequence, flow-execute) so the sub-tools they dispatch
      // directly through the registry inherit the same ai_client / platform
      // instead of being recorded as anonymous. Only present when there is
      // attribution worth propagating.
      let recordChildInvocation:
        | ((childInvocationId: string, childArgs?: unknown) => () => void)
        | undefined;
      const recordInvocation = options?.recordInvocation;
      if (recordInvocation) {
        const invocationMeta = extractInvocationMeta(Boolean(def.capability), parsedData, aiMeta);
        if (invocationMeta) {
          releaseInvocationMeta = recordInvocation(toolInvocationId, invocationMeta);
          recordChildInvocation = (childInvocationId, childArgs) =>
            recordInvocation(
              childInvocationId,
              deriveChildInvocationMeta(invocationMeta, childArgs)
            );
        }
      }

      try {
        const data = await registry.invokeTool(name, parsedData, {
          signal: controller.signal,
          ...(resolvedFileInputs ? { fileInputs: resolvedFileInputs } : {}),
          toolInvocationId,
          ...(recordChildInvocation ? { recordChildInvocation } : {}),
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
        // Unwrap the cause chain: these are thrown from inside execute() / a
        // service factory and reach here wrapped in ToolExecutionError, so a
        // top-level instanceof would miss them and fall through to a 500.
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
        if (keepAlive) clearInterval(keepAlive);
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
    dispose: () => {
      idleTimer.dispose();
      clearInterval(uploadSweeper);
      for (const entry of uploads.values()) rm(entry.tarPath, { force: true }).catch(() => {});
      uploads.clear();
    },
    getLastActivityAt: () => idleTimer.getLastActivityAt(),
    attachChromiumWebsockets: (httpServer: HttpServer) => {
      attachChromiumServerWebsocket(
        httpServer,
        "/chromium-server/",
        (req) => {
          // URL shape: /chromium-server/<deviceId>/ws
          const match = (req.url ?? "").match(/^\/chromium-server\/([^/]+)\/ws(?:[?#]|$)/);
          if (!match) return null;
          const deviceId = decodeURIComponent(match[1]!);
          const device = resolveDeviceForWs(deviceId);
          if (device.platform !== "chromium") return null;
          // The CDP session must already be resolved (the per-device REST routes
          // resolve it lazily on first hit). For the WS endpoint we look at the
          // current registry snapshot — if no session is open, refuse the
          // upgrade instead of triggering a slow CDP connect inside the upgrade
          // handler (which would block the TCP socket).
          const urn = `${CHROMIUM_CDP_NAMESPACE}:${deviceId}`;
          const snapshot = registry.getSnapshot();
          if (!snapshot.services.has(urn)) return null;
          // Use the synchronous getter on the registry rather than the async
          // resolveService — by this point the service is guaranteed to exist.
          const node = (
            registry as unknown as {
              services: Map<string, { instance: { api: ChromiumCdpApi } | null }>;
            }
          ).services.get(urn);
          const api = node?.instance?.api;
          if (!api) return null;
          return api.server;
        },
        (req) => isWebsocketUpgradeAllowed(req.headers, { allowedHostnames, hostGuardDisabled })
      );
    },
  };
}
