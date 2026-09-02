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
  externalNativeId,
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
 * Every name one device answers to. The `ext:` id and the raw udid / serial the
 * platform's own tooling uses.
 *
 * The registry keys a service by whichever id the caller named, so a device
 * driven by its raw udid caches as `SimulatorServer:<udid>` while the same
 * device named the other way caches as `SimulatorServer:ext:…`. Revocation has
 * to reach both handles and the reading each was built under has to be
 * remembered for both or one spelling keeps serving a grant the other already
 * gave up.
 *
 * The first two entries are derived without the descriptor, so a withdrawal
 * (the case that most needs revoking) is not the one case that cannot resolve
 * its own spellings. `claim` only adds the spelling the caller did not use, so
 * passing `undefined` narrows the answer rather than making it wrong.
 */
function deviceSpellings(deviceId: string, claim: ExternalDevice | undefined): Set<string> {
  const spellings = new Set<string>([deviceId, externalNativeId(deviceId)]);

  if (claim) {
    spellings.add(claim.id);
    spellings.add(claim.nativeId);
  }

  return spellings;
}

/**
 * Does a URN payload name this device?
 *
 * `parseURN` splits on the first colon only, so the payload is whatever the
 * blueprint chose. Most namespaces make it the device id alone. The three that
 * key a Metro session on a `(port, device)` pair put the port first:
 * `JsRuntimeDebugger` and `NetworkInspector` and `ReactProfilerSession` built
 * on it. Those three are also the CDP-speaking services, gated only in the
 * factory, so a sweep anchored at the start of the payload misses exactly the
 * handles that most need dropping.
 *
 * Hence a segment match rather than a prefix. The id has to sit between
 * delimiters and splitting on colons would not do it, because an `ext:` id
 * carries two of its own. So this scans for the whole spelling and reads what
 * borders it. A trailing `#` counts, for a namespace that appends a transport
 * tag.
 *
 * A segment match also stops `emulator-5554` from claiming the services of
 * `emulator-55545`.
 */
function payloadNamesDevice(payload: string, spelling: string): boolean {
  let from = 0;

  while (from <= payload.length) {
    const at = payload.indexOf(spelling, from);
    if (at < 0) return false;

    const before = at === 0 ? ":" : payload[at - 1];
    const after = payload[at + spelling.length] ?? "";

    if (before === ":" && (after === "" || after === ":" || after === "#")) return true;

    from = at + 1;
  }

  return false;
}

/**
 * Drop every cached service handle bound to `deviceId`.
 *
 * Used when a provider withdraws a device or narrows its capabilities, since
 * the registry would otherwise keep serving from a handle resolved while the
 * old answer held. Every external `dispose()` is a no-op, so this forgets
 * state without touching the provider's processes.
 *
 * Throws if any handle survived, having first tried all of them. Both halves
 * matter. Stopping at the first rejection would leave the handles behind it
 * warm and each one is a door to the grant being revoked, so a single wedged
 * teardown must not shield the rest. Reporting the failure rather than
 * returning is what lets the caller refuse the request: a partial sweep cannot
 * be told apart from a complete one by its return value and the one thing that
 * must not happen next is dispatching to a service the provider has taken back.
 */
