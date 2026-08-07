import type { DeviceInfo, FailureCode, Platform, Registry, ToolContext } from "@argent/registry";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { resolveDevice } from "../../utils/device-info";
import { getSimulatorRuntimeKind } from "../../utils/ios-devices";
import { getAndroidRuntimeKind } from "../../utils/adb";
import { getRemoteSimulatorRuntimeKind } from "../../utils/sim-remote";
import { invokeSubTool } from "../../utils/sub-invoke";
import type { FlowRequires, FlowRuntimeKind, FlowStep, WhenPlatform } from "./flow-utils";

/**
 * Device resolution + binding for the flow runner. Flows store no device id
 * (they are portable); the runner resolves one from explicit input, a platform
 * hint, or the single booted device — mirroring the SDK's `device()` binding —
 * and injects it schema-aware into each step's tool args.
 */

// One platform set for the whole flows directory — see LAUNCH_PLATFORMS in
// flow-utils, which this aliases via WhenPlatform.
export type FlowPlatform = WhenPlatform;

/**
 * Arg names that mean "the device to act on".
 *
 * The runner strips these from every recorded step and re-injects the resolved
 * run device, so a name here must mean a device id on EVERY tool that declares
 * one — the strip is schema-blind. `udid` covers most tools, `device_id` the
 * debugger and profiler families, and `device` is `flow-execute`'s own, so a
 * nested flow inherits the run device instead of pinning the one it was
 * recorded on (#607).
 *
 * `platform` is deliberately absent, for two independent reasons. It is only
 * ever read when no device was given — `resolveFlowDevice` returns on
 * `opts.device` before touching it, and the chromium boot spec is gated on
 * `!params.device` — so once `device` is bound it is inert. And it is not
 * device-specific on every tool: `react-profiler-analyze` declares its own
 * `platform`, which a blind strip would silently retarget.
 */
const DEVICE_BIND_KEYS = ["udid", "device_id", "device"] as const;

/**
 * Keys that mean a tool acts on a device. A superset of the keys the runner
 * injects: `device` names one without receiving the run's own (a nested flow
 * takes it that way), and a step that drives a device must count as needing one
 * even when the runner does not hand it over.
 */
const DEVICE_ARG_KEYS = [...DEVICE_BIND_KEYS, "device"] as const;

interface RawDevice {
  platform: FlowPlatform;
  state?: string;
  udid?: string;
  serial?: string;
  id?: string;
  /**
   * TV-vs-mobile verdict, as `list-devices` reports it: free on iOS (read off
   * the simulator runtime id) and already probed on Android (that tool opts
   * into the feature check). Absent when the probe could not answer.
   */
  runtimeKind?: FlowRuntimeKind;
}

function deviceEntryId(d: RawDevice): string | undefined {
  if (d.platform === "ios") return d.udid;
  if (d.platform === "chromium") return d.id;
  return d.serial; // android, vega
}

function isBooted(d: RawDevice): boolean {
  switch (d.platform) {
    case "ios":
      return d.state === "Booted";
    case "android":
      return d.state === "device";
    case "vega":
      return d.state === "running" || d.state === "device";
    case "chromium":
      return true; // a discovered chromium device is, by definition, reachable
    default:
      return false;
  }
}

/**
 * `withRuntimeKind` is off by default: mobile-vs-tv is noise in an ambiguity
 * message and the distinguishing fact in a runtimeKind one, so only the caller
 * whose requirement turns on it asks for it. An unreadable kind is spelled out
 * rather than omitted there — it is the very thing that ruled the device out.
 */
function describeDevice(d: RawDevice, withRuntimeKind = false): string {
  const state = d.state ? `, ${d.state}` : "";
  const kind = withRuntimeKind ? `, ${listedRuntimeKind(d) ?? "kind unknown"}` : "";
  return `${deviceEntryId(d) ?? "?"} (${d.platform}${state}${kind})`;
}

