/**
 * # Published contract: external device providers, schema version 1 (frozen)
 *
 * This module is the whole of Argent's device-provider extension point. A
 * provider is any third-party process that already drives a simulator or
 * emulator and is willing to share it. It writes a small JSON file into
 * `~/.argent/providers/` listing what it offers, and Argent attaches to those
 * devices instead of booting its own.
 *
 * The surface is deliberately vendor-neutral and small. Nothing names a
 * specific product and nothing needs to change when Argent gains tools. The
 * `capabilities` vocabulary describes mechanisms (may I run simctl? may I
 * attach to a simulator-server?), not tool names.
 *
 * Every exported name, JSON field and capability token below is implemented
 * against by third parties (see `schemas/device-provider-v1.json`, which must
 * stay in step with the zod schemas here). Changing or removing one is breaking
 * and requires a `schemaVersion: 2` that still accepts version-1 documents.
 * Adding an optional field or a new capability token is not: unknown fields and
 * tokens are ignored by design.
 *
 * A provider must never be able to break Argent. Discovery and listing degrade
 * to "no external devices" and write at most one line to `stderr`. The worst
 * case for a malformed, stale or hostile file is that the integration goes
 * dark.
 *
 * The inverse holds for permissions: absent or unparseable means "not
 * allowed". A device with no `capabilities` array is rejected outright.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { FAILURE_CODES, FailureError, type DeviceInfo } from "@argent/registry";
import { argentHomeDir } from "@argent/configuration-core";

/**
 * Circular by design and safe: device-info.ts imports the id helpers from
 * here, this module imports `classifyDevice`. Both are function declarations
 * consumed at call time, never during module init.
 */
import { classifyDevice } from "./device-info";

/**
 * Prefix on every device id that belongs to an external provider. The full
 * shape is `ext:<providerId>:<nativeId>`.
 *
 * @see {@linkcode makeExternalId}
 */
export const EXTERNAL_PREFIX = "ext:";

/** The only schema version this build understands. */
export const PROVIDER_SCHEMA_VERSION = 1;

/**
 * Provider ids are lowercase slugs so they survive being embedded in a device
 * id, a URN, a filename and a telemetry property without escaping.
 *
 * Providers SHOULD shape the id as `<vendor>-<instance-suffix>` (e.g.
 * `acme-3f2a9c`): it must be unique per live provider instance, while the
 * leading segment is the stable vendor label Argent reports in telemetry.
 * Argent never parses it for anything else.
 *
 * @see {@linkcode externalProviderLabel}
 */
export const PROVIDER_ID_SHAPE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Native ids are passed to `adb` / `xcrun` as `argv`, so they are constrained
 * to the same conservative character set the simulator-server spawn path
 * enforces: no leading `-` (flag injection) and no shell / whitespace /
 * separator characters. `:` and `.` are allowed because an adb serial can be
 * `ip:port`.
 */
const SAFE_NATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * True when `id` is an external-provider device id. Pure, no I/O.
 *
 * The `typeof` guard is not redundant. A wrapper that doesn't re-validate the
 * inner schema can reach a blueprint factory with an `undefined` `device.id`
 * and this runs early on those paths. Throwing would turn a clean validation
 * error into a crash.
 */
export function isExternalId(id: string): boolean {
  return typeof id === "string" && id.startsWith(EXTERNAL_PREFIX);
}

function parseExternalId(id: string): { nativeId: string; providerId: string } | undefined {
  if (!isExternalId(id)) return undefined;

  const rest = id.slice(EXTERNAL_PREFIX.length);
  const separator = rest.indexOf(":");

  if (separator <= 0) return undefined;

  const providerId = rest.slice(0, separator);
  const nativeId = rest.slice(separator + 1);

  if (!PROVIDER_ID_SHAPE.test(providerId)) return undefined;
  if (!SAFE_NATIVE_ID.test(nativeId)) return undefined;

  return { providerId, nativeId };
}

/**
 * The provider-facing device id (real iOS UDID / adb serial) behind an `ext:`
 * id. Identity for every other id, which is what lets call sites apply it
 * unconditionally. `runAdb` maps its whole argv in one line. A malformed
 * `ext:` id comes back unchanged rather than throwing.
 */
export function externalNativeId(id: string): string {
  return parseExternalId(id)?.nativeId ?? id;
}

