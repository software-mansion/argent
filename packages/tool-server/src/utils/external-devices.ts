/**
 * # External device providers, tool-server side
 *
 * The contract itself lives in
 * [`@argent/device-providers`](../../../device-providers/src/contract.ts). That
 * package is the article to read and to change. This module is the
 * tool-server's half, everything the contract cannot own because it needs the
 * tool-server to work.
 *
 * - `classifyDevice`, passed into the package rather than owned by it, so
 *   Argent keeps exactly one device classifier.
 * - `FailureError`, and the gates that throw one
 *   ({@linkcode assertAllowedSimServerEndpoint},
 *   {@linkcode assertExternalCapability}) and the lookup that reports a
 *   withdrawn device.
 * - The liveness probe, a `list-devices` policy rather than part of the
 *   contract.
 * - The revocation cache, the feature's only remembered state and the reason a
 *   cached service handle can be invalidated mid-session.
 *
 * This module's export set may not shrink — it is what the rest of the
 * tool-server and the CLI bundle resolve the contract through, so the
 * re-export block below is exhaustive by design.
 *
 * The read path's invariants hold through here. It never throws, never caches
 * (the capability map remembers only what was last seen, and is never
 * consulted as an answer) and never unlinks.
 */

import {
  ALLOWED_SIM_SERVER_ENDPOINTS,
  discoverProviders,
  type ExternalCapability,
  type ExternalDevice,
  externalProviderId,
  isExternalId,
  isProcessAlive,
  parseExternalId,
  type ProviderRecord,
  readProviderDevices as readDeclaredDevices,
} from "@argent/device-providers";
import { FAILURE_CODES, FailureError, type DeviceInfo } from "@argent/registry";

/**
 * Circular by design and safe: `device-info.ts` imports the id helpers from
 * here, this module imports `classifyDevice`. Both are function declarations
 * consumed at call time, never during module init.
 */
import { classifyDevice } from "./device-info";

/** The contract, re-exported unchanged. */
export {
  ALLOWED_SIM_SERVER_ENDPOINTS,
  EXTERNAL_CAPABILITIES,
  EXTERNAL_PREFIX,
  type ExternalCapability,
  type ExternalDevice,
  externalNativeId,
  externalProviderId,
  externalProviderLabel,
  isExternalDeviceUrn,
  isExternalId,
  makeExternalId,
  PROVIDER_ID_SHAPE,
  PROVIDER_SCHEMA_VERSION,
  type ProviderDevice,
  providerDeviceSchema,
  type ProviderRecord,
  providerRecordSchema,
  discoverProviders,
  providersDirectory,
  __resetProviderWarningsForTesting,
} from "@argent/device-providers";

const ALLOWED_ENDPOINT_SET: ReadonlySet<string> = new Set(ALLOWED_SIM_SERVER_ENDPOINTS);

/**
 * Throw unless `endpoint` is one Argent's own simulator-server build serves.
 * Called on the attached-server HTTP path only; local servers are Argent's own
 * process and need no restriction.
 *
 * The allowlist is contract and lives in the package; the gate is here because
 * it throws the tool-server's failure type.
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
 * Every device a provider's file currently declares, validated against
 * `classifyDevice` and joined to that provider.
 *
 * The capability bookkeeping is this side's, not the package's:
 * {@linkcode revalidateExternalDevice} compares against it, so every read that
 * could observe a change has to refresh it. Doing that here rather than at each
 * call site is what makes that true by construction.
 */
function readProviderDevices(record: ProviderRecord): ExternalDevice[] {
  const devices = readDeclaredDevices(record, classifyDevice);

  for (const device of devices) {
    lastSeenCapabilities.set(device.id, capabilityKey(device.capabilities));
  }

  return devices;
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
 * The provider claiming `nativeId`, if any; what {@linkcode findExternalDevice}
 * does for an `ext:` id.
 *
 * The simulator watcher and `boot-device` only ever see a device's real UDID,
 * so a gate keyed on the `ext:` spelling never fires for them. Looking the
 * claim up by native id is what binds a grant to the device rather than to one
 * of its names.
 *
 * A claim whose `pid` is dead is ignored, so a provider that crashed without
 * unlinking cannot keep Argent off a device it owns. No `pid` at all still
 * binds.
 */
export function externalClaimForNativeId(nativeId: string): ExternalDevice | undefined {
  /**
   * First, with nothing published this returns after one `readdirSync`, which
   * is what keeps the per-argv call in `adbArgv` sub-millisecond.
   */
  const providers = discoverProviders();
  if (providers.length === 0) return undefined;

  /** The `ext:` spelling has its own path, and no provider declares one. */
  if (isExternalId(nativeId)) return undefined;

  for (const record of providers) {
    if (record.pid !== undefined && !isProcessAlive(record.pid)) continue;

    const device = readProviderDevices(record).find((device) => device.nativeId === nativeId);
    if (device) return device;
  }

  return undefined;
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
  return lookupExternalDeviceNow(id);
}

/** Synchronous body of {@linkcode lookupExternalDevice}: same reads, same errors. */
function lookupExternalDeviceNow(id: string): ExternalDevice {
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
  assertExternalCapabilitySync(namespace, device, capability);
}

/**
 * {@linkcode assertExternalCapability} for the argv builders that cannot
 * await. Every read is a local file read, so the answer is just as current.
 */
export function assertExternalCapabilitySync(
  namespace: string,
  device: DeviceInfo | string,
  capability: ExternalCapability
): void {
  const id = typeof device === "string" ? device : device.id;

  /**
   * Either spelling. A withdrawn `ext:` id is an error, not an ungated device.
   * A raw udid nobody claims is Argent's own and passes straight through.
   */
  const externalDevice = isExternalId(id)
    ? lookupExternalDeviceNow(id)
    : externalClaimForNativeId(id);

  if (!externalDevice) return;

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
