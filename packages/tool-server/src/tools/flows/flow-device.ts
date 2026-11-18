import type { DeviceInfo, FailureCode, Platform, Registry, ToolContext } from "@argent/registry";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { getAndroidRuntimeKind } from "../../utils/adb";
import { MACOS_APPS_FLAG_OFF_REASON, macosAppsUnavailableReason } from "../../utils/capability";
import { isIosPhysicalDevice, resolveDevice } from "../../utils/device-info";
import { externalNativeId } from "../../utils/external-devices";
import { getSimulatorRuntimeKind } from "../../utils/ios-devices";
import { getRemoteSimulatorRuntimeKind } from "../../utils/sim-remote";
import { invokeSubTool } from "../../utils/sub-invoke";
import {
  authoringPlatform,
  blockSteps,
  type FlowRequires,
  type FlowRuntimeKind,
  type FlowStep,
  type SelectablePlatform,
} from "./flow-utils";

/**
 * The platforms a run can be pointed at — SELECTABLE_PLATFORMS in flow-utils.
 * Wider than the authoring set by `ios-remote`: a remote simulator is a device
 * a run can select, never something a flow file names.
 */
export type FlowPlatform = SelectablePlatform;

/**
 * Arg names that mean "the device to act on". Stripped from every recorded step
 * and re-injected with the resolved run device, so a name here must mean a
 * device id on EVERY tool that declares one — the strip is schema-blind.
 * `device` is `flow-execute`'s own, so a nested flow inherits the run device
 * instead of pinning the one it was recorded on (#607).
 *
 * `platform` is deliberately absent: it is not device-specific on every tool
 * (`react-profiler-analyze` declares its own, which a blind strip would
 * retarget), and it is read only when no device was given, so binding it would
 * change nothing.
 */
const DEVICE_BIND_KEYS = ["udid", "device_id", "device"] as const;

/**
 * Args keys holding a LIST of device ids. Same treatment as
 * {@link DEVICE_BIND_KEYS}, but rebound to `[deviceId]`, since a run resolves
 * exactly one device and a flow that named several would be naming the
 * recording host's.
 *
 * `stop-all-simulator-servers`' `devices` is the only such key, and it is a
 * scope rather than a target: a recording of the UNSCOPED sweep rebinds to the
 * run device (binding can only narrow, and the replay must not reap devices
 * another agent is mid-session on), while a recorded scope is the flow's own
 * statement of what to reap and is overridden only by an explicit `device` —
 * see {@link bindDeviceArgs}, where the two cases part.
 */
const DEVICE_BIND_LIST_KEYS = ["devices"] as const;

/**
 * Keys that mean a tool needs a device to act on at all — the TARGET keys, and
 * deliberately not the scope keys in {@link DEVICE_BIND_LIST_KEYS}. What
 * separates them is what a missing device does to the step: a `screenshot` with
 * no `udid` cannot run, while `stop-all-simulator-servers` with no `devices` is
 * the machine-wide sweep — a complete call, and the whole content of a cleanup
 * flow. Listing `devices` here made such a flow demand a device it has no use
 * for, failing it in the two situations it actually runs in: none booted, or
 * several.
 *
 * A scope key is therefore bound OPPORTUNISTICALLY by {@link bindDeviceArgs} —
 * only when the run resolved a device, never as `{ devices: [""] }`, a teardown
 * scoped to an id that owns nothing and so reaps nothing while reporting pass.
 */
const DEVICE_ARG_KEYS = DEVICE_BIND_KEYS;

interface RawDevice {
  platform: FlowPlatform | "harmony";
  state?: string;
  udid?: string;
  serial?: string;
  id?: string;
  /** Physical iPhone when kind is "device". */
  kind?: string;
  runtimeKind?: FlowRuntimeKind;
}

function deviceEntryId(d: RawDevice): string | undefined {
  // A remote row carries `udid` too (the `remote:`-prefixed id), not `serial`.
  // `harmony` is not auto-resolvable (`isBooted` has no arm) but may be named:
  // coordinate steps and `snapshot` run there.
  if (d.platform === "ios" || d.platform === "ios-remote" || d.platform === "harmony") {
    return d.udid;
  }
  // A Mac app row carries its `macos-app-<bundle id>` id, as a Chromium row does.
  if (d.platform === "chromium" || d.platform === "macos") return d.id;
  return d.serial; // android, vega
}