/** The provider that owns an `ext:` id, or `undefined` for any other id. */
export function externalProviderId(id: string): string | undefined {
  return parseExternalId(id)?.providerId;
}

/**
 * Stable vendor label for telemetry: the leading segment of the provider id.
 * The instance-unique suffix is dropped deliberately. A new value per
 * provider window would make adoption and failure rates unaggregatable and
 * tells us nothing the vendor label doesn't.
 */
export function externalProviderLabel(id: string): string | undefined {
  const providerId = externalProviderId(id);
  if (!providerId) return undefined;
  const label = providerId.split("-")[0]!;
  return PROVIDER_ID_SHAPE.test(label) ? label : undefined;
}

/**
 * Build the canonical device id for a provider-supplied device.
 *
 * The platform is deliberately NOT encoded — `classifyDevice` derives it from
 * the native id's shape, so exactly one place decides what a device is.
 */
export function makeExternalId(providerId: string, nativeId: string): string {
  return `${EXTERNAL_PREFIX}${providerId}:${nativeId}`;
}

/**
 * True when a service URN (`<namespace>:<deviceId>[<suffix>]`) belongs to an
 * external device. Service URNs put the namespace first, so the raw
 * `isExternalId` check does not apply to them.
 */
export function isExternalDeviceUrn(urn: string): boolean {
  const separator = urn.indexOf(":");
  return separator >= 0 && isExternalId(urn.slice(separator + 1));
}

/**
 * Drop every cached service handle bound to `deviceId`.
 *
 * Used when a provider withdraws a device or narrows its capabilities, since
 * the registry would otherwise keep serving from a handle resolved while the
 * old answer held. Every external `dispose()` is a no-op, so this forgets
 * state without touching the provider's processes.
 */
export async function disposeExternalDeviceServices(
  registry: {
    disposeService(urn: string): Promise<void>;
    getSnapshot(): { services: ReadonlyMap<string, unknown> };
  },
  deviceId: string
): Promise<string[]> {
  if (!isExternalId(deviceId)) return [];

  const disposed: string[] = [];

  for (const urn of registry.getSnapshot().services.keys()) {
    const separator = urn.indexOf(":");
    if (separator < 0) continue;

    /**
     * Suffix-tolerant: some namespaces append a transport tag after the id.
     */
    if (!urn.slice(separator + 1).startsWith(deviceId)) continue;
    await registry.disposeService(urn);
    disposed.push(urn);
  }

  return disposed;
}

/**
 * Frozen vocabulary. Each token names a mechanism Argent may use against the
 * device, which is what lets it outlive Argent's tool list and what makes a
 * provider's declaration the single lever for both conflict avoidance and
 * entitlement policy.
 *
 * - `adb`              — drive `nativeId` as a live adb serial.
 * - `ax-service`       — `simctl spawn` Argent's accessibility daemon inside
 * - `js-debugger`      — attach a CDP client to the JS runtime at `metroPort`.
 * - `native-devtools`  — inject Argent's dylib / JVMTI agent.
 * - `native-profiler`  — Instruments / Perfetto against the app process.
 * - `simctl`           — run `xcrun simctl` verbs against the device
 *                        (scoped to `deviceSet` when one is declared).
 *                        the simulator.
 * - `simulator-server` — attach to the device's `apiUrl` / `streamUrl` for
 *                        input, screenshots and the MJPEG stream.
 *
 * Unknown tokens are ignored, so a provider may declare capabilities from a
 * future Argent version without tripping an older one.
 */
export const EXTERNAL_CAPABILITIES = [
  "adb",
  "ax-service",
  "js-debugger",
  "native-devtools",
  "native-profiler",
  "simctl",
  "simulator-server",
] as const;

export type ExternalCapability = (typeof EXTERNAL_CAPABILITIES)[number];

const CAPABILITY_SET: ReadonlySet<string> = new Set(EXTERNAL_CAPABILITIES);

/** Enforced at runtime by {@linkcode assertAllowedSimServerEndpoint} */
export const ALLOWED_SIM_SERVER_ENDPOINTS = ["/api/pointer", "/api/screenshot", "/ws"] as const;

const ALLOWED_ENDPOINT_SET: ReadonlySet<string> = new Set(ALLOWED_SIM_SERVER_ENDPOINTS);