function deviceResolutionError(message: string, all: RawDevice[]): FailureError {
  const list = all.length ? all.map((d) => describeDevice(d)).join(", ") : "none";
  return new FailureError(`${message} Available devices: ${list}.`, {
    error_code: FAILURE_CODES.FLOW_DEVICE_RESOLUTION,
    failure_stage: "flow_device_resolution",
    failure_area: "tool_server",
    error_kind: "validation",
  });
}

// ── Requirements ─────────────────────────────────────────────────────

/**
 * Human-readable form of a `requires` block, for the messages a caller has to
 * act on. Mirrors the YAML spelling so the remedy is the line they wrote.
 */
function describeRequires(requires: FlowRequires): string {
  const parts: string[] = [];
  if (requires.platform) parts.push(`platform: [${requires.platform.join(", ")}]`);
  if (requires.runtimeKind) parts.push(`runtimeKind: ${requires.runtimeKind}`);
  return parts.join(", ");
}

function requirementsError(code: FailureCode, message: string): FailureError {
  return new FailureError(message, {
    error_code: code,
    failure_stage: "flow_requirements",
    failure_area: "tool_server",
    // Validation, not infra: it rejects this one flow and lets a directory run
    // carry on, where an infra failure would stop the whole batch.
    error_kind: "validation",
  });
}

/** The flow does not apply to this target — the code a directory run skips on. */
function requirementsUnmetError(message: string): FailureError {
  return requirementsError(FAILURE_CODES.FLOW_REQUIREMENTS_UNMET, message);
}

/**
 * The requirement could not be checked, so whether the flow applies is unknown —
 * a separate code because skipping on it would hide a broken probe as a filter.
 */
function requirementsUnverifiableError(message: string): FailureError {
  return requirementsError(FAILURE_CODES.FLOW_REQUIREMENTS_UNVERIFIABLE, message);
}

/**
 * Does a platform satisfy a `requires.platform` list? `ios-remote` is an iOS
 * simulator driven through sim-remote, so it counts as `ios` — the same fold
 * the `when: { platform }` guard applies, and for the same reason: the parser
 * accepts no `ios-remote` spelling, so without it no remote sim could ever
 * satisfy an iOS requirement.
 */
function platformMeets(platform: Platform, required: readonly WhenPlatform[]): boolean {
  const folded = platform === "ios-remote" ? "ios" : platform;
  return (required as readonly string[]).includes(folded);
}

/**
 * The runtime kind of a device the runner already holds. The two constant
 * platforms are answered by definition; the rest go through the memoized
 * probes. A simulator's kind is fixed at creation, so its probe costs one
 * `simctl`/`sim-remote` round-trip and nothing after it; the Android one
 * re-lists adb on every call before its memo, so a cached kind can never answer
 * for a serial that has since dropped off.
 *
 * Undefined means "could not be told" — a simulator its listing doesn't know,
 * or an Android target that dropped off adb. Callers refuse rather than waving
 * it through: a TV requirement nobody verified is exactly the silent pass this
 * block exists to prevent.
 */
async function probeRuntimeKind(device: DeviceInfo): Promise<FlowRuntimeKind | undefined> {
  switch (device.platform) {
    case "vega":
      return "tv";
    case "chromium":
      return "mobile";
    case "ios":
      return await getSimulatorRuntimeKind(device.id);
    case "ios-remote":
      return await getRemoteSimulatorRuntimeKind(device.id);
    case "android":
      return await getAndroidRuntimeKind(device.id);
    default:
      return undefined;
  }
}

/**
 * The runtime kind a platform always presents, for the two where it does not
 * vary. Lets a requirement be judged from a platform alone — before a device
 * exists at all, which is the only moment the chromium hoist has.
 */
const CONSTANT_RUNTIME_KIND: Partial<Record<Platform, FlowRuntimeKind>> = {
  chromium: "mobile",
  vega: "tv",
};

/**
 * Throw unless a platform satisfies the flow's requirements. Everything
 * decidable without a device lives here: the platform itself, plus runtimeKind
 * on the platforms whose kind is constant. `subject` names what is being
 * refused, in the caller's terms.
 */