function isBooted(d: RawDevice, platform?: FlowPlatform): boolean {
  switch (d.platform) {
    case "ios":
      // Simulators only. A physical iPhone reports `connected` and is never
      // auto-bound: a flow written for a simulator must not run on real
      // hardware because a phone happens to be on the cable, and a cabled
      // phone must not turn a lone booted simulator into an ambiguity. Name
      // the phone with `device` to run on it.
      return d.state === "Booted";
    case "ios-remote":
      // A remote simulator reports the same simctl states as a local one, and
      // carries none of the physical-device ambiguity above: `ios-remote` is
      // always kind "simulator" (utils/device-info.ts).
      return d.state === "Booted";
    case "android":
      return d.state === "device";
    case "vega":
      return d.state === "running" || d.state === "device";
    case "chromium":
      return true; // a discovered chromium device is, by definition, reachable
    case "macos":
      // list-devices lists only the Mac apps argent started and that still
      // run, so a listed app is reachable. It is picked only for `--platform
      // macos`: apps that other agents keep running would make every other run
      // ambiguous, and a cleanup flow would then run unscoped.
      return platform === "macos";
    default:
      return false;
  }
}

/**
 * A connected physical iPhone is listed but never auto-bound, so when nothing
 * qualifies the error says how to run on it. Silent when the run was scoped to
 * another platform.
 */
function connectedIosDeviceHint(devices: RawDevice[], platform?: FlowPlatform): string {
  if (platform && platform !== "ios") return "";
  const ids = devices
    .filter((d) => d.platform === "ios" && d.kind === "device" && d.state === "connected")
    .map((d) => d.udid)
    .filter((id): id is string => Boolean(id));
  if (ids.length === 0) return "";
  return (
    ` A physical iPhone is connected (${ids.join(", ")}); hardware is never picked ` +
    `automatically, pass device <udid> (--device on the CLI) to run on it.`
  );
}

/** A listed Mac app is not picked without `--platform macos` ({@link isBooted}). */
function macosAppHint(devices: RawDevice[], platform?: FlowPlatform): string {
  if (platform || !devices.some((d) => d.platform === "macos")) return "";
  return " A Mac app is picked only with --platform macos or --device.";
}

/**
 * Why `--platform macos` found nothing, when list-devices adds no Mac app at
 * all: the flag is off, or the host is not a Mac. Without it the plain "no
 * device" message would send the caller looking for an app that is running.
 */
function macosFlagHint(platform?: FlowPlatform): string {
  const reason = platform === "macos" ? macosAppsUnavailableReason() : null;
  if (!reason) return "";
  return reason === MACOS_APPS_FLAG_OFF_REASON
    ? " The macos-apps flag is off, so no Mac app is listed. Run: argent enable macos-apps."
    : ` No Mac app is listed: ${reason}.`;
}

function describeDevice(d: RawDevice): string {
  return `${deviceEntryId(d) ?? "?"} (${d.platform}${d.state ? `, ${d.state}` : ""})`;
}

/** With `all`, the message lists the available devices. */
export function deviceResolutionError(message: string, all?: RawDevice[]): FailureError {
  const list = all ? ` Available devices: ${all.map(describeDevice).join(", ") || "none"}.` : "";
  return new FailureError(message + list, {
    error_code: FAILURE_CODES.FLOW_DEVICE_RESOLUTION,
    failure_stage: "flow_device_resolution",
    failure_area: "tool_server",
    error_kind: "validation",
  });
}

function describeRequires(requires: FlowRequires): string {
  const parts: string[] = [];
  if (requires.platform) parts.push(`platform: [${requires.platform.join(", ")}]`);
  if (requires.runtimeKind) parts.push(`runtimeKind: ${requires.runtimeKind}`);
  return `requires: { ${parts.join(", ")} }`;
}

function requirementsError(
  message: string,
  code: FailureCode = FAILURE_CODES.FLOW_REQUIREMENTS_UNMET
): FailureError {
  return new FailureError(message, {
    error_code: code,
    failure_stage: "flow_requirements",
    failure_area: "tool_server",
    error_kind: "validation",
  });
}

/** The runtime kinds of the platforms that have only one. HarmonyOS support covers phones only. */
const CONSTANT_RUNTIME_KIND: Partial<Record<Platform, FlowRuntimeKind>> = {
  chromium: "mobile",
  harmony: "mobile",
  vega: "tv",
};

