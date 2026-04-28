import type { Registry, ToolDependency } from "@argent/registry";
import type { AXServiceApi } from "../../../blueprints/ax-service";
import { AX_SERVICE_NAMESPACE } from "../../../blueprints/ax-service";
import type { NativeDevtoolsApi } from "../../../blueprints/native-devtools";
import { NATIVE_DEVTOOLS_NAMESPACE } from "../../../blueprints/native-devtools";
import type { DescribeResult } from "../contract";
import { adaptAXDescribeToDescribeResult } from "./ios-ax-adapter";
import { adaptNativeDescribeToDescribeResult } from "./ios-native-adapter";
import { parseNativeDescribeScreenResult } from "../../native-devtools/native-describe-contract";
import { resolveNativeTargetApp } from "../../../utils/native-target-app";

export interface DescribeIosParams {
  udid: string;
  bundleId?: string;
}

// describe on iOS goes through ax-service / native-devtools, both of which
// resolve via Registry — no direct xcrun shell-out, so no `requires` here.
export const iosRequires: ToolDependency[] = [];

export async function describeIos(
  registry: Registry,
  params: DescribeIosParams
): Promise<DescribeResult> {
  const axApi = await registry.resolveService<AXServiceApi>(
    `${AX_SERVICE_NAMESPACE}:${params.udid}`
  );
  const response = await axApi.describe();
  const tree = adaptAXDescribeToDescribeResult(response);

  if (tree.children.length > 0) {
    return { tree, source: "ax-service" };
  }

  // AX returned zero elements — attempt native-devtools fallback
  try {
    const nativeApi = await registry.resolveService<NativeDevtoolsApi>(
      `${NATIVE_DEVTOOLS_NAMESPACE}:${params.udid}`
    );

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