export function assertPlatformMeetsRequires(
  platform: Platform,
  requires: FlowRequires | undefined,
  subject: string
): void {
  if (!requires) return;
  const declared = `This flow declares requires: { ${describeRequires(requires)} }, which excludes`;
  const remedy = "Run it against a matching target, or relax the requirement.";

  if (requires.platform && !platformMeets(platform, requires.platform)) {
    throw requirementsUnmetError(`${declared} ${subject}. ${remedy}`);
  }
  const constant = CONSTANT_RUNTIME_KIND[platform];
  if (requires.runtimeKind && constant && constant !== requires.runtimeKind) {
    throw requirementsUnmetError(
      `${declared} ${subject} — ${platform} is always ${constant}. ${remedy}`
    );
  }
}

/**
 * Throw unless a resolved device satisfies the flow's requirements. Used on
 * every path that produces a run device without going through the auto-detect
 * filter below — an explicit `--device`, and each `run:` fragment as it is
 * reached.
 */
export async function assertDeviceMeetsRequires(
  device: DeviceInfo,
  requires: FlowRequires | undefined
): Promise<void> {
  if (!requires) return;
  assertPlatformMeetsRequires(
    device.platform,
    requires,
    `device ${device.id} (${device.platform})`
  );
  if (!requires.runtimeKind) return;

  const declared = `This flow declares requires: { ${describeRequires(requires)} }.`;
  const kind = await probeRuntimeKind(device);
  if (kind === undefined) {
    throw requirementsUnverifiableError(
      `${declared} The runtime kind of device ${device.id} could not be determined ` +
        `(${device.platform}), so the requirement cannot be verified. Pass a device whose ` +
        `kind is readable, or drop runtimeKind.`
    );
  }
  if (kind !== requires.runtimeKind) {
    throw requirementsUnmetError(
      `${declared} Device ${device.id} is ${kind}, not ${requires.runtimeKind}. ` +
        `Run it against a matching target, or relax the requirement.`
    );
  }
}

/**
 * The runtime kind of a listed device, without re-probing: `list-devices`
 * already carries the verdict for the two platforms that vary, and the other
 * two are constant. Undefined when the listing could not say, which excludes
 * the device from a runtimeKind-constrained run.
 */
function listedRuntimeKind(d: RawDevice): FlowRuntimeKind | undefined {
  if (d.platform === "vega") return "tv";
  if (d.platform === "chromium") return "mobile";
  return d.runtimeKind;
}

function meetsRequires(d: RawDevice, requires: FlowRequires | undefined): boolean {
  if (!requires) return true;
  if (requires.platform && !platformMeets(d.platform, requires.platform)) return false;
  if (requires.runtimeKind && listedRuntimeKind(d) !== requires.runtimeKind) return false;
  return true;
}

/**
 * Resolve the device a flow runs against. Order: explicit `device` id → the
 * single booted device matching `platform` and the flow's requirements → the
 * single booted device overall → throw, enumerating what is available.
 *
 * `requires` narrows the candidates rather than only judging the winner: with
 * a simulator and an emulator both booted, an ios-only flow picks the
 * simulator instead of failing as ambiguous. When it narrows the field to
 * nothing while devices were in fact booted, the throw is
 * FLOW_REQUIREMENTS_UNMET — the code a directory run turns into a skip —
 * rather than a device-resolution failure.
 */
export async function resolveFlowDevice(
  registry: Registry,
  ctx: ToolContext | undefined,
  opts: { device?: string; platform?: FlowPlatform; requires?: FlowRequires }
): Promise<DeviceInfo> {
  if (opts.device) {
    const device = resolveDevice(opts.device);
    await assertDeviceMeetsRequires(device, opts.requires);
    return device;
  }

  const { devices } = (await invokeSubTool(registry, ctx, "list-devices", {})) as {
    devices: RawDevice[];
  };
  const booted = devices.filter(isBooted);
  const scoped = opts.platform ? booted.filter((d) => d.platform === opts.platform) : booted;
  const eligible = scoped.filter((d) => meetsRequires(d, opts.requires));

  if (eligible.length === 1) {
    const id = deviceEntryId(eligible[0]);
    if (id) return resolveDevice(id);
  }
  if (eligible.length === 0) {
    // Requirements are only to blame when something was booted for them to
    // rule out; an empty machine is the plain no-device case either way.
    if (opts.requires && scoped.length > 0) {
      const showKind = opts.requires.runtimeKind !== undefined;
      throw requirementsUnmetError(
        `No booted device satisfies this flow's requires: { ${describeRequires(opts.requires)} }. ` +
          `Available devices: ${scoped.map((d) => describeDevice(d, showKind)).join(", ")}.`
      );
    }
    const what = opts.platform
      ? `No booted ${opts.platform} device found.`
      : "No booted device found.";
    throw deviceResolutionError(`${what} Pass a device id or platform explicitly.`, devices);
  }
  throw deviceResolutionError(
    `${eligible.length} booted devices matched — pass --device or --platform to disambiguate.`,
    eligible
  );
}

