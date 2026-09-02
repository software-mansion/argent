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
  describeParamIssues,
  getFailureSignal,
  type FailureSignal,
  type FileInputSpec,
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
import {
  buildScreenRecordingNote,
  getActiveScreenRecordings,
} from "./utils/screen-recording-reminder";
import { createPreviewRouter } from "./preview";
import { makeArtifactListRoute, makeArtifactRoute } from "./artifacts";
import { FileInputError, resolveFileInputs, type UploadEntry } from "./file-inputs";
import {
  assertSupported,
  InvalidToolInputError,
  NotImplementedOnPlatformError,
  UnsupportedOperationError,
} from "./utils/capability";
import { resolveDevice } from "./utils/device-info";
import { canonicalDeviceId } from "./utils/debugger/device-alias";
import { refineTvPlatform } from "./utils/telemetry-platform";
import { deriveInvalidParams } from "./utils/invalid-params";
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
import { RESULT_NOTE_KEY } from "./tools/screenshot/dropped-geometry";

const AUTO_SUPPRESS_MS = 30 * 60 * 1000; // 30 minutes

const AUTH_TOKEN_ENV = "ARGENT_AUTH_TOKEN";
const BEARER_PREFIX = "Bearer ";
const ARTIFACTS_LIST_ENDPOINT_FLAG = "artifacts-list-endpoint";

// Constant-time comparison so a leaked token can't be recovered byte-by-byte
// via response-timing measurements.
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

// Re-evaluated per request (each call re-reads `~/.argent/flags.json` and the
// project override), so `argent enable/disable <flag>` takes effect without
// restarting the long-lived tool-server. `hideWhen` hides a tool against live
// server state even when its flag is on — `await_user_selection` vanishes during
// an `argent lens` CLI session.
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

function omitKeys(args: unknown, keys: readonly string[]): unknown {
  if (keys.length === 0 || args === null || typeof args !== "object" || Array.isArray(args)) {
    return args;
  }
  const copy = { ...(args as Record<string, unknown>) };
  for (const key of keys) delete copy[key];
  return copy;
}

/**
 * Wire-safe failure classification, so a caller can tell a per-request rejection
 * (e.g. `error_kind: "validation"`) from an infra fault without parsing the
 * message.
 */
function errorSignalFields(err: unknown): { error_code?: string; error_kind?: string } {
  const signal = getFailureSignal(err);
  return signal ? { error_code: signal.error_code, error_kind: signal.error_kind } : {};
}

/**
 * Flatten a tool failure to the message the status-mapped JSON response would
 * have carried: in NDJSON mode the 200 is already on the wire, so the error must
 * travel in-band as the stream's terminal line.
 */
function streamErrorMessage(err: unknown): string {
  if (err instanceof ToolNotFoundError) return err.message;
  const depErr = findDependencyMissing(err);
  if (depErr) return depErr.message;
  const unsupportedErr = findErrorInCauseChain(err, UnsupportedOperationError);
  if (unsupportedErr) return unsupportedErr.message;
  const notImplementedErr = findErrorInCauseChain(err, NotImplementedOnPlatformError);
  if (notImplementedErr) return notImplementedErr.message;
  return formatErrorForAgent(err);
}

function findErrorInCauseChain<T extends Error>(
  err: unknown,
  ctor: new (...args: never[]) => T
): T | null {
  let current: unknown = err;
  // Bounded against cyclic `.cause` chains.
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
  // `devices: string[]` is a third spelling, used only by
  // `stop-all-simulator-servers`' scoped teardown. A call can name several
  // devices of different platforms; the first is enough for the coarse
  // telemetry platform.
  if (Array.isArray(record.devices) && typeof record.devices[0] === "string") {
    return record.devices[0];
  }
  return null;
}

