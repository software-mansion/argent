import type { DeviceInfo, Registry, ToolDependency } from "@argent/registry";
import { axServiceRef, AXServiceApi } from "../../../../blueprints/ax-service";
import { nativeDevtoolsRef, NativeDevtoolsApi } from "../../../../blueprints/native-devtools";
import { isPhysicalIos } from "../../../../utils/device-info";
import { UnsupportedOperationError } from "../../../../utils/capability";
import { resolveNativeTargetApp } from "../../../../utils/native-target-app";
import { isTvOsSimulator } from "../../../../utils/ios-devices";
import { parseNativeDescribeScreenResult } from "../../../native-devtools/native-describe-contract";
import { DescribeTreeData, parseDescribeResult, type DescribeNode } from "../../contract";
import { adaptAXDescribeToDescribeResult } from "./ios-ax-adapter";
import { adaptNativeDescribeToDescribeResult } from "./ios-native-adapter";

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
  // Physical iPhones are driven over CoreDevice, and there is no app-free
  // describe (accessibility tree) path on a real device today:
  //   - The two simulator backends can't run against hardware: ax-service
  //     shells `simctl spawn` and native-devtools injects a dylib via
  //     `simctl spawn`, both simulator-only. Their blueprint guards throw for
  //     kind === "device"; without this early return the fallback chain below
  //     would swallow those throws and return an empty tree + the "reboot the
  //     simulator" degraded hint — meaningless for hardware with no simulator.
  //   - The on-device accessibility tree is served by CoreDevice's
  //     axAuditDaemon, but Apple gates it to trusted/AppleInternal callers
  //     (hardware-verified on iOS 27, 2026-07): the DTX service
  //     `com.apple.accessibility.axAuditDaemon.remoteserver.shim.remote`
  //     requires the `com.apple.mobile.lockdown.remote.trusted` entitlement —
  //     over the developer (untrusted) CoreDevice tunnel pymobiledevice3 forms,
  //     the daemon accepts the socket but terminates it on the first request
  //     (every audit selector, and even the standard DTX capability handshake).
  //     The RemoteXPC replacement `…axAuditDaemon.remoteAXService` requires the
  //     `AppleInternal` entitlement, unreachable by any third party. DTX
  //     transport itself works over the same tunnel (`developer dvt proclist`
  //     succeeds), so this is Apple's auth wall, not a transport gap. Screenshot
  //     (CoreDevice `canViewDeviceDisplay`) is the only app-free screen capture.
  // Reject explicitly with a clear, 400-mapped error and point at screenshot.
  if (isPhysicalIos(device)) {
    throw new UnsupportedOperationError(
      "describe",
      device,
      "Apple restricts the physical device's CoreDevice accessibility service to " +
        "trusted/AppleInternal callers, so there is no app-free accessibility tree; " +
        "use screenshot to inspect the screen"
    );
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