/**
 * Strip the device-id keys from a set of args (so a flow stores none).
 *
 * Schema-blind on purpose: `bindDeviceArgs` strips unconditionally and re-injects
 * only what the target tool declares, so a stale id is never forwarded to a tool
 * that does not want it.
 */
export function stripDeviceKeys(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  for (const k of DEVICE_BIND_KEYS) delete out[k];
  return out;
}

/**
 * Bind the resolved device id into a tool's args. The runner is **authoritative**
 * on device: any device id stored in the step is dropped and replaced with the
 * resolved one — so a flow recorded on one device stays portable to another and
 * a stale baked-in udid can't override the run target. The id is injected only
 * for the device-id keys the tool's input schema declares (so `.strict()`
 * schemas stay valid).
 *
 * This covers a nested `tool: flow-execute` step too — its own `device` arg is
 * rebound, so a composed run inherits the run device rather than driving the one
 * it was recorded against, matching how `run:` composition already behaves.
 */
/**
 * Whether a step acts on a device.
 *
 * Answered per kind rather than by trying and failing, so a flow that touches no
 * device never has to have one. The default is that a step DOES need one: a kind
 * added later inherits today's behaviour instead of silently running against no
 * device, and the `never` binding makes leaving it unclassified a compile error.
 *
 * Two of the classifications are worth stating outright:
 *
 * - `when` needs a device whatever its body contains, because the guard itself
 *   reads one — the device's platform, or its view tree.
 * - `run` needs one without the fragment being read here. The flow it names is
 *   resolved at run time; resolving it a second time would duplicate that lookup
 *   and could disagree with it if the file changed in between. The cost is that
 *   composing a narration-only fragment still resolves a device.
 */
export function stepRequiresDevice(registry: Registry, step: FlowStep): boolean {
  switch (step.kind) {
    case "echo":
    case "wait":
      return false;
    case "tool":
      return toolRequiresDevice(registry, step.name);
    case "when":
    case "run":
    case "launch":
    case "tap":
    case "long-press":
    case "type":
    case "await":
    case "assert":
    case "scroll-to":
    case "pinch":
    case "rotate":
    case "snapshot":
      return true;
    default: {
      const unclassified: never = step;
      void unclassified;
      return true;
    }
  }
}

/** Whether any step in a flow acts on a device. */
export function flowRequiresDevice(registry: Registry, steps: FlowStep[]): boolean {
  return steps.some((step) => stepRequiresDevice(registry, step));
}

function toolRequiresDevice(registry: Registry, toolName: string): boolean {
  const toolDef = registry.getTool(toolName);
  // An unknown tool is assumed to need a device: the step is going to fail
  // either way, and it fails more usefully with one resolved.
  if (!toolDef) return true;
  const props = (toolDef.inputSchema as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  // A tool with no declared input takes no device.
  if (!props) return false;
  return DEVICE_ARG_KEYS.some((k) => k in props);
}

export function bindDeviceArgs(
  registry: Registry,
  toolName: string,
  deviceId: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  const toolDef = registry.getTool(toolName);
  const props = (toolDef?.inputSchema as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  const out = stripDeviceKeys(args);
  if (props) {
    for (const k of DEVICE_BIND_KEYS) if (k in props) out[k] = deviceId;
  }
  return out;
}
