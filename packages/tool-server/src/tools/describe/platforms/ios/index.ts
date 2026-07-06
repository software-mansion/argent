import type { DeviceInfo, Registry, ToolDependency } from "@argent/registry";
import { axServiceRef, AXServiceApi } from "../../../../blueprints/ax-service";
import { nativeDevtoolsRef, NativeDevtoolsApi } from "../../../../blueprints/native-devtools";
import { isPhysicalIos } from "../../../../utils/device-info";
import { coreDeviceRef, type CoreDeviceApi } from "../../../../blueprints/core-device";
import { resolveNativeTargetApp } from "../../../../utils/native-target-app";
import { isTvOsSimulator } from "../../../../utils/ios-devices";
import { parseNativeDescribeScreenResult } from "../../../native-devtools/native-describe-contract";
import { DescribeTreeData, parseDescribeResult, type DescribeNode } from "../../contract";
import { adaptAXDescribeToDescribeResult } from "./ios-ax-adapter";
import { adaptNativeDescribeToDescribeResult } from "./ios-native-adapter";
import { adaptCoreDeviceAxToDescribeResult } from "./ios-coredevice-ax-adapter";

const DEGRADED_HINT =
  "This simulator was not booted through argent — system dialogs and native modals may not appear. You MUST call boot-device with force=true now to restart the simulator and apply full accessibility settings before continuing.";

// tvOS classifies as platform "ios" by UDID shape. The `describe` tool routes
// TV targets to the focus-driven `describeTv` before this iOS branch runs, so
// the short-circuit below is only reached by internal callers that invoke
// `describeIos` directly (preview / match-element-frame). The iOS ax-service
// can't read the Apple TV focus engine — surface the right tool instead of
// spawning a daemon that times out and degrades with the misleading
// boot-device hint.
const TVOS_HINT =
  "This is an Apple TV (tvOS) simulator, which the iOS accessibility service does not support. " +
  "Use the `describe` tool to read the focused and focusable elements, `tv-remote` " +
  "(up/down/left/right/select/back/menu/home) to move focus, and `keyboard` to type. " +
  "See the argent-tv-interact skill.";

// Physical iPhones expose their real on-screen accessibility tree app-free via
// the iOS-26+ axAudit service (read over CoreDevice). Captions (label + value +
// traits) and reading order are exact for every element; frames are exact only
// for the subset the accessibility audit flags, and interpolated for the rest —
// this hint makes that precision boundary explicit.
const PHYSICAL_IOS_AX_HINT =
  "This is the live accessibility tree of the frontmost app (or the home screen), read over " +
  "CoreDevice. Element labels, values, traits and reading order are exact. Frames are exact for " +
  "elements the accessibility audit reported and APPROXIMATE (interpolated from neighbours) for the " +
  "rest — good enough to tap a row in a vertical list, but confirm with screenshot before a precise " +
  "tap, especially for controls like toggles. Apple does not expose per-element geometry on a " +
  "physical device, so screenshot remains authoritative for exact positions.";

function emptyTree(): DescribeNode {
  return parseDescribeResult({
    role: "AXGroup",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children: [],
  });
}

export interface DescribeIosParams {
  bundleId?: string;
}

export interface DescribeIosOptions {
  // Pre-resolved tvOS verdict, passed by poll/retry callers so the hot path
  // skips re-shelling `xcrun` each iteration. Omitted callers probe once.
  isTvOs?: boolean;
}

// describe on iOS resolves the ax-service via Registry; the blueprint factory
// shells out to `xcrun simctl spawn` (spawnDaemon).
// Without xcrun on PATH the spawn ENOENTs deep inside the factory and the
// HTTP layer returns a 500 with a raw "spawn xcrun ENOENT" message — declare
// the dep here so the preflight emits a 424 with the install hint instead,
// matching launch-app / restart-app / open-url / reinstall-app.
export const iosRequires: ToolDependency[] = ["xcrun"];

export async function describeIos(
  registry: Registry,
  device: DeviceInfo,
  params: DescribeIosParams,
  options: DescribeIosOptions = {}
): Promise<DescribeTreeData> {
  // Physical iPhones are driven over CoreDevice. describe reads the device's real
  // on-screen accessibility tree app-free via the iOS-26+ axAudit service (the
  // `…axAuditDaemon.remoteserver.shim.remote` DTX daemon). This works in ANY app
  // and on the home screen — the same VoiceOver-style walk. It needs the RSDCheckin
  // handshake that iOS 26 added (the sidecar performs it); without it the daemon
  // drops the connection on the first byte. Apple exposes no per-element geometry
  // on hardware, so frames are exact only for elements the accessibility audit
  // flags and interpolated for the rest (see the adapter + hint). The two
  // simulator backends below can't run against hardware (they shell `simctl spawn`).
  if (isPhysicalIos(device)) {
    const ref = coreDeviceRef(device);
    const coreDevice = await registry.resolveService<CoreDeviceApi>(ref.urn, ref.options);
    const axtree = await coreDevice.axtree();
    return {
      tree: adaptCoreDeviceAxToDescribeResult(axtree),
      source: "coredevice-ax",
      hint: PHYSICAL_IOS_AX_HINT,
    };
  }

  // tvOS short-circuit: the focus-engine accessibility tree is served by the
  // tv-control daemons, not the iOS ax-service. Without this, describe would
  // try to spawn ax-service inside the Apple TV sim, time out on the daemon
  // connection, and degrade with the wrong (boot-device) hint.
  const isTvOs = options.isTvOs ?? (await isTvOsSimulator(device.id));
  if (isTvOs) {
    return { tree: emptyTree(), source: "ax-service", hint: TVOS_HINT };
  }

  let tree: DescribeNode;
  let hint: string | undefined;

  try {
    const axRef = axServiceRef(device);
    const axApi = await registry.resolveService<AXServiceApi>(axRef.urn, axRef.options);
    const response = await axApi.describe();
    tree = adaptAXDescribeToDescribeResult(response);
    hint = axApi.degraded ? DEGRADED_HINT : undefined;
  } catch {
    // ax-service failed to start or timed out — treat as degraded with an
    // empty tree so we still attempt the native-devtools fallback below.
    tree = emptyTree();
    hint = DEGRADED_HINT;
  }

  if (tree.children.length > 0) {
    return { tree, source: "ax-service", hint };
  }

  // AX returned zero elements (or failed entirely) — attempt native-devtools fallback
  try {
    const ndRef = nativeDevtoolsRef(device);
    const nativeApi = await registry.resolveService<NativeDevtoolsApi>(ndRef.urn, ndRef.options);

    const target = await resolveNativeTargetApp(nativeApi, params.bundleId);

    if (await nativeApi.requiresAppRestart(target.bundleId)) {
      return { tree, source: "ax-service", should_restart: true, hint };
    }

    const rawResult = (await nativeApi.queryViewHierarchy(
      target.bundleId,
      "ViewHierarchy.describeScreen"
    )) as { screenFrame?: unknown; elements?: unknown[]; error?: string };

    if (rawResult.error) {
      return { tree, source: "ax-service", hint };
    }

    const parsed = parseNativeDescribeScreenResult(rawResult);
    const nativeTree = adaptNativeDescribeToDescribeResult(parsed);
    return { tree: nativeTree, source: "native-devtools", hint };
  } catch {
    // Native devtools unavailable or no connected app — return the empty AX result
    return { tree, source: "ax-service", hint };
  }
}