/**
 * Throw unless `endpoint` is one Argent's own simulator-server build serves.
 * Called on the attached-server HTTP path only; local servers are Argent's own
 * process and need no restriction.
 */
export function assertAllowedSimServerEndpoint(endpoint: string): void {
  if (ALLOWED_ENDPOINT_SET.has(endpoint)) return;

  throw new FailureError(
    `Refusing to call '${endpoint}' on an externally-provided simulator-server. ` +
      `Argent only uses the endpoints its own simulator-server build serves ` +
      `(${ALLOWED_SIM_SERVER_ENDPOINTS.join(", ")}).`,
    {
      error_code: FAILURE_CODES.EXTERNAL_DEVICE_ENDPOINT_FORBIDDEN,
      error_kind: "unsupported",
      failure_area: "tool_server",
      failure_stage: "external_device_endpoint_allowlist",
    }
  );
}

const httpUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an http(s) URL");

const webSocketUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "ws:" || parsed.protocol === "wss:";
    } catch {
      return false;
    }
  }, "must be a ws(s) URL");

/**
 * Where to attach a CDP client instead of the target Metro advertises.
 *
 * React Native allows one debugger per device:
 * `Device.handleDebuggerConnection` terminates the existing connection with
 * `NEW_DEBUGGER_OPENED` before installing a new one. Two independent clients
 * cannot share a runtime, they evict each other in a loop.
 *
 * A provider already holding that connection can re-serve it, keeping the
 * device down to one debugger while deciding what each client sees. Argent
 * still reads Metro for the session's metadata; only the socket changes.
 *
 * Omit it when nothing else is debugging, and Argent connects to Metro direct.
 */
const jsDebuggerSchema = z.object({
  webSocketUrl,
});

const simulatorServerSchema = z.object({
  apiUrl: httpUrl,
  streamUrl: httpUrl,
  /**
   * Informational. Argent never branches on it and it exists so a version-skew
   * failure names the binary in its error message instead of being a mystery.
   */
  version: z.string().max(64).optional(),
});

/**
 * One device a provider is offering.
 *
 * `capabilities` is required on purpose: a device that forgets to declare it
 * is rejected rather than defaulted. See the fail-closed policy at the top.
 */
export const providerDeviceSchema = z
  .object({
    capabilities: z.array(z.string().max(64)).max(32),
    /**
     * iOS only. The CoreSimulator device set the device lives in; when present
     * every `simctl` verb is scoped with `--set <deviceSet>`. Absent means the
     * default set, which needs no `--set`.
     */
    deviceSet: z.string().min(1).max(4096).optional(),
    /** @see {@linkcode jsDebuggerSchema} */
    jsDebugger: jsDebuggerSchema.optional(),
    kind: z.enum(["simulator", "emulator", "device"]),
    /**
     * The Metro port serving this device, used as the default by every tool
     * that speaks CDP to the app's JS runtime. An explicit port still wins.
     *
     * Independent of the `js-debugger` capability: this says where Metro is,
     * that says whether Argent may attach.
     */
    metroPort: z.number().int().min(1).max(65535).optional(),
    name: z.string().min(1).max(128),
    nativeId: z.string().min(1).max(256).regex(SAFE_NATIVE_ID),
    platform: z.enum(["ios", "android"]),
    simulatorServer: simulatorServerSchema.optional(),
    state: z.string().min(1).max(64),
  })
  .superRefine((device, ctx) => {
    if (device.capabilities.includes("simulator-server") && !device.simulatorServer) {
      ctx.addIssue({
        code: "custom",
        message: "required when the 'simulator-server' capability is declared",
        path: ["simulatorServer"],
      });
    }

    if (device.deviceSet && device.platform !== "ios") {
      ctx.addIssue({
        code: "custom",
        message: "only meaningful for iOS devices",
        path: ["deviceSet"],
      });
    }
  });

export type ProviderDevice = z.infer<typeof providerDeviceSchema>;

/**
 * The whole of `~/.argent/providers/<opaque-name>.json`: provider identity and
 * the devices it is offering, in one document.
 *
 * The filename is provider-chosen and meaningless to Argent; several files
 * just mean several providers. Argent keys on `id`.
 */
