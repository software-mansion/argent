import type { DeviceInfo, FailureCode, Platform, Registry, ToolContext } from "@argent/registry";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { resolveDevice } from "../../utils/device-info";
import { getSimulatorRuntimeKind } from "../../utils/ios-devices";
import { getAndroidRuntimeKind } from "../../utils/adb";
import { getRemoteSimulatorRuntimeKind } from "../../utils/sim-remote";
import { invokeSubTool } from "../../utils/sub-invoke";
import {
  blockSteps,
  describeRequires,
  type FlowRequires,
  type FlowRuntimeKind,
  type FlowStep,
  type WhenPlatform,
} from "./flow-utils";

// The flows directory's one platform set — LAUNCH_PLATFORMS in flow-utils,
// reached through WhenPlatform.
export type FlowPlatform = WhenPlatform;

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
 * deliberately not the scope keys in {@link DEVICE_BIND_LIST_KEYS}. Declared
 * keys are only half the question: a target reaching a tool inside an opaque
 * arg is declared on the tool itself, via `ToolDefinition.opaqueDeviceTarget`.
 *
 * What separates target from scope is what a missing device does to the step: a
 * `screenshot` with no `udid` cannot run, while `stop-all-simulator-servers`
 * with no `devices` is the machine-wide sweep — a complete call, and the whole
 * content of a cleanup flow. Listing `devices` here made such a flow demand a
 * device it has no use for, failing it in the two situations it actually runs
 * in: none booted, or several.
 *
 * A scope key is therefore bound OPPORTUNISTICALLY by {@link bindDeviceArgs} —
 * only when the run resolved a device, never as `{ devices: [""] }`, a teardown
 * scoped to an id that owns nothing and so reaps nothing while reporting pass.
 */
const DEVICE_ARG_KEYS = DEVICE_BIND_KEYS;