type InvocationMeta = { platform?: TelemetryPlatform } & AiTelemetryProps;
// Coarse context only: the raw device id (UDID / serial) infers a platform and is
// never stored or forwarded; invalid_params carries schema-declared parameter
// NAMES only (see deriveInvalidParams), never values or user-typed keys.
type HttpFailureMeta = {
  platform?: TelemetryPlatform;
  invalid_params?: string[];
} & AiTelemetryProps;

function inferPlatform(deviceId: string | null): TelemetryPlatform | null {
  if (!deviceId) return null;
  try {
    // Telemetry-only: rewrite a forwarded Metro logicalDeviceId back to the id
    // the caller connected with, so `tool:*` and `debugger:tool_outcome` report
    // the same platform for one invocation — the opaque hex handle would
    // otherwise shape-classify as android. Unaliased ids pass through unchanged.
    const canonical = canonicalDeviceId(deviceId) ?? deviceId;
    return refineTvPlatform(resolveDevice(canonical).platform, canonical);
  } catch {
    return null;
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// The MCP server (a different process) forwards the coarse AI-client identity as
// a request header. Re-validated here against the same allowlist the sanitizer
// enforces, so a misbehaving client can't inject an arbitrary value into
// telemetry; the raw client name is never recorded.
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
 * A device id refines to `tvos` / `android-tv` once the runtime-kind cache is warm
 * (coarse `ios` / `android` until then); the `avdName`-only fallback is always
 * coarse.
 * Exported for tests (http-platform-alias.test.ts).
 */
export function platformFromArgs(data: unknown): TelemetryPlatform | null {
  if (!data || typeof data !== "object") return null;
  const deviceArg = extractDeviceArg(data);
  if (deviceArg) return inferPlatform(deviceArg) ?? null;
  // An `avdName`-only call (boot-device before the emulator exists) has no serial
  // to resolve a runtime kind from, so it stays coarse `android`; later `udid` /
  // `device_id` calls refine an Android TV AVD once the cache is warm.
  if (typeof (data as Record<string, unknown>).avdName === "string") return "android";
  return null;
}

/**
 * Attribution for a sub-tool an orchestrator dispatches: the AI client is
 * inherited, but the platform is re-derived from the child's OWN device arg.
 * Orchestrators like flow-execute carry no platform (and a flow can span several
 * devices), so the parent's platform is only the fallback.
 */
function deriveChildInvocationMeta(parentMeta: InvocationMeta, childArgs: unknown): InvocationMeta {
  const childPlatform = platformFromArgs(childArgs);
  return childPlatform ? { ...parentMeta, platform: childPlatform } : parentMeta;
}

interface HttpAppOptions {
  idleTimeoutMs?: number;
  onIdle?: () => void;
  onShutdown?: () => void;
  /**
   * Address the server is bound to (the launcher's `ARGENT_HOST`). Defaults to
   * loopback. A routable bind host (`argent server start --host <ip>`) is added to
   * the Host-header allow-list so legitimate remote clients aren't mistaken for
   * DNS-rebinding. A wildcard bind (0.0.0.0 / ::) disables the guard entirely: the
   * reachable addresses can't be enumerated, and the operator opted in.
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
   * http.Server, once it is bound. Split out of `createHttpApp` so construction
   * stays synchronous — the WS upgrade is the only part needing the Node server
   * instance rather than the Express app. */
  attachChromiumWebsockets: (server: HttpServer) => void;
}

// Loopback hostnames the browser is allowed to address us by. A public attacker
// page that briefly DNS-rebinds its own hostname to 127.0.0.1 still reaches us,
// and the Host header is the only signal separating that traffic from a
// legitimate same-origin request.
const LOOPBACK_HOSTNAMES = ["127.0.0.1", "localhost", "::1"];

function isLoopbackHost(host: string): boolean {
  return host === "" || LOOPBACK_HOSTNAMES.includes(host);
}

// A wildcard bind is reachable via any of the machine's addresses, which we can't
// enumerate — so the Host guard can't be applied and is disabled for that case.
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
// Opaque origins (the literal "null") and malformed values return null so they
// fail the allow-list check.
function hostnameFromOrigin(origin: string): string | null {
  const schemeEnd = origin.indexOf("://");
  if (schemeEnd === -1) return null;
  return extractHostname(origin.slice(schemeEnd + 3));
}

// A WS handshake bypasses the Express Host/auth middleware — the `ws` library owns
// the upgrade — so the same defenses are re-applied here. The browser-loaded
// preview UI can't carry a Bearer token, so the guard is origin/host-based: the
// Host allow-list closes the DNS-rebinding bypass, and the Origin check
// (anti-CSWSH) accepts only our own origin — a non-browser client sends no Origin
// and is already constrained by the Host guard. A wildcard bind disables both.
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

// The tool call that consumes an upload arrives right after it, so the TTL only
// has to outlive that gap.
const UPLOAD_TTL_MS = 15 * 60 * 1000; // 15 minutes
// Bounds a single tar-upload so a bad client can't fill the host disk.
const MAX_UPLOAD_STREAM_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
// Bounds the total of unconsumed uploads, so many small ones can't do the same.
const MAX_PENDING_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024; // 8 GiB

/**
 * Pull a tool's per-call note off its result so it can ride the response
 * envelope. Mutates `data` so the reserved key never reaches the client, where
 * it would otherwise surface in `--json` output and in non-image results. The
 * key is stripped whatever its value; only a non-empty string becomes a note.
 */
function takeToolNote(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const bag = data as Record<string, unknown>;
  if (!(RESULT_NOTE_KEY in bag)) return undefined;
  const note = bag[RESULT_NOTE_KEY];
  delete bag[RESULT_NOTE_KEY];
  return typeof note === "string" && note.length > 0 ? note : undefined;
}

export function createHttpApp(registry: Registry, options?: HttpAppOptions): HttpAppHandle {
  const app = express();
  // 48mb: file-input wrappers may inline base64 file content when the client is
  // remote. Bounds the whole encoded request; the decoded per-file ceiling is
  // enforced in file-inputs.ts.
  app.use(express.json({ limit: "48mb" }));

  const maxUploadBytes = options?.maxUploadBytes ?? MAX_UPLOAD_STREAM_BYTES;
  const maxPendingUploadBytes = options?.maxPendingUploadBytes ?? MAX_PENDING_UPLOAD_BYTES;

  // Consumed by the first tool call that references them; the TTL sweeper clears
  // orphans from aborted or failed calls.
  const uploads = new Map<string, UploadEntry & { expireAt: number; bytes: number }>();
  // Settled bytes plus bytes of streams still in flight, so the cap holds against
  // a burst of parallel uploads instead of only settled ones.
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

  // A non-loopback bind host is added so its legitimate clients pass the guard;
  // a wildcard bind disables the guard.
  const bindHost = options?.bindHost ?? "127.0.0.1";
  const hostGuardDisabled = isWildcardHost(bindHost);
  const allowedHostnames = new Set<string>(LOOPBACK_HOSTNAMES);
  if (!isLoopbackHost(bindHost) && !isWildcardHost(bindHost)) {
    allowedHostnames.add(bindHost);
  }

  // Closes the DNS-rebinding bypass, where a public origin's hostname briefly
  // resolves to 127.0.0.1 and the browser forwards that origin's cookies/CSRF
  // state to us. Runs before the auth gate so a rebound public origin doesn't even
  // reach the token check.
  app.use((req, res, next) => {
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

  // Snapshotted at startup; the launcher generates it and passes it in via env
  // (see ensureToolsServer). Empty string ⇒ auth disabled, supported only for
  // local dev (`npm run dev`), which is why stderr gets a one-shot warning.
  const expectedToken = process.env[AUTH_TOKEN_ENV] ?? "";
  if (!expectedToken) {
    process.stderr.write(
      `[tool-server] WARNING: ${AUTH_TOKEN_ENV} is not set; running with authentication disabled. ` +
        `Any local process can drive the tool-server. This is only safe for development.\n`
    );
  }

  // Runs after Host validation and before any handler. The /preview subtree is
  // exempt because it is the browser-loaded in-process UI, with no token available
  // client-side. The exemption is an exact `/preview` or `/preview/`-prefixed match
  // so a future route like `/preview-status` can't be silently un-gated.
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

  // Preview UI plus its device/variant endpoints. Not registered as tools, so an
  // agent never sees this subtree.
  app.use("/preview", createPreviewRouter(registry));

  // Streams tool-produced files (screenshots, profiler exports) so a remote client
  // can fetch them over TOOLS_URL instead of an unreachable host path.
  if (isFlagEnabled(ARTIFACTS_LIST_ENDPOINT_FLAG)) {
    app.get("/artifacts", makeArtifactListRoute(registry));
  }
  app.get("/artifacts/:id", makeArtifactRoute(registry));

  // Per-Chromium-device HTTP surface mirroring sim-server's API:
  // `/chromium-server/:id/api/*` plus `/stream.mjpeg` and `/viewport`. The first
  // request for a given id resolves the registry service (kicking off the CDP
  // connection); later ones reuse that warm session. Like /preview, not advertised
  // to agents — tools stay the canonical way to drive Chromium from an LLM, and
  // this is for non-agent consumers (preview UI, integration tests, dashboards).
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
    // Each ChromiumServer is stable for the lifetime of its registry entry, so
    // caching the router would only save a few allocations per request.
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

  // The client tars a file or dir and streams it here before the tool call.
  // express.json() ignores the body (application/gzip), so we pipe it to disk.
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
    // Drop this stream's in-flight contribution exactly once (on success it moves
    // into the Map), so the running total can't leak or double-count.
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
      // The socket may keep flowing after ws.destroy(); re-counting would leak the
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
        parsedDataForMeta: unknown = req.body,
        extraMeta?: Pick<HttpFailureMeta, "invalid_params">
      ): void => {
        if (!options?.recordFailure) return;
        const failedDeviceArg = extractDeviceArg(parsedDataForMeta);
        const platform = inferPlatform(failedDeviceArg);
        options.recordFailure(
          name,
          {
            ...(platform ? { platform } : {}),
            ...(extraMeta?.invalid_params?.length
              ? { invalid_params: extraMeta.invalid_params }
              : {}),
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
      // A tool hidden from /tools must not be invocable either — report it as not
      // found, re-checked per call so the gate needs no restart.
      if (!isToolExposed(def)) {
        res.status(404).json({ error: `Tool "${name}" not found` });
        return;
      }

      // File boundary: turn client file-input wrappers back into plain
      // server-readable paths BEFORE schema validation, so the tool's zod schema
      // only ever sees the string params it declares. 422 on a file reachable
      // neither in place nor via uploaded content.
      let bodyArgs: any;
      let resolvedFileInputs: Record<string, ResolvedFileInput> | undefined;
      let derivedTargets: string[];
      try {
        const resolved = await resolveFileInputs(def, req.body, (id) => {
          const entry = uploads.get(id);
          if (entry) uploads.delete(id);
          return entry;
        });
        bodyArgs = resolved.args;
        resolvedFileInputs = resolved.fileInputs;
        derivedTargets = resolved.derivedTargets;
        // Materialized uploads are call-scoped: remove them once the response
        // settles, however it ends.
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
          const declared = new Set(Object.keys(def.zodSchema.shape ?? {}));
          emitHttpFailure(
            {
              error_code: FAILURE_CODES.HTTP_ZOD_VALIDATION_FAILED,
              failure_stage: "http_zod_validation",
              failure_area: "http",
              error_kind: "validation",
            },
            req.body,
            { invalid_params: deriveInvalidParams(parseResult.error, declared) }
          );
          // `error` keeps the raw issue JSON. Every CLI released before
          // `issues` existed reads this field and `JSON.parse`s it; prose here
          // makes that parse throw, and the CLI then loses the flag
          // attribution, the help block, exit 2, and `--json`'s object.
          res.status(400).json({
            error: parseResult.error.message,
            message: describeParamIssues(parseResult.error, omitKeys(bodyArgs, derivedTargets)),
            issues: parseResult.error.issues,
          });
          return;
        }
        parsedData = parseResult.data;
      }

      // Capability gate fires BEFORE the global requires preflight: an android
      // serial calling an iOS-only tool should get a clean "unsupported on android"
      // error, not a misleading "xcrun missing". Cross-platform tools re-check
      // inside `dispatchByPlatform`, so non-HTTP callers are covered too.
      //
      // `extractDeviceArg` honours all three device spellings, so an Android serial
      // reaching an iOS-only device_id-tool is rejected here instead of falling
      // through to a deeper blueprint error (a generic 500). Only `udid` and
      // `device_id` reach this gate today — `stop-all-simulator-servers`, the one
      // tool spelling it `devices`, declares no capability.
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
          // Anything other than UnsupportedOperationError (today only a custom
          // supports() refiner can throw one) is an internal fault, not a client
          // validation error — 500/unknown rather than 400/validation.
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

      // Host-binary preflight: `requires: ['xcrun' | 'adb', ...]` yields a 424 with
      // an install hint instead of a deep ENOENT from a child-process call. When
      // the requirement differs per branch, leave `def.requires` empty and let the
      // per-platform `PlatformImpl.requires` fire inside `dispatchByPlatform`,
      // after the device is classified.
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

      // A long-running tool (e.g. await_user_selection) can hold the request open
      // for many minutes. An in-flight invocation IS activity, so keep the idle
      // timer warm for its whole duration — otherwise auto-shutdown reaps the
      // server out from under the still-open request.
      const keepAlive =
        def.longRunning && options?.idleTimeoutMs && options.idleTimeoutMs > 0
          ? setInterval(() => idleTimer.touch(), Math.max(1_000, IDLE_CHECK_INTERVAL_MS / 2))
          : null;
      if (keepAlive) keepAlive.unref?.();

      const toolInvocationId = randomUUID();
      let releaseInvocationMeta: (() => void) | undefined;
      // A recorder bound to THIS request's attribution, handed to orchestrator
      // tools (run-sequence, flow-execute) so the sub-tools they dispatch directly
      // through the registry inherit the same ai_client / platform instead of being
      // recorded as anonymous.
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

      // Progress streaming, opted into per request: a client that accepts NDJSON
      // gets each `ctx.emitProgress` event as its own line, then a terminal
      // `result` (or in-band `error`) line. The gates above still answer with
      // plain-JSON status codes — streaming is committed to only once they pass.
      const wantsStream = Boolean(req.headers.accept?.includes("application/x-ndjson"));
      const writeLine = (payload: unknown): void => {
        res.write(`${JSON.stringify(payload)}\n`);
      };
      if (wantsStream) {
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson",
          "Cache-Control": "no-cache",
        });
      }

      try {
        const data = await registry.invokeTool(name, parsedData, {
          signal: controller.signal,
          ...(resolvedFileInputs ? { fileInputs: resolvedFileInputs } : {}),
          toolInvocationId,
          ...(recordChildInvocation ? { recordChildInvocation } : {}),
          ...(wantsStream
            ? { emitProgress: (event: unknown) => writeLine({ event: "progress", data: event }) }
            : {}),
        });
        // Gate on `updateInstallable`, not `updateAvailable`, and advertise the
        // version the resolver would install: both honour the release-age policy.
        const { updateInstallable, currentVersion, installableVersion } = getUpdateState();
        const shouldNotify = updateInstallable && !isUpdateNoteSuppressed();
        if (shouldNotify) {
          // A persistence failure must not fail the user's tool call; worst case the
          // note appears again on the next request.
          try {
            suppressUpdateNote(AUTO_SUPPRESS_MS);
          } catch {
            // ignore
          }
        }
        const notes: string[] = shouldNotify
          ? [buildUpdateNote(currentVersion, installableVersion ?? "unknown")]
          : [];
        // Per-call and never suppressed, unlike the update note: an in-flight (or
        // ended-but-unretrieved) recording still owes a `screen-recording-stop`.
        const activeRecordings = getActiveScreenRecordings();
        if (activeRecordings.length > 0) {
          notes.push(buildScreenRecordingNote(activeRecordings, Date.now()));
        }
        // A tool can raise a per-call note by returning this reserved key. It
        // rides the envelope rather than the result body because clients render
        // image results as image blocks plus a "Saved:" line and drop every
        // other field — a note inside `data` would never be seen.
        const toolNote = takeToolNote(data);
        if (toolNote) notes.push(toolNote);
        const notePayload = notes.length > 0 ? { note: notes.join("\n\n") } : {};
        if (wantsStream) {
          writeLine({ event: "result", data, ...notePayload });
          res.end();
        } else {
          res.json({ data, ...notePayload });
        }
      } catch (err: unknown) {
        if (wantsStream) {
          writeLine({ event: "error", error: streamErrorMessage(err), ...errorSignalFields(err) });
          res.end();
          return;
        }
        if (err instanceof ToolNotFoundError) {
          res.status(404).json({ error: err.message, ...errorSignalFields(err) });
          return;
        }
        // Walk the cause chain so a ToolExecutionError wrapping a
        // DependencyMissingError still maps to 424 instead of a generic 500. Tools
        // that ensureDep() inside execute() bypass the global preflight; this is
        // their fall-back surface.
        const depErr = findDependencyMissing(err);
        if (depErr) {
          res
            .status(424)
            .json({ error: depErr.message, missing: depErr.missing, ...errorSignalFields(err) });
          return;
        }
        // Unwrap the cause chain: thrown inside execute() / a service factory, these
        // arrive wrapped in ToolExecutionError, so a top-level instanceof would miss
        // them and fall through to a 500.
        const unsupportedErr = findErrorInCauseChain(err, UnsupportedOperationError);
        if (unsupportedErr) {
          res.status(400).json({ error: unsupportedErr.message, ...errorSignalFields(err) });
          return;
        }
        // A tool rejecting its arguments is a client input error, not an internal
        // fault — 400, matching the zod-validation path, instead of a misleading 500.
        //
        // Ordering invariant: this runs AFTER `findDependencyMissing`, which walks
        // the entire cause chain. Unambiguous only because `InvalidToolInputError`
        // is always thrown as a leaf — nesting a `DependencyMissingError` under one
        // would map the response to 424 first. Keep it causeless, or reorder these
        // two checks. That precedence is pinned by the dual-class-chain case in
        // http-dep-gate.test.ts.
        const invalidInputErr = findErrorInCauseChain(err, InvalidToolInputError);
        if (invalidInputErr) {
          res.status(400).json({ error: invalidInputErr.message, ...errorSignalFields(err) });
          return;
        }
        if (getFailureSignal(err)?.error_code === FAILURE_CODES.TOOL_INPUT_INVALID) {
          res.status(400).json({ error: formatErrorForAgent(err), ...errorSignalFields(err) });
          return;
        }
        const notImplementedErr = findErrorInCauseChain(err, NotImplementedOnPlatformError);
        if (notImplementedErr) {
          res.status(501).json({
            error: notImplementedErr.message,
            toolId: notImplementedErr.toolId,
            platform: notImplementedErr.platform,
            hint: notImplementedErr.hint,
            ...errorSignalFields(err),
          });
          return;
        }
        res.status(500).json({ error: formatErrorForAgent(err), ...errorSignalFields(err) });
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
          // The CDP session must already be resolved (the per-device REST routes do
          // that lazily on first hit). If none is open, refuse the upgrade rather
          // than trigger a slow CDP connect inside the upgrade handler, which would
          // block the TCP socket.
          const urn = `${CHROMIUM_CDP_NAMESPACE}:${deviceId}`;
          const snapshot = registry.getSnapshot();
          if (!snapshot.services.has(urn)) return null;
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
