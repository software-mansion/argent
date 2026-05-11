import type { DeviceInfo, Registry, ToolDependency } from "@argent/registry";
import { axServiceRef, type AXServiceApi } from "../../../../blueprints/ax-service";
import { nativeDevtoolsRef, type NativeDevtoolsApi } from "../../../../blueprints/native-devtools";
import { resolveNativeTargetApp } from "../../../../utils/native-target-app";
import { parseNativeDescribeScreenResult } from "../../../native-devtools/native-describe-contract";
import type { DescribeResult } from "../../contract";
import { adaptAXDescribeToDescribeResult } from "./ios-ax-adapter";
import { adaptNativeDescribeToDescribeResult } from "./ios-native-adapter";

export interface DescribeIosParams {
  bundleId?: string;
}

// describe on iOS resolves the ax-service via Registry; the blueprint factory
// shells out to `xcrun simctl spawn` (ensureAutomationEnabled + spawnDaemon).
// Without xcrun on PATH the spawn ENOENTs deep inside the factory and the
// HTTP layer returns a 500 with a raw "spawn xcrun ENOENT" message — declare
// the dep here so the preflight emits a 424 with the install hint instead,
// matching launch-app / restart-app / open-url / reinstall-app.
export const iosRequires: ToolDependency[] = ["xcrun"];

export async function describeIos(
  registry: Registry,
  device: DeviceInfo,
  params: DescribeIosParams
): Promise<DescribeResult> {
  const axRef = axServiceRef(device);
  const axApi = await registry.resolveService<AXServiceApi>(axRef.urn, axRef.options);
  const response = await axApi.describe();
  const tree = adaptAXDescribeToDescribeResult(response);

  if (tree.children.length > 0) {
    return { tree, source: "ax-service" };
  }

  // AX returned zero elements — attempt native-devtools fallback
  try {
    const ndRef = nativeDevtoolsRef(device);
    const nativeApi = await registry.resolveService<NativeDevtoolsApi>(ndRef.urn, ndRef.options);

    const target = await resolveNativeTargetApp(nativeApi, params.bundleId);

    if (await nativeApi.requiresAppRestart(target.bundleId)) {
      return { tree, source: "ax-service", should_restart: true };
    }

    const rawResult = (await nativeApi.queryViewHierarchy(
      target.bundleId,
      "ViewHierarchy.describeScreen"
    )) as { screenFrame?: unknown; elements?: unknown[]; error?: string };

    if (rawResult.error) {
      return { tree, source: "ax-service" };
    }

    const parsed = parseNativeDescribeScreenResult(rawResult);
    const nativeTree = adaptNativeDescribeToDescribeResult(parsed);
    return { tree: nativeTree, source: "native-devtools" };
  } catch {
    // Native devtools unavailable or no connected app — return the empty AX result
    return { tree, source: "ax-service" };
  }
}
