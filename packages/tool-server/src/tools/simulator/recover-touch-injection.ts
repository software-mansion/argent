import { z } from "zod";
import { ServiceState, isLiveServiceState, parseURN } from "@argent/registry";
import type { Registry, ToolCapability, ToolDefinition } from "@argent/registry";
import { SIMULATOR_SERVER_NAMESPACE } from "../../blueprints/simulator-server";
import { NATIVE_DEVTOOLS_NAMESPACE } from "../../blueprints/native-devtools";
import { AX_SERVICE_NAMESPACE } from "../../blueprints/ax-service";
import { TV_CONTROL_NAMESPACE } from "../../blueprints/tv-control";
import { classifyDevice, resolveDevice } from "../../utils/device-info";
import { listIosSimulators } from "../../utils/ios-devices";
import { simctlTargetForUdid } from "../../utils/ios-device-sets";
import {
  recoverCoreSimulatorInjection,
  recoverySucceeded,
  type RecoveryStep,
} from "../../utils/coresimulator-recovery";

const zodSchema = z.object({
  // `.min(1)` is load-bearing: http.ts skips the capability gate on a falsy device arg.
  udid: z.string().min(1).describe("Target iOS simulator UDID from `list-devices`."),
  rebootAfter: z
    .boolean()
    .optional()
    .describe(
      "Boot the device back up after the daemon restart, and wait for it to finish booting. " +
        "Default true. Set false to leave the device shut down (e.g. to re-boot it yourself)."
    ),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  recovered: boolean;
  udid: string;
  disposedServices: string[];
  steps: RecoveryStep[];
  note: string;
}

// Local iOS simulators only: the CoreSimulator daemon is a local-macOS concept.
// Remote sims, physical iOS devices, Android and Chromium have no host daemon to
// restart, so the dispatcher rejects them.
const capability: ToolCapability = {
  apple: { simulator: true },
};

// Service namespaces that can hold a live handle onto a CoreSimulator session.
// The daemon restart is host-wide, so every local Apple simulator's handles go
// stale, not just the target's — all are disposed up front and respawn lazily.
const CORESIM_NAMESPACES: string[] = [
  SIMULATOR_SERVER_NAMESPACE,
  NATIVE_DEVTOOLS_NAMESPACE,
  AX_SERVICE_NAMESPACE,
  TV_CONTROL_NAMESPACE,
];

/**
 * Extract the device id from a service URN in a CoreSimulator-backed namespace,
 * or null when out of scope. Strips the optional `:tcp` transport suffix and
 * keeps only ids that classify as local iOS (remote ids and Android serials skip).
 */
function coreSimDeviceId(urn: string): string | null {
  const { namespace, payload } = parseURN(urn);
  if (!CORESIM_NAMESPACES.includes(namespace)) return null;
  const id = payload.replace(/:tcp$/, "");
  return classifyDevice(id) === "ios" ? id : null;
}

function stepSucceeded(steps: RecoveryStep[], name: string): boolean {
  return steps.find((s) => s.step === name)?.ok === true;
}

/**
 * Agent-facing guidance derived from the individual steps. `recovered` collapses
 * them into one bit, which can't pick between "retry the daemon restart" and
 * "just boot the device" — and guessing sends the agent back through a host-wide
 * shutdown it may not need.
 */
export function buildNote(steps: RecoveryStep[], rebootAfter: boolean): string {
  const daemonRestarted = stepSucceeded(steps, "killall-coresimulatorservice");
  // `bootstatus -b` boots the device if needed and blocks until it is up.
  const targetBooted = stepSucceeded(steps, "bootstatus");
  const snapshotLost = steps.some((s) => s.step === "snapshot-booted");
  const siblings = steps.filter((s) => s.step.startsWith("boot:"));
  // Sibling boots are tolerated on failure, so `ok` alone is always true.
  const restored = siblings.filter((s) => !s.tolerated).length;
  const failedSiblings = siblings.length - restored;
  const failedSteps = steps.filter((s) => !s.ok).map((s) => s.step);

  const parts: string[] = [];

  parts.push(
    daemonRestarted
      ? "CoreSimulator daemon restarted"
      : "The CoreSimulator daemon was NOT restarted, so the wedge is likely still present"
  );

  if (rebootAfter) {
    parts.push(
      targetBooted
        ? "and the target device is booted"
        : "and the target device is not confirmed booted"
    );
  } else {
    parts.push("and all simulators were left shut down (rebootAfter:false)");
  }

  let note = parts.join(" ") + ".";

  if (failedSteps.length > 0) {
    note += ` Step(s) ${failedSteps.join(", ")} failed — see steps for details.`;
  }
  if (restored > 0) {
    note += ` ${restored} other previously-booted simulator(s) were also restarted (finishing in the background).`;
  }
  if (failedSiblings > 0) {
    note += ` ${failedSiblings} other previously-booted simulator(s) did NOT come back — boot them with boot-device.`;
  }
  if (snapshotLost) {
    note +=
      " The booted-simulator snapshot could not be taken, so any other simulators this shut down" +
      " were not restored; boot them with boot-device.";
  }

  if (!daemonRestarted) {
    note +=
      " Retry this tool, or restart the daemon by hand with" +
      " `killall com.apple.CoreSimulator.CoreSimulatorService`.";
  } else if (rebootAfter && !targetBooted) {
    note += " Boot the device with boot-device, then re-check taps.";
  } else if (!rebootAfter) {
    note += " Boot the device with boot-device before interacting.";
  } else {
    note +=
      " Relaunch your app with launch-app — the next tap is delivery-verified automatically," +
      " or force a check with gesture-tap { verify: true }.";
  }

  return note;
}

export interface RecoverTouchInjectionDeps {
  /** Injectable simulator lister, for tests. */
  listSimulators?: () => Promise<Array<{ udid: string }>>;
}

export function createRecoverTouchInjectionTool(
  registry: Registry,
  deps: RecoverTouchInjectionDeps = {}
): ToolDefinition<Params, Result> {
  const listSimulators = deps.listSimulators ?? listIosSimulators;
  return {
    id: "recover-touch-injection",
    description: `Restart the host CoreSimulator daemon to make a local iOS simulator take touches again. Use when gesture-tap / gesture-swipe report success but the touches never reach the app while describe and screenshot keep working, for example when a tap with { verify: true } returns verified:false on a control that should change the screen. stop-simulator-server and boot-device with force do not clear this state.

This is host-wide: it stops Argent's services for every local iOS simulator, runs \`xcrun simctl shutdown all\` and \`killall com.apple.CoreSimulator.CoreSimulatorService\`, boots the target and waits for it, then boots the other previously booted simulators in the background (rebootAfter:false leaves all of them shut down). Ask the user first when other simulators are booted.

Local iOS simulators only. Returns { recovered, steps, disposedServices, note }; recovered is false when a step failed (see steps), and note names each simulator that did not boot again. Fails for an unknown UDID or a non-iOS device.`,
    searchHint:
      "recover fix wedged stuck touch injection tap not landing coresimulator daemon restart reset simulator hid silent failure",
    zodSchema,
    capability,
    // A cold boot outlives the MCP client's 30s abort, and its retry would stack
    // overlapping host-wide shutdown/killall runs that nothing cancels.
    longRunning: true,
    interaction: {
      startedMsg: ({ params }) => `Restarting the CoreSimulator daemon for ${params.udid}`,
      completedMsg: ({ params }) => `Restarted the CoreSimulator daemon for ${params.udid}`,
      failedMsg: ({ params, failureSignal }) =>
        `Failed to restart the CoreSimulator daemon for ${params.udid}: ${failureSignal.error_code}`,
    },
    services: () => ({}),
    async execute(_services, params) {
      const device = resolveDevice(params.udid);
      const rebootAfter = params.rebootAfter ?? true;

      // The capability gate classifies by UDID shape alone, so a UDID naming no
      // simulator reaches here — and the recovery's shutdown/killall are host-wide,
      // running before any device-specific step could fail.
      const simulators = await listSimulators();
      if (!simulators.some((s) => s.udid === device.id)) {
        throw new Error(
          `No iOS simulator with UDID ${device.id} exists on this host, so there is nothing to ` +
            "recover. This tool shuts down every booted simulator host-wide, so it refuses to run " +
            "against an unknown device. Check the UDID with list-devices." +
            (simulators.length === 0
              ? " (No simulators could be listed at all — `xcrun simctl` may be unavailable or failing.)"
              : "")
        );
      }

      // Refuses a provider's simulator without the simctl grant, and resolves
      // the `--set` of one in an additional device set, before anything host-wide runs.
      const target = await simctlTargetForUdid(device.id);

      // Drop argent's live handles onto the old daemon before restarting it —
      // for every local Apple simulator, since the restart invalidates them all.
      const snapshot = registry.getSnapshot();
      const disposedServices: string[] = [];
      for (const [urn, entry] of snapshot.services) {
        if (entry.state === ServiceState.IDLE) continue;
        if (coreSimDeviceId(urn) === null) continue;
        if (isLiveServiceState(entry.state)) disposedServices.push(urn);
        await registry.disposeService(urn);
      }

      const steps = await recoverCoreSimulatorInjection(target.nativeId, {
        rebootAfter,
        targetPrefix: target.prefix,
      });
      const recovered = recoverySucceeded(steps);

      return {
        recovered,
        udid: device.id,
        disposedServices,
        steps,
        note: buildNote(steps, rebootAfter),
      };
    },
  };
}