function platformMeets(platform: Platform, requires: FlowRequires): boolean {
  if (requires.platform && !(requires.platform as string[]).includes(authoringPlatform(platform))) {
    return false;
  }
  // A Mac app is neither a tv nor a mobile target.
  if (requires.runtimeKind && platform === "macos") return false;
  const constant = CONSTANT_RUNTIME_KIND[platform];
  return !(requires.runtimeKind && constant && constant !== requires.runtimeKind);
}

/** Throw unless `platform` can satisfy the flow's requirements; `target` names it in the error. */
export function assertPlatformMeetsRequires(
  platform: Platform,
  requires: FlowRequires | undefined,
  target: string,
  subject = "This e2e test"
): void {
  if (!requires || platformMeets(platform, requires)) return;
  throw requirementsError(
    `${subject} declares ${describeRequires(requires)}, which excludes ${target}.`
  );
}

async function probeRuntimeKind(device: DeviceInfo): Promise<FlowRuntimeKind | undefined> {
  const constant = CONSTANT_RUNTIME_KIND[device.platform];
  if (constant) return constant;
  if (isIosPhysicalDevice(device)) return "mobile";
  switch (device.platform) {
    case "ios":
      return getSimulatorRuntimeKind(device.id);
    case "ios-remote":
      return getRemoteSimulatorRuntimeKind(device.id);
    case "android":
      return getAndroidRuntimeKind(externalNativeId(device.id));
    default:
      return undefined;
  }
}

/** Throw unless a resolved device satisfies the flow's requirements. */
export async function assertDeviceMeetsRequires(
  device: DeviceInfo,
  requires: FlowRequires | undefined,
  subject = "This e2e test"
): Promise<void> {
  if (!requires) return;
  assertPlatformMeetsRequires(
    device.platform,
    requires,
    `device ${device.id} (${device.platform})`,
    subject
  );
  if (!requires.runtimeKind) return;
  const kind = await probeRuntimeKind(device);
  if (kind === undefined) {
    throw unknownRuntimeKindError(requires, [`${device.id} (${device.platform})`], subject);
  }
  if (kind !== requires.runtimeKind) {
    throw requirementsError(
      `${subject} declares ${describeRequires(requires)}, which excludes device ` +
        `${device.id} (${device.platform}, ${kind}).`
    );
  }
}

/** Unknown is not a mismatch: a directory run would skip the test and hide the broken probe. */
function unknownRuntimeKindError(
  requires: FlowRequires,
  devices: string[],
  subject = "This e2e test",
  remedy = ""
): FailureError {
  return requirementsError(
    `${subject} declares ${describeRequires(requires)}, but the runtime kind of ` +
      `${devices.join(", ")} could not be determined.${remedy}`,
    FAILURE_CODES.FLOW_DEVICE_RESOLUTION
  );
}

function listedRuntimeKind(d: RawDevice): FlowRuntimeKind | undefined {
  return CONSTANT_RUNTIME_KIND[d.platform] ?? d.runtimeKind;
}

/** Probes when the listing has no kind, as for an external device or a probe that timed out. */
async function candidateRuntimeKind(d: RawDevice): Promise<FlowRuntimeKind | undefined> {
  const id = deviceEntryId(d);
  return listedRuntimeKind(d) ?? (id ? probeRuntimeKind(resolveDevice(id)) : undefined);
}

/**
 * Resolve the device a flow runs against. Order: explicit `device` id → the
 * single booted device of `platform` → the single booted device overall →
 * throw, enumerating what is available. A physical iPhone is reachable only
 * through the explicit id, and a Mac app only through it or `platform`; see
 * {@link isBooted}. `requires` narrows the booted candidates.
 *
 * An explicit Mac app id is refused while the macos-apps flag is off, or off
 * macOS. The id classifies by its shape alone and skips the device list, which
 * is where the flag and the host check hide Mac apps, so without this check a
 * flow would go on to steps that can never run here.
 */