interface RawDevice {
  // `Platform`, not `FlowPlatform`: `list-devices` also emits `ios-remote`
  // rows, which auto-detect never picks (see `isBooted`) but a refusal still
  // enumerates.
  platform: Platform;
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
  // A remote sim's listed udid already carries the `remote:` prefix that
  // `--device` classifies on (`list-devices` applies `withRemotePrefix`), so
  // the enumerated id is pasteable as-is.
  if (d.platform === "ios" || d.platform === "ios-remote") return d.udid;
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
 * The ambiguity arm is the one that asks for them anyway, in the case where its
 * rows do NOT agree on a kind: an unjudged rival standing beside the matching
 * ones, which is the difference the caller picks a `--device` on.
 */
function describeDevice(d: RawDevice, withRuntimeKind = false): string {
  const state = d.state ? `, ${d.state}` : "";
  const kind = withRuntimeKind ? `, ${listedRuntimeKind(d) ?? "kind unknown"}` : "";
  return `${deviceEntryId(d) ?? "?"} (${d.platform}${state}${kind})`;
}

function deviceResolutionError(
  message: string,
  all: RawDevice[],
  withRuntimeKind = false
): FailureError {
  const list = all.length ? all.map((d) => describeDevice(d, withRuntimeKind)).join(", ") : "none";
  return new FailureError(`${message} Available devices: ${list}.`, {
    error_code: FAILURE_CODES.FLOW_DEVICE_RESOLUTION,
    failure_stage: "flow_device_resolution",
    failure_area: "tool_server",
    error_kind: "validation",
  });
}

// ── Requirements ─────────────────────────────────────────────────────

/**
 * Who declares the block a refusal cites: a block folded across a leading
 * `run:` chain (marked `composed` by foldLeadingRequires) is no single file's
 * declaration, so blaming "this flow" would send the author to a line the root
 * file does not contain.
 */
function declaredRequires(requires: FlowRequires): string {
  const block = `requires: { ${describeRequires(requires)} }`;
  return requires.composed
    ? `This flow and its composed fragments together declare ${block}`
    : `This flow declares ${block}`;
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
 * probes. A simulator's kind is fixed at creation, so once its probe lands a
 * verdict that verdict is free for the life of the process; one answering
 * "unknown" is not
 * memoized on either simulator path, so a directory run against an unlistable
 * udid pays a round-trip per flow. The Android probe re-lists adb on every call
 * before its memo, so a cached kind can never answer for a serial that has
 * since dropped off.
 *
 * Undefined means "could not be told" — a simulator its listing doesn't know,
 * or an Android target that dropped off adb. Callers refuse rather than waving
 * it through: a TV requirement nobody verified is exactly the silent pass this
 * block exists to prevent. A probe whose transport itself fails (sim-remote
 * auth, a broken adb) REJECTS with that failure's own message instead of
 * folding into undefined, so the caller can name the real fault — except the
 * local simulator arm, whose listing degrades a broken xcrun to an empty list
 * and so answers undefined.
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
    default: {
      const unclassified: never = device.platform;
      void unclassified;
      return undefined;
    }
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
  const declared = `${declaredRequires(requires)}, which excludes`;
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

  const declared = `${declaredRequires(requires)}.`;
  let kind: FlowRuntimeKind | undefined;
  try {
    kind = await probeRuntimeKind(device);
  } catch (err) {
    // Still the unverifiable code — a directory run must fail this one flow,
    // not abort the batch — but the probe's own message (sim-remote stderr,
    // auth failures) is what the user has to act on, so carry it verbatim.
    throw requirementsUnverifiableError(
      `${declared} Probing the runtime kind of device ${device.id} (${device.platform}) ` +
        `failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (kind === undefined) {
    throw requirementsUnverifiableError(
      `${declared} The runtime kind of device ${device.id} could not be determined ` +
        `(${device.platform}), so the requirement cannot be verified. Check that the device is ` +
        `listed and its toolchain (xcrun, adb) is working, or drop runtimeKind.`
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
  switch (d.platform) {
    case "vega":
      return "tv";
    case "chromium":
      return "mobile";
    case "ios":
    case "ios-remote":
    case "android":
      return d.runtimeKind;
    default: {
      const unclassified: never = d.platform;
      void unclassified;
      return d.runtimeKind;
    }
  }
}

function meetsRequires(d: RawDevice, requires: FlowRequires | undefined): boolean {
  if (!requires) return true;
  if (requires.platform && !platformMeets(d.platform, requires.platform)) return false;
  if (requires.runtimeKind && listedRuntimeKind(d) !== requires.runtimeKind) return false;
  return true;
}

/**
 * The device enumeration a requirement refusal ends with. Shows the WHOLE
 * listing, as the no-device-found refusal does, rather than the booted and
 * platform-scoped candidates: when a requirement is unmet because the device
 * that would have matched is shut down, offline, or outside the run's
 * `--platform`, that row is the diagnosis, and its state says which.
 */
function availableDevices(all: RawDevice[], requires: FlowRequires): string {
  const showKind = requires.runtimeKind !== undefined;
  return `Available devices: ${all.map((d) => describeDevice(d, showKind)).join(", ")}.`;
}

/**
 * The refusal for candidates the listing could not classify — the empty-field
 * arm, where nothing was judged to match at all. `--device` is deliberately not
 * offered as a remedy: on every platform that can reach this message its probe
 * funnels into the same read the listing already made
 * (`resolveRuntimeKindCached` on android), so it re-asks the question instead of
 * answering it.
 */
function unreadKindError(
  requires: FlowRequires,
  unread: RawDevice[],
  all: RawDevice[]
): FailureError {
  const ids = unread.map((d) => deviceEntryId(d) ?? "?").join(", ");
  return requirementsUnverifiableError(
    `${declaredRequires(requires)}. The runtime kind of ` +
      `${ids} could not be read from the listing, so whether the flow applies is unknown. ` +
      `The device may still be booting: re-list once it is up, or drop ` +
      `runtimeKind. ${availableDevices(all, requires)}`
  );
}

/**
 * `--platform` narrows nothing once every candidate already sits on one
 * platform: filtering by that platform leaves the field untouched, so the rerun
 * would throw the same message again, and any other value empties it.
 */
function disambiguationFlags(field: RawDevice[]): string {
  return field.every((d) => d.platform === field[0].platform)
    ? "--device"
    : "--device or --platform";
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
 * rather than a device-resolution failure. Unless a candidate was ruled out
 * only because its listed kind could not be READ: the requirement was never
 * checked for it, so the throw is FLOW_REQUIREMENTS_UNVERIFIABLE, which a
 * directory run fails on rather than skips. An unjudged rival bars a LONE
 * survivor too — a field holding one was never narrowed to one — but there the
 * survivor's own kind WAS read, so that throw is the ambiguity report a
 * `--device` settles, not an unverifiable requirement.
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
  const requires = opts.requires;
  const eligible = scoped.filter((d) => meetsRequires(d, requires));
  // "Could not be read" is not "wrong kind": a device that passed the platform
  // half but whose listed kind is missing was never judged. Both arms below
  // consult it — an unjudged rival unsettles a lone survivor exactly as it
  // unsettles an empty field.
  const unread = requires?.runtimeKind
    ? scoped.filter(
        (d) =>
          (!requires.platform || platformMeets(d.platform, requires.platform)) &&
          listedRuntimeKind(d) === undefined
      )
    : [];

  if (eligible.length === 1) {
    if (requires && unread.length > 0) {
      const field = [...eligible, ...unread];
      const ids = unread.map((d) => deviceEntryId(d) ?? "?").join(", ");
      throw deviceResolutionError(
        `1 booted device matched, but the runtime kind of ${ids} could not be read from the ` +
          `listing, so the field was never narrowed to one — pass ` +
          `${disambiguationFlags(field)} to disambiguate.`,
        field,
        true
      );
    }
    const id = deviceEntryId(eligible[0]);
    if (id) return resolveDevice(id);
    throw deviceResolutionError(
      `1 booted device matched, but the listing reported no id for it, so it cannot be run ` +
        `against — pass a device id explicitly.`,
      devices
    );
  }
  if (eligible.length === 0) {
    // Requirements are only to blame when something was booted for them to
    // rule out; an empty machine is the plain no-device case either way.
    if (requires && scoped.length > 0) {
      if (unread.length > 0) throw unreadKindError(requires, unread, devices);
      throw requirementsUnmetError(
        (requires.composed
          ? `No booted device satisfies the requires this flow and its composed fragments ` +
            `together declare: `
          : `No booted device satisfies this flow's requires: `) +
          `{ ${describeRequires(requires)} }. ${availableDevices(devices, requires)}`
      );
    }
    const what = opts.platform
      ? `No booted ${opts.platform} device found.`
      : "No booted device found.";
    throw deviceResolutionError(`${what} Pass a device id or platform explicitly.`, devices);
  }
  const flags = disambiguationFlags(eligible);
  // An unjudged rival did not match, but it is a device `--device` could name,
  // and omitting it hides that the field held a judged-vs-unjudged choice at
  // all. It joins the enumeration and never the COUNT, which speaks only for
  // devices the requirement was checked against.
  throw deviceResolutionError(
    `${eligible.length} booted devices matched — pass ${flags} to disambiguate.`,
    [...eligible, ...unread],
    unread.length > 0
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
 *   time, and resolving it again could disagree with that lookup if the file
 *   changed in between. That is the right answer for a `run:` whose body nothing
 *   has read — mid-run, behind a guard, or past a leading chain the scan gave up
 *   on. The run-device decision (`resolveRunDevice`) instead asks
 *   `flowRequiresDevice` about the picture its leading walk already composed,
 *   where a followed `run:` step stands replaced by its body, so composing a
 *   narration-only fragment stays device-free.
 */
export function stepRequiresDevice(registry: Registry, step: FlowStep): boolean {
  switch (step.kind) {
    case "echo":
    case "wait":
      return false;
    case "tool":
      return toolRequiresDevice(registry, step);
    case "when":
    case "run":
    case "launch":
    case "tap":
    case "long-press":
    case "type":
    case "await":
    case "assert":
    case "idle":
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
 * A step whose recorded args already carry every scope key its tool declares
 * narrows nothing: {@link bindDeviceArgs} keeps what the recording scoped unless
 * the caller named the device, so a resolved one would be discarded — and the
 * run must not judge `requires` against a device the step ignores.
 *
 * The walk into a block's body is dead today for the same reason as
 * {@link flowRequiresDevice}'s, and guards the same future block kind: a
 * `devices` scope inside one would be invisible here, so the run would resolve
 * no device and the teardown would sweep the machine.
 */
export function flowScopesDevice(registry: Registry, steps: FlowStep[]): boolean {
  return steps.some(
    (step) =>
      (step.kind === "tool" &&
        declaredKeys(registry, step.name, DEVICE_BIND_LIST_KEYS).some(
          (k) => step.args[k] === undefined
        )) ||
      flowScopesDevice(registry, blockSteps(step) ?? [])
  );
}

function toolRequiresDevice(
  registry: Registry,
  step: Extract<FlowStep, { kind: "tool" }>
): boolean {
  const toolDef = registry.getTool(step.name);
  // An unknown tool is assumed to need a device: the step fails either way, and
  // it fails more usefully with one resolved.
  if (!toolDef) return true;
  // `opaqueDeviceTarget` covers the target a schema cannot show: `flow-add-step`
  // carries the recorded command's device id inside its `args` JSON, so reading
  // declared keys alone left such a flow device-free with its `requires`
  // unjudged. The marker is the TOOL's, so whether THIS step has such a target
  // is read off the call it records.
  if (toolDef.opaqueDeviceTarget === true && opaqueStepTargetsDevice(registry, step.args)) {
    return true;
  }
  return declaresAny(registry, step.name, DEVICE_ARG_KEYS);
}

/**
 * Whether the call an `opaqueDeviceTarget` step records targets a device —
 * `flow-add-step`'s `command` plus the `args` JSON it forwards, the only shape
 * the marker exists for, judged by the same declared keys as a plain `tool:`
 * step. Args that cannot be read (no `command`, an unknown command, `args` that
 * is not JSON) count as needing one: such a step fails either way, and fails
 * more usefully with a device resolved.
 */
function opaqueStepTargetsDevice(registry: Registry, args: Record<string, unknown>): boolean {
  const command = args.command;
  if (typeof command !== "string" || !registry.getTool(command)) return true;
  const recorded = args.args;
  if (recorded !== undefined) {
    if (typeof recorded !== "string") return true;
    try {
      JSON.parse(recorded);
    } catch {
      return true;
    }
  }
  return declaresAny(registry, command, DEVICE_ARG_KEYS);
}

function declaresAny(registry: Registry, toolName: string, keys: readonly string[]): boolean {
  return declaredKeys(registry, toolName, keys).length > 0;
}

function declaredKeys(
  registry: Registry,
  toolName: string,
  keys: readonly string[]
): readonly string[] {
  const toolDef = registry.getTool(toolName);
  const props = (toolDef?.inputSchema as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  if (!props) return [];
  return keys.filter((k) => k in props);
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