export const providerRecordSchema = z.object({
  /**
   * The devices on offer right now. Required: an empty array says "running,
   * nothing booted", which differs from omitting the field (malformed).
   */
  devices: z.array(providerDeviceSchema).max(256),
  /** Unique per live provider instance. @see {@linkcode PROVIDER_ID_SHAPE} */
  id: z.string().regex(PROVIDER_ID_SHAPE),
  /** Human-readable, shown to the agent and in every error attributed here. */
  name: z.string().min(1).max(64),
  schemaVersion: z.number().int(),
  /** Where Argent points users when something attributed to this provider fails. */
  supportUrl: httpUrl.optional(),
  /**
   * Optional project context, surfaced verbatim in `list-devices` so an agent
   * can prefer the device belonging to its own project. Argent does no
   * filtering itself. There is no project identity on its wire.
   */
  workspace: z
    .object({ name: z.string().min(1).max(128), path: z.string().min(1).max(4096) })
    .optional(),
});

/**
 * The same document, but with the device entries left unvalidated.
 *
 * This is what the runtime parses with. Under {@linkcode providerRecordSchema}
 * one malformed device would fail the whole document, costing a provider every
 * other device it was offering. {@linkcode adoptDevice} validates them one at
 * a time instead, so a bad entry drops only itself.
 *
 * {@linkcode providerRecordSchema} remains the strict, published article that
 * `argent providers check` validates against, so a provider is still told
 * about a malformed device rather than silently losing it.
 */
const providerEnvelopeSchema = providerRecordSchema.extend({
  devices: z.array(z.unknown()).max(256),
});

export type ProviderRecord = z.infer<typeof providerEnvelopeSchema> & {
  /**
   * Where this record was read from. Diagnostics only: never part of the wire
   * contract.
   */
  sourcePath?: string;
};

/**
 * A provider device after validation, joined to the provider that served it.
 * This is what the rest of the tool-server sees.
 */
export interface ExternalDevice {
  /** Canonical Argent device id: `ext:<providerId>:<nativeId>`. */
  capabilities: ReadonlySet<string>;
  deviceSet?: string;
  id: string;
  jsDebugger?: { webSocketUrl: string };
  kind: "device" | "emulator" | "simulator";
  metroPort?: number;
  name: string;
  nativeId: string;
  platform: "android" | "ios";
  provider: {
    id: string;
    name: string;
    supportUrl?: string;
    workspace?: { name: string; path: string };
  };
  simulatorServer?: { apiUrl: string; streamUrl: string; version?: string };
  state: string;
}

/** Escape hatch: set to `1`/`true` to skip provider discovery entirely. */
const DISABLE_ENV = "ARGENT_DISABLE_DEVICE_PROVIDERS";

/**
 * Test / advanced override: comma-separated descriptor paths. When set,
 * `~/.argent/providers/` is not scanned, so a test (or the E2E) can point
 * Argent at a sandboxed descriptor without touching the real home directory.
 */
const OVERRIDE_ENV = "ARGENT_DEVICE_PROVIDERS";

/**
 * `~/.argent/providers`: machine-global, shared by every tool-server install.
 */
export function providersDirectory(): string {
  return path.join(argentHomeDir(), "providers");
}

function discoveryDisabled(): boolean {
  const raw = process.env[DISABLE_ENV];
  return raw === "1" || raw?.toLowerCase() === "true";
}

/**
 * One `stderr` line per (path, reason) per process. A provider that keeps
 * rewriting a broken file must not be able to flood the log.
 */
const warnedOnce = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  process.stderr.write(`[device-providers] ${message}\n`);
}

/** Test seam. Forget the one-shot `stderr` warnings. */
export function __resetProviderWarningsForTesting(): void {
  warnedOnce.clear();
}

function readProviderFile(file: string): ProviderRecord | undefined {
  let raw: string;

  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    /**
     * Unreadable or removed between `readdir` and read — treat as absent.
     * A provider writes atomically (tmp + rename), so a partial read is a
     * transient worth ignoring rather than reporting.
     */
    return undefined;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    warnOnce(`${file}:json`, `ignoring ${file}: not valid JSON`);
    return undefined;
  }

  /**
   * Version-check before shape validation: a v2 document is allowed to look
   * nothing like v1, and must be skipped quietly rather than reported as
   * malformed.
   */
  const version = (parsed as { schemaVersion?: unknown } | null)?.schemaVersion;

  if (version !== PROVIDER_SCHEMA_VERSION) {
    warnOnce(
      `${file}:version`,
      `ignoring ${file}: unsupported schemaVersion ${JSON.stringify(version)} ` +
        `(this build understands ${PROVIDER_SCHEMA_VERSION})`
    );

    return undefined;
  }

  const result = providerEnvelopeSchema.safeParse(parsed);

  if (!result.success) {
    warnOnce(`${file}:shape`, `ignoring ${file}: ${result.error.issues[0]?.message ?? "invalid"}`);
    return undefined;
  }

  return { ...result.data, sourcePath: file };
}