export async function resolveFlowDevice(
  registry: Registry,
  ctx: ToolContext | undefined,
  opts: { device?: string; platform?: FlowPlatform; requires?: FlowRequires }
): Promise<DeviceInfo> {
  if (opts.device) {
    const device = resolveDevice(opts.device);
    const macosRefusal = device.platform === "macos" ? macosAppsUnavailableReason() : null;
    if (macosRefusal) throw deviceResolutionError(`Cannot run on ${device.id}: ${macosRefusal}`);
    return device;
  }

  const { devices } = (await invokeSubTool(registry, ctx, "list-devices", {})) as {
    devices: RawDevice[];
  };
  const booted = devices.filter((d) => isBooted(d, opts.platform));
  const scoped = opts.platform ? booted.filter((d) => d.platform === opts.platform) : booted;
  const requires = opts.requires;
  const candidates = requires ? scoped.filter((d) => platformMeets(d.platform, requires)) : scoped;
  const kinds = new Map<RawDevice, FlowRuntimeKind | undefined>();
  if (requires?.runtimeKind) {
    const wanted = requires.runtimeKind;
    const anyMatch = () => candidates.some((d) => kinds.get(d) === wanted);
    for (const d of candidates) kinds.set(d, listedRuntimeKind(d));
    // A listed match is enough: probing the other devices can hang on a frozen one.
    if (!anyMatch()) {
      for (const d of candidates) {
        if (kinds.get(d) === undefined) kinds.set(d, await candidateRuntimeKind(d));
      }
      const unknown = candidates.filter((d) => kinds.get(d) === undefined);
      if (!anyMatch() && unknown.length > 0) {
        throw unknownRuntimeKindError(
          requires,
          unknown.map(describeDevice),
          undefined,
          " Pass --device or --platform to choose a device."
        );
      }
    }
  }
  const eligible = requires?.runtimeKind
    ? candidates.filter((d) => kinds.get(d) === requires.runtimeKind)
    : candidates;

  if (eligible.length === 1) {
    const id = deviceEntryId(eligible[0]);
    if (id) return resolveDevice(id);
  }
  if (eligible.length === 0 && requires && scoped.length > 0) {
    const listed = scoped.map((d) => {
      const known = kinds.get(d) ?? listedRuntimeKind(d);
      const kind = requires.runtimeKind ? `, ${known ?? "kind unknown"}` : "";
      return `${deviceEntryId(d) ?? "?"} (${d.platform}${kind})`;
    });
    throw requirementsError(
      `No booted device satisfies this e2e test's ${describeRequires(requires)}. ` +
        `Booted devices: ${listed.join(", ")}.`
    );
  }
  if (eligible.length === 0) {
    const what = opts.platform
      ? `No booted ${opts.platform} device found.`
      : "No booted device found.";
    throw deviceResolutionError(
      `${what} Pass a device id or platform explicitly.${connectedIosDeviceHint(devices, opts.platform)}${macosAppHint(devices, opts.platform)}${macosFlagHint(opts.platform)}`,
      devices
    );
  }
  throw deviceResolutionError(
    `${eligible.length} booted devices matched — pass --device or --platform to disambiguate.`,
    eligible
  );
}

/**
 * Strip the device-TARGET keys from a set of args, so a recorded flow stores no
 * device to point at. Schema-blind on purpose: {@link bindDeviceArgs} re-injects
 * only what the target tool declares, so a stale id is never forwarded to a tool
 * that does not want it.
 *
 * A SCOPE survives into the YAML because dropping it changes what the recorded
 * step MEANS: a correctly scoped teardown would record as a bare
 * `- tool: stop-all-simulator-servers`, and hand-running that reaps every device
 * on the machine. Losing `devices` fails OPEN, where a `screenshot` that lost its
 * required `udid` fails loudly. Replay rebinds it either way, and recorded ids
 * cost only a no-op plus an `unmatched` report on another host.
 */
export function stripDeviceKeys(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  for (const k of DEVICE_BIND_KEYS) delete out[k];
  return out;
}

/**
 * Whether a step acts on a device.
 *
 * Answered per kind rather than by trying and failing, so a flow that touches no
 * device never has to have one. Unclassified defaults to needing one, and the
 * `never` binding makes leaving a new kind unclassified a compile error.
 *
 * Three of the classifications are worth stating outright:
 *
 * - `when` needs a device whatever its body contains, because the guard itself
 *   reads one — the device's platform, or its view tree. That classifies the
 *   header alone; the body is left to {@link flowRequiresDevice}'s walk.
 * - `idle` needs one despite carrying no selector: it reads the device twice
 *   over, the UI tree and a screenshot of it.
 * - `run` needs one without the fragment being read here: it is resolved at run
 *   time, so composing a narration-only fragment still resolves a device.
 */
export function stepRequiresDevice(registry: Registry, step: FlowStep): boolean {
  switch (step.kind) {
    case "echo":
    case "wait":
    case "script":
      return false;
    case "tool":
      return toolRequiresDevice(registry, step.name);
    case "when":
    case "run":
    case "launch":
    case "tap":
    case "long-press":
    case "swipe":
    case "type":
    case "await":
    case "assert":
    case "idle":
    case "scroll-to":
    case "pinch":
    case "rotate":
    case "fold":
    case "snapshot":
      return true;
    default: {
      const unclassified: never = step;
      void unclassified;
      return true;
    }
  }
}

