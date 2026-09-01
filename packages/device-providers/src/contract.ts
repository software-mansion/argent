/**
 * # Published contract: external device providers, schema version 1 (frozen)
 *
 * This module is the whole of Argent's device-provider extension point. A
 * provider is any third-party process that already drives a simulator or
 * emulator and is willing to share it. It writes a small JSON file into
 * `~/.argent/providers/` listing what it offers and Argent attaches to those
 * devices instead of booting its own.
 *
 * The surface is deliberately vendor-neutral and small. Nothing names a
 * specific product and nothing needs to change when Argent gains tools. The
 * `capabilities` vocabulary describes mechanisms (may I run simctl? may I
 * attach to a simulator-server?), not tool names.
 *
 * Every exported name, JSON field and capability token below is implemented
 * against by third parties (see `schemas/device-provider-v1.json`, which
 * `test/schema-parity.test.ts` holds in step with the zod schemas here).
 * Changing or removing one is breaking and requires a `schemaVersion: 2` that
 * still accepts version-1 documents. Adding an optional field or a new
 * capability token is not: unknown fields and tokens are ignored by design.
 *
 * A provider must never be able to break Argent. Discovery and listing degrade
 * to "no external devices" and write at most one line to `stderr`. The worst
 * case for a malformed, stale or hostile file is that the integration goes
 * dark.
 *
 * The inverse holds for permissions: absent or unparseable means "not
 * allowed". A device with no `capabilities` array is rejected outright.
 *
 * Pure: no I/O, no dependency but zod. Discovery lives in
 * [`read.ts`](./read.ts), publishing in [`write.ts`](./write.ts).
 */

import { z } from "zod";

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

/**
 * Split an `ext:` id back into the provider that owns it and the device id that
 * provider knows it by, or `undefined` for anything malformed.
 */
export function parseExternalId(id: string): { nativeId: string; providerId: string } | undefined {
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
 * The platform is deliberately not encoded. The consumer's device classifier
 * derives it from the native id's shape, so exactly one place decides what a
 * device is.
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
 * Frozen vocabulary. Each token names a mechanism Argent may use against the
 * device, which is what lets it outlive Argent's tool list and what makes a
 * provider's declaration the single lever for both conflict avoidance and
 * entitlement policy.
 *
 * - `adb`              — drive `nativeId` as a live adb serial.
 * - `ax-service`       — `simctl spawn` Argent's accessibility daemon inside
 *                        the simulator.
 * - `js-debugger`      — attach a CDP client to the JS runtime at `metroPort`.
 * - `native-devtools`  — inject Argent's dylib. iOS only, the blueprint refuses
 *                        every other platform, so an Android device declaring
 *                        it is an error `argent providers check` reports rather
 *                        than a capability Argent will use.
 * - `native-profiler`  — Instruments / Perfetto against the app process.
 * - `simctl`           — run `xcrun simctl` verbs against the device
 *                        (scoped to `deviceSet` when one is declared).
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

/** Membership test behind the capability filter in `read.ts`. */
export const CAPABILITY_SET: ReadonlySet<string> = new Set(EXTERNAL_CAPABILITIES);

/**
 * The endpoints Argent's own simulator-server build serves and therefore the
 * only ones it will call on a provider's. Contract, so it lives here; the gate
 * that throws on anything else is the consumer's (it needs the consumer's own
 * failure type).
 */
export const ALLOWED_SIM_SERVER_ENDPOINTS = [
  "/api/clipboard/text",
  "/api/pointer",
  "/api/screenshot",
  "/ws",
] as const;

/**
 * A page for a person to open. `supportUrl` is the only one and it is never
 * fetched.
 */
const webUrl = z
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

/**
 * An endpoint on the provider's own simulator-server.
 *
 * `http:` only and deliberately narrower than {@linkcode webUrl}. The
 * simulator-server serves plaintext on a port it picks at startup. Both Argent
 * and every provider read that port off the binary's own `api_ready` line,
 * which prints an `http://` URL. Nothing in the chain terminates TLS.
 *
 * The consumer also opens `/ws` on this host and a WebSocket has to pick its
 * scheme up front. Accepting `https:` here would promise a `wss:` endpoint that
 * nothing serves, so the connection would fail with a message about the
 * simulator being down. Refusing it at publish time says what is actually
 * wrong.
 */
const simulatorServerUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      return new URL(value).protocol === "http:";
    } catch {
      return false;
    }
  }, "must be an http:// URL — the simulator-server serves plaintext on a local port");

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
 * Omit it when nothing else is debugging and Argent connects to Metro direct.
 */
const jsDebuggerSchema = z.object({
  webSocketUrl,
});

/**
 * Where to attach to the native-devtools agent already inside the app, instead
 * of injecting Argent's own dylib.
 *
 * `DYLD_INSERT_LIBRARIES` and the agent's endpoint are simulator-wide launchd
 * values, so two products arming their own injection overwrite each other. A
 * provider that already injects re-serves its agent connection here instead.
 *
 * The socket speaks the same newline-delimited JSON envelope Argent's own
 * agent does (`{ type: "Control" | "ViewInspector" | "CDP", payload }`),
 * opening with a `Control` frame naming the connected `bundleId`.
 */
const nativeDevtoolsSchema = z.object({
  /**
   * Listening unix socket. 104 is the `sockaddr_un.sun_path` limit on macOS.
   */
  socketPath: z.string().min(1).max(104),
});

const simulatorServerSchema = z.object({
  apiUrl: simulatorServerUrl,
  streamUrl: simulatorServerUrl,
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
     * iOS only. The CoreSimulator device set the device lives in. When present
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
    /** @see {@linkcode nativeDevtoolsSchema} */
    nativeDevtools: nativeDevtoolsSchema.optional(),
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
 * The filename is provider-chosen and meaningless to Argent. Several files
 * just mean several providers. Argent keys on `id`. (`providers publish` names
 * the file `<id>.json`, but that is the writer's convention, not the
 * contract's.)
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
  /**
   * The process offering these devices.
   *
   * `argent providers prune` uses it to remove descriptors left behind by a
   * provider that died without withdrawing. The runtime uses it when matching a
   * device by its real udid: a claim from a dead pid does not bind, so a
   * crashed provider cannot keep Argent off a device it owns.
   *
   * Omitting it is safe, the claim binds and nothing cleans up after you.
   */
  pid: z.number().int().min(1).optional(),
  schemaVersion: z.number().int(),
  /**
   * Where Argent points users when something attributed to this provider fails.
   */
  supportUrl: webUrl.optional(),
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
 * A descriptor with every device validated, not just the envelope. What
 * `providers check` and `providers publish` hold. Discovery holds
 * {@linkcode ProviderRecord} instead.
 */
export type ProviderRecordStrict = z.infer<typeof providerRecordSchema>;

/**
 * The same document with the device entries left unvalidated — what the runtime
 * parses with. Under {@linkcode providerRecordSchema} one malformed device
 * would fail the whole document, costing a provider every other device it was
 * offering. Validating them one at a time drops only the bad entry.
 *
 * {@linkcode providerRecordSchema} stays the strict article that `providers
 * check` and `providers publish` use, so a provider is still told about a
 * malformed device rather than silently losing it.
 */
export const providerEnvelopeSchema = providerRecordSchema.extend({
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
  capabilities: ReadonlySet<string>;
  deviceSet?: string;
  /** Canonical Argent device id: `ext:<providerId>:<nativeId>`. */
  id: string;
  jsDebugger?: { webSocketUrl: string };
  kind: "device" | "emulator" | "simulator";
  metroPort?: number;
  name: string;
  nativeDevtools?: { socketPath: string };
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