/**
 * Read every provider descriptor currently on disk.
 *
 * Synchronous and cheap by design: on the common path the directory is absent
 * and this costs one failed `readdir`. Never throws, never writes, and — most
 * importantly — never unlinks. A stale file belongs to another process; leaving
 * it costs one refused connection, deleting it is unrecoverable.
 */
export function discoverProviders(): ProviderRecord[] {
  if (discoveryDisabled()) return [];

  const override = process.env[OVERRIDE_ENV];
  let files: string[];

  if (override) {
    files = override
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  } else {
    try {
      files = fs
        .readdirSync(providersDirectory())
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => path.join(providersDirectory(), name));
    } catch {
      return [];
    }
  }

  const byId = new Map<string, ProviderRecord>();

  for (const file of files) {
    const record = readProviderFile(file);
    if (!record) continue;
    /**
     * First file wins on a duplicate id. Two live instances must not share
     * one. If they do, one is stale and we cannot tell which, so pick
     * deterministically (files are sorted) instead of racing.
     */
    if (byId.has(record.id)) {
      warnOnce(`${record.id}:dup`, `ignoring ${file}: duplicate provider id '${record.id}'`);
      continue;
    }

    byId.set(record.id, record);
  }

  return Array.from(byId.values());
}

/**
 * How long to wait for a device's simulator-server to answer the liveness
 * probe. Local loopback, so this is generous. It only has to beat a wedged
 * process.
 */
const PROBE_TIMEOUT_MS = 800;

/** Test seam: forget the remembered capability sets used for revocation. */
export function __resetExternalDeviceCacheForTesting(): void {
  lastSeenCapabilities.clear();
}

/**
 * Validate one raw device entry against the provider that served it. Returns
 * `undefined` (with a one-shot `stderr` line) for anything that fails, so one
 * bad device never costs a provider its whole list.
 */
function adoptDevice(record: ProviderRecord, raw: unknown): ExternalDevice | undefined {
  const parsed = providerDeviceSchema.safeParse(raw);

  if (!parsed.success) {
    const nativeId = (raw as { nativeId?: unknown })?.nativeId;

    warnOnce(
      `${record.id}:device:${String(nativeId)}`,
      `${record.name}: ignoring device ${JSON.stringify(nativeId)}: ` +
        `${parsed.error.issues[0]?.message ?? "invalid"}`
    );

    return undefined;
  }

  const device = parsed.data;

  /**
   * The claimed platform must agree with the native id's shape, or the device
   * would be routed to the wrong toolchain entirely (e.g. an `adb` serial fed
   * to `xcrun`). Rejecting keeps `classifyDevice` the one source of truth
   * rather than letting a provider override it.
   */
  const shape = classifyDevice(device.nativeId);

  if (shape !== device.platform) {
    warnOnce(
      `${record.id}:platform:${device.nativeId}`,
      `${record.name}: ignoring device '${device.nativeId}': declared platform ` +
        `'${device.platform}' but its id classifies as '${shape}'`
    );

    return undefined;
  }

  const capabilities = new Set(device.capabilities.filter((cap) => CAPABILITY_SET.has(cap)));

  return {
    capabilities,
    ...(device.deviceSet ? { deviceSet: device.deviceSet } : {}),
    id: makeExternalId(record.id, device.nativeId),
    ...(device.jsDebugger ? { jsDebugger: device.jsDebugger } : {}),
    kind: device.kind,
    ...(device.metroPort ? { metroPort: device.metroPort } : {}),
    name: device.name,
    nativeId: device.nativeId,
    platform: device.platform,
    provider: {
      id: record.id,
      name: record.name,
      ...(record.supportUrl ? { supportUrl: record.supportUrl } : {}),
      ...(record.workspace ? { workspace: record.workspace } : {}),
    },
    ...(device.simulatorServer ? { simulatorServer: device.simulatorServer } : {}),
    state: device.state,
  };
}