/**
 * Whether any step in a flow acts on a device - each block header's own
 * classification OR, via {@link blockSteps}, the steps it actually CONTAINS.
 *
 * The child walk answers nothing today: `when`, the only block kind, classifies
 * device-requiring in {@link stepRequiresDevice}. It is what makes a future
 * block kind safe to classify `false` — a flow that is only such a block would
 * otherwise resolve device-free and hard-stop on the first device step in its
 * body.
 */
export function flowRequiresDevice(registry: Registry, steps: FlowStep[]): boolean {
  return steps.some(
    (step) =>
      stepRequiresDevice(registry, step) || flowRequiresDevice(registry, blockSteps(step) ?? [])
  );
}

/**
 * Whether any step would NARROW itself to the run device if one were resolved,
 * without needing one to run — a `devices` scope, and only that today.
 *
 * Asked of a flow that {@link flowRequiresDevice} said no to, so the run has a
 * choice: resolve a device opportunistically and scope the teardown to it, or,
 * where no single device is resolvable, run the step's unscoped meaning rather
 * than failing a flow whose whole purpose is to clear the machine.
 *
 * The walk into a block's body is dead today for the same reason as
 * {@link flowRequiresDevice}'s, and guards the same future block kind: a
 * `devices` scope inside one would be invisible here, so the run would resolve
 * no device and the teardown would sweep the machine.
 */
export function flowScopesDevice(registry: Registry, steps: FlowStep[]): boolean {
  return steps.some(
    (step) =>
      (step.kind === "tool" && declaresAny(registry, step.name, DEVICE_BIND_LIST_KEYS)) ||
      flowScopesDevice(registry, blockSteps(step) ?? [])
  );
}

function toolRequiresDevice(registry: Registry, toolName: string): boolean {
  // An unknown tool is assumed to need a device: the step fails either way, and
  // it fails more usefully with one resolved.
  if (!registry.getTool(toolName)) return true;
  return declaresAny(registry, toolName, DEVICE_ARG_KEYS);
}

function declaresAny(registry: Registry, toolName: string, keys: readonly string[]): boolean {
  const toolDef = registry.getTool(toolName);
  const props = (toolDef?.inputSchema as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  if (!props) return false;
  return keys.some((k) => k in props);
}

/**
 * Bind the resolved device id into a tool's args. The runner is authoritative on
 * the device to act ON: any device id stored in the step is dropped and replaced
 * with the resolved one, so a flow recorded on one device stays portable and a
 * stale baked-in udid cannot override the run target. The id is injected only
 * for the device-id keys the tool's input schema declares (so `.strict()`
 * schemas stay valid), bare or as a one-element list depending on which set the
 * key is in.
 *
 * It is NOT authoritative on a device SCOPE it did not resolve from the caller;
 * `deviceIsExplicit` is what tells the two apart.
 */
export function bindDeviceArgs(
  registry: Registry,
  toolName: string,
  deviceId: string,
  args: Record<string, unknown>,
  deviceIsExplicit = false
): Record<string, unknown> {
  const toolDef = registry.getTool(toolName);
  const props = (toolDef?.inputSchema as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  const out = stripDeviceKeys(args);
  for (const k of DEVICE_BIND_LIST_KEYS) {
    // Never forward a scope to a tool that does not declare it — a `.strict()`
    // schema would reject the whole call.
    if (!props || !(k in props)) {
      delete out[k];
      continue;
    }
    // `[""]` is never bound: an id that owns nothing reaps nothing and still
    // reports pass.
    if (!deviceId) continue;
    // With NO recorded scope the run device NARROWS what the step would
    // otherwise do — an unscoped `stop-all-simulator-servers` is the
    // machine-wide sweep — so bind it whatever resolved it.
    if (out[k] === undefined) {
      out[k] = [deviceId];
      continue;
    }
    // With one recorded, OVERRIDING it is destructive rather than portable: a
    // flow that named device A would tear down whichever device happened to
    // resolve, the cross-agent teardown the `devices` scope was added to
    // prevent. Only an explicit `device` overrides — there the caller named the
    // run target itself. An auto-resolved one names nobody's intent, so the
    // recorded ids stand and on another host come back in `unmatched`.
    if (deviceIsExplicit) out[k] = [deviceId];
  }
  if (props) for (const k of DEVICE_BIND_KEYS) if (k in props) out[k] = deviceId;
  return out;
}