export async function disposeExternalDeviceServices(
  registry: {
    disposeService(urn: string): Promise<void>;
    getSnapshot(): { services: ReadonlyMap<string, unknown> };
  },
  deviceId: string
): Promise<string[]> {
  const spellings = deviceSpellings(deviceId, externalClaimForAnyId(deviceId));
  const disposed: string[] = [];
  const survived: string[] = [];

  for (const urn of registry.getSnapshot().services.keys()) {
    const separator = urn.indexOf(":");
    if (separator < 0) continue;

    const payload = urn.slice(separator + 1);

    if (![...spellings].some((spelling) => payloadNamesDevice(payload, spelling))) continue;

    try {
      await registry.disposeService(urn);
      disposed.push(urn);
    } catch (error) {
      survived.push(`${urn} (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  if (survived.length > 0) {
    throw new FailureError(
      `Could not drop every cached service for '${deviceId}', so the grant its provider ` +
        `changed may still be reachable: ${survived.join("; ")}`,
      {
        error_code: FAILURE_CODES.EXTERNAL_DEVICE_REVOCATION_INCOMPLETE,
        error_kind: "unknown",
        failure_area: "tool_server",
        failure_stage: "external_device_revocation",
      }
    );
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
  inFlightRevocations.clear();
}

/**
 * Every device a provider's file currently declares, validated against
 * `classifyDevice` and joined to that provider.
 *
 * Deliberately does not touch the capability bookkeeping
 * {@linkcode enforceExternalDeviceGrant} compares against. Refreshing it from
 * every read is what a reader expects and it is exactly wrong. The baseline
 * has to be the grant a cached service was built under, so a plain read between
 * two dispatches (`list-devices`, a watcher tick, an argv builder resolving a
 * claim) would move it past the change it exists to catch.
 */
function readProviderDevices(record: ProviderRecord): ExternalDevice[] {
  return readDeclaredDevices(record, classifyDevice);
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
 * The provider claiming `id` under either of its spellings, the `ext:` id or
 * the raw udid / serial the platform's own tooling uses.
 *
 * {@linkcode assertExternalCapabilitySync} already accepts both, because a
 * grant binds to the device and not to one of its names. Everything that then
 * resolves what to drive has to agree with it (a lent devtools socket, a
 * published Metro port or CDP socket, a simulator-server already running). When
 * only the gate resolves both, a raw id passes the check and is then driven as
 * if Argent owned the device (a second simulator-server spawned beside the
 * provider's, our injection dylib armed over theirs, our CDP client evicting
 * their debugger). Reach for this rather than `isExternalId` wherever the
 * answer decides how a device is driven.
 */
export function externalClaimForAnyId(id: string): ExternalDevice | undefined {
  return isExternalId(id) ? findExternalDevice(id) : externalClaimForNativeId(id);
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
 * The grant each device was last dispatched under, keyed by every spelling it
 * answers to. Comparing against this is how a mid-session capability change or
 * a withdrawn device invalidates a service the registry has cached and would
 * otherwise keep serving.
 *
 * Written only by {@linkcode enforceExternalDeviceGrant}, which runs at the
 * HTTP edge immediately before the factory that builds those services and only
 * once that call has finished dropping the handles the old reading built. That
 * is what makes an entry mean "the reading the warm handle was built from"
 * rather than "the last thing anything happened to read".
 */
const lastSeenCapabilities = new Map<string, string>();

/**
 * The sweep currently running for a device, keyed by every spelling it answers
 * to, so a second dispatch can wait it out instead of racing it.
 *
 * @see {@linkcode enforceExternalDeviceGrant}
 */
const inFlightRevocations = new Map<string, Promise<unknown>>();

function capabilityKey(capabilities: ReadonlySet<string>): string {
  return Array.from(capabilities).sort().join(",");
}

/**
 * Record the reading a warm handle may now be built from, under every spelling
 * at once. `undefined` means the device is gone, so there is no reading to
 * keep.
 */
function rememberGrant(spellings: ReadonlySet<string>, current: string | undefined): void {
  for (const spelling of spellings) {
    if (current === undefined) lastSeenCapabilities.delete(spelling);
    else lastSeenCapabilities.set(spelling, current);
  }
}

/**
 * Re-read an external device's descriptor and, if anything a cached service
 * depends on has changed, drop those services before the caller dispatches.
 *
 * Reads the file every time, with no TTL. That is affordable because the file
 * is small and local (the same reasoning that lets the feature-flag layer
 * re-read `~/.argent/flags.json` per request) and it means a withdrawn device
 * or a narrowed capability set takes effect on the next tool call rather than
 * within a cache window.
 *
 * The reading and the sweep are one step, deliberately. They used to be two
 * calls at the dispatch edge, which left the baseline recorded while the sweep
 * was still running. A second request arriving in that window compared against
 * the new reading, concluded nothing had changed and dispatched into a handle
 * the sweep had not reached yet, built under the grant the provider had just
 * taken back. So the baseline moves only once every handle is gone and a
 * concurrent caller waits for the sweep rather than reading past it.
 *
 * Throws if the sweep could not finish, leaving the baseline where it was so
 * the next call tries again rather than treating the revocation as spent.
 */
export async function enforceExternalDeviceGrant(
  registry: {
    disposeService(urn: string): Promise<void>;
    getSnapshot(): { services: ReadonlyMap<string, unknown> };
  },
  id: string
): Promise<{ reason?: string; stale: boolean }> {
  /*
   * Whatever this device has in flight, under any of its names. Re-checked
   * after each wait, since waiting is what lets another caller start one.
   */
  for (;;) {
    const spellings = deviceSpellings(id, externalClaimForAnyId(id));

    const running = [...spellings]
      .map((spelling) => inFlightRevocations.get(spelling))
      .find((sweep) => sweep !== undefined);

    if (!running) break;
    await running.catch(() => {});
  }

  /**
   * Every spelling, read and written together, because a grant binds to the
   * device rather than to one of its names. A session that has only ever named
   * the `ext:` id still has to answer for the `SimulatorServer:<udid>` handle
   * something else warmed and the reverse.
   */
  const device = externalClaimForAnyId(id);
  const spellings = deviceSpellings(id, device);
  const previous = [...spellings]
    .map((spelling) => lastSeenCapabilities.get(spelling))
    .find((seen) => seen !== undefined);
  const current = device ? capabilityKey(device.capabilities) : undefined;

  if (previous === undefined || previous === current) {
    rememberGrant(spellings, current);
    return { stale: false };
  }

  const reason =
    device === undefined
      ? "the device is no longer offered by its provider"
      : "its provider changed the capabilities it grants";

  const sweep = disposeExternalDeviceServices(registry, id);
  for (const spelling of spellings) inFlightRevocations.set(spelling, sweep);

  try {
    await sweep;
  } finally {
    for (const spelling of spellings) {
      if (inFlightRevocations.get(spelling) === sweep) inFlightRevocations.delete(spelling);
    }
  }

  rememberGrant(spellings, current);

  return { reason, stale: true };
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