/**
 * Every device a provider's file currently declares, validated and joined to
 * that provider. Pure and synchronous, the file is the source of truth, so
 * nothing is cached and nothing can go stale between reads. That is what lets
 * the revocation check in [`http.ts`](../http.ts) run on every dispatch.
 */
function readProviderDevices(record: ProviderRecord): ExternalDevice[] {
  const out: ExternalDevice[] = [];

  for (const raw of record.devices) {
    const device = adoptDevice(record, raw);
    if (device) out.push(device);
  }

  for (const device of out) {
    lastSeenCapabilities.set(device.id, capabilityKey(device.capabilities));
  }

  return out;
}

/**
 * Is this device's simulator-server actually listening?
 *
 * This is the liveness signal that tests the process Argent needs to talk to
 * rather than the one that wrote the file. A provider killed with `SIGKILL`
 * never unlinks its descriptor and without this its devices would linger in
 * `list-devices`, costing the agent a turn to discover they are gone.
 *
 * Any completed response proves something is listening. Only a transport
 * failure counts as dead.
 *
 * Modelled on [`chromium-discovery.ts`](./chromium-discovery.ts).
 */
async function probeAlive(device: ExternalDevice): Promise<boolean> {
  /**
   * Nothing to probe. A device offering only `adb`/`simctl` has no
   * simulator-server. Absent evidence is not evidence of death. Pass it and
   * let the mechanism it does grant fail on its own terms.
   */
  if (!device.simulatorServer) return true;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    /**
     * Deliberately the API url. Probing the MJPEG endpoint would open a video
     * stream and register us as a client.
     */
    await fetch(device.simulatorServer.apiUrl, { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every device every live provider is currently offering.
 *
 * Never throws and never rejects: a provider whose file is malformed, stale,
 * or pointing at a dead server simply contributes nothing.
 *
 * Probing happens here and not in {@linkcode lookupExternalDevice}, on
 * purpose. This is the discovery path, where a phantom device costs the agent
 * a turn and a probe is cheap. Dispatch resolves a device the agent already
 * chose and is about to connect to anyway, so probing there would do the same
 * work twice — a dead server surfaces at once as the connection-refused
 * `recoverable()` handles.
 */
export async function listExternalDevices(
  options: { probe?: boolean } = {}
): Promise<ExternalDevice[]> {
  const providers = discoverProviders();
  if (providers.length === 0) return [];
  const devices = providers.flatMap((record) => readProviderDevices(record));
  if (options.probe === false) return devices;
  const alive = await Promise.all(devices.map((device) => probeAlive(device).catch(() => false)));
  return devices.filter((_, index) => alive[index]);
}

/**
 * The device behind an `ext:` id, or `undefined`. Synchronous and side-effect
 * free.
 *
 * Every read goes to the file, so this is always current — there is no cached
 * view that could disagree with it.
 */
export function findExternalDevice(id: string): ExternalDevice | undefined {
  const parsed = parseExternalId(id);
  if (!parsed) return undefined;
  const record = discoverProviders().find((provider) => provider.id === parsed.providerId);
  if (!record) return undefined;
  return readProviderDevices(record).find((device) => device.nativeId === parsed.nativeId);
}

/**
 * Provider attribution is deliberately not added here. The HTTP dispatch edge
 * appends it to every `ext:` failure, so spelling out the provider's name and
 * support URL would print them twice.
 */
function unknownDeviceError(detail: string): FailureError {
  return new FailureError(detail, {
    error_code: FAILURE_CODES.EXTERNAL_DEVICE_UNAVAILABLE,
    error_kind: "not_found",
    failure_area: "tool_server",
    failure_stage: "external_device_lookup",
  });
}

/**
 * Resolve one `ext:` id to its current descriptor, or throw a message that
 * says what happened to it.
 *
 * Every call re-reads the provider's file, which is what makes recovery free:
 * a simulator-server restarted on a new ephemeral port gives `ECONNREFUSED`,
 * `recoverable()` disposes the instance, the registry re-runs the factory and
 * its lookup picks up the new port, with no reconnection code anywhere.
 */
export async function lookupExternalDevice(id: string): Promise<ExternalDevice> {
  const parsed = parseExternalId(id);

  if (!parsed) {
    throw unknownDeviceError(`'${id}' is not a valid external device id.`);
  }

  const record = discoverProviders().find((p) => p.id === parsed.providerId);

  if (!record) {
    throw unknownDeviceError(
      `No device provider named '${parsed.providerId}' is registered. ` +
        `It may have shut down — run list-devices to see what is available.`
    );
  }

  const device = readProviderDevices(record).find((device) => device.nativeId === parsed.nativeId);

  if (!device) {
    throw unknownDeviceError(
      `${record.name} is no longer offering device '${parsed.nativeId}'. ` +
        `It may have been shut down or withdrawn — run list-devices to see what is available.`
    );
  }

  return device;
}

/**
 * Deny `capability` on `device` unless its provider declared it.
 *
 * A no-op for every non-external device, so wiring this into a shared blueprint
 * carries no risk for the paths that exist today. Gating happens at the
 * *mechanism* (the blueprint) rather than per tool: five blueprints cover every
 * current and future tool built on them, so Argent gaining a tool never means
 * re-auditing this list.
 *
 * Async because the answer is the provider's to give — re-read from the
 * descriptor rather than remembered from when the device was first seen, which
 * is what lets a provider narrow or revoke a capability mid-session.
 */
export async function assertExternalCapability(
  namespace: string,
  device: DeviceInfo | string,
  capability: ExternalCapability
): Promise<void> {
  const id = typeof device === "string" ? device : device.id;

  if (!isExternalId(id)) return;

  const externalDevice = await lookupExternalDevice(id);

  if (externalDevice.capabilities.has(capability)) return;

  /**
   * Names the provider because that is the actionable part. The support URL is
   * left to the HTTP edge, which appends it to every `ext:` failure, so
   * stating it here too would duplicate it.
   */
  throw new FailureError(
    `${namespace} is not available on '${externalDevice.name}': ${externalDevice.provider.name} did not grant ` +
      `the '${capability}' capability for this device.`,
    {
      error_code: FAILURE_CODES.EXTERNAL_DEVICE_CAPABILITY_DENIED,
      error_kind: "unsupported",
      failure_area: "tool_server",
      failure_stage: "external_device_capability_gate",
    }
  );
}

/**
 * Capability sets as last observed, keyed by device id. Comparing against this
 * is how a mid-session license change or a withdrawn device invalidates a
 * service the registry has cached and would otherwise keep serving.
 */
const lastSeenCapabilities = new Map<string, string>();

function capabilityKey(capabilities: ReadonlySet<string>): string {
  return Array.from(capabilities).sort().join(",");
}

/**
 * Re-read an external device's descriptor and report whether anything a cached
 * service depends on has changed.
 *
 * `stale: true` means the caller must dispose the device's services before
 * dispatching, so the next call re-resolves against the provider's current
 * declaration instead of a warm handle from before the change.
 *
 * Reads the file every time, with no TTL. That is affordable because the file
 * is small and local (the same reasoning that lets the feature-flag layer
 * re-read `~/.argent/flags.json` per request) and it means a withdrawn device
 * or a narrowed capability set takes effect on the next tool call rather than
 * within a cache window.
 */
export function revalidateExternalDevice(id: string): { reason?: string; stale: boolean } {
  if (!isExternalId(id)) return { stale: false };

  const previous = lastSeenCapabilities.get(id);
  const device = findExternalDevice(id);

  if (!device) {
    lastSeenCapabilities.delete(id);

    return previous === undefined
      ? { stale: false }
      : { reason: "the device is no longer offered by its provider", stale: true };
  }

  const current = capabilityKey(device.capabilities);

  lastSeenCapabilities.set(id, current);

  if (previous !== undefined && previous !== current) {
    return { reason: "its provider changed the capabilities it grants", stale: true };
  }

  return { stale: false };
}

/**
 * The sentence appended to any failure on an external device, naming the
 * provider and where to report it. This is the mechanism that routes bug
 * reports for provider-supplied devices away from Argent's issue tracker.
 */
export function externalSupportHint(id: string): string | undefined {
  const providerId = externalProviderId(id);
  if (!providerId) return undefined;
  const record = discoverProviders().find((p) => p.id === providerId);
  if (!record) return undefined;
  const where = record.supportUrl ? ` Report issues at ${record.supportUrl}.` : "";
  return `This device is provided by ${record.name}.${where}`;
}
