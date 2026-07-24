import { z } from "zod";
import { ServiceState, isLiveServiceState, parseURN } from "@argent/registry";
import type { Registry, ToolCapability, ToolDefinition } from "@argent/registry";
import { SIMULATOR_SERVER_NAMESPACE } from "../../blueprints/simulator-server";
import { NATIVE_DEVTOOLS_NAMESPACE } from "../../blueprints/native-devtools";
import { AX_SERVICE_NAMESPACE } from "../../blueprints/ax-service";
import { TV_CONTROL_NAMESPACE } from "../../blueprints/tv-control";
import { classifyDevice, resolveDevice } from "../../utils/device-info";
import {
  recoverCoreSimulatorInjection,
  recoverySucceeded,
  type RecoveryStep,
} from "../../utils/coresimulator-recovery";

const zodSchema = z.object({
  udid: z.string().describe("Target iOS simulator UDID from `list-devices`."),
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

export function createRecoverTouchInjectionTool(
  registry: Registry
): ToolDefinition<Params, Result> {
  return {
    id: "recover-touch-injection",
    description: `Recover a local iOS simulator whose touch injection has silently wedged — gesture-tap / gesture-swipe report success but the synthesized touches never reach the UI, while describe / screenshot / launch-app keep working.

Argent's normal recovery (stop-simulator-server, then re-boot) does NOT clear this; only restarting the host CoreSimulator daemon does. This tool disposes argent's services for EVERY local Apple simulator (the daemon restart is host-wide, so all of their handles go stale), runs \`xcrun simctl shutdown all\`, \`killall com.apple.CoreSimulator.CoreSimulatorService\`, then re-boots the target device (waiting for it) and restarts every other simulator that was booted, in the background (unless rebootAfter:false).

WARNING: this is host-wide — ALL booted simulators are briefly shut down; the target and any other previously-booted simulators are then re-booted automatically (the target is waited on, siblings finish in the background). Reach for it only when a device's taps have stopped landing; confirm the wedge first with gesture-tap { verify: true }.

iOS simulators only. Returns { recovered, steps, disposedServices, note } — recovered is false when a recovery step failed (see steps).`,
    searchHint:
      "recover fix wedged stuck touch injection tap not landing coresimulator daemon restart reset simulator hid silent failure",
    zodSchema,
    capability,
    services: () => ({}),
    async execute(_services, params) {
      const device = resolveDevice(params.udid);
      const rebootAfter = params.rebootAfter ?? true;

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

      const steps = await recoverCoreSimulatorInjection(device.id, { rebootAfter });
      const recovered = recoverySucceeded(steps);
      const failedSteps = steps.filter((s) => !s.ok).map((s) => s.step);
      const restoredSiblings = steps.filter((s) => s.step.startsWith("boot:")).length;

      const note = !recovered
        ? `Recovery did not complete: step(s) ${failedSteps.join(", ")} failed — see steps for details. ` +
          "The device may still be shut down; boot it with boot-device, or retry this tool."
        : rebootAfter
          ? "CoreSimulator daemon restarted and the target device re-booted" +
            (restoredSiblings > 0
              ? `; ${restoredSiblings} other previously-booted simulator(s) were also restarted (finishing in the background)`
              : "") +
            ". Relaunch your app with launch-app — the next tap is delivery-verified automatically, " +
            "or force a check with gesture-tap { verify: true }."
          : "CoreSimulator daemon restarted; all simulators were left shut down (rebootAfter:false). " +
            "Boot the device with boot-device before interacting.";

      return { recovered, udid: device.id, disposedServices, steps, note };
    },
  };
}
