import { z } from "zod";
import type { Registry, ToolDefinition } from "@argent/registry";
import type { AXServiceApi } from "../../blueprints/ax-service";
import { AX_SERVICE_NAMESPACE } from "../../blueprints/ax-service";
import type { NativeDevtoolsApi } from "../../blueprints/native-devtools";
import { NATIVE_DEVTOOLS_NAMESPACE } from "../../blueprints/native-devtools";
import type { DescribeResult } from "./describe-contract";
import { adaptAXDescribeToDescribeResult } from "./describe-ax-adapter";
import { adaptNativeDescribeToDescribeResult } from "./describe-native-adapter";
import { parseNativeDescribeScreenResult } from "../native-devtools/native-describe-contract";
import { resolveNativeTargetApp } from "../../utils/native-target-app";
import { classifyDevice } from "../../utils/platform-detect";
import { adbExecOutBinary } from "../../utils/adb";
import { getAndroidScreenSize } from "../../utils/android-screen";
import { parseUiAutomatorDump } from "../../utils/uiautomator-parser";

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  bundleId: z
    .string()
    .optional()
    .describe(
      "iOS-only: target hint for the fallback app-level inspection when the top-level describe returns nothing. If omitted, the frontmost connected app is used. Ignored on Android."
    ),
});

async function describeAndroid(udid: string): Promise<DescribeResult> {
  // Per-call dump path so concurrent describes on the same serial don't race
  // on /sdcard/window_dump.xml (one call's cat would read the other's dump
  // mid-write). `uiautomator` rejects unwritable paths, so we target
  // /data/local/tmp/ which is world-writable on every Android we support.
  const randomSuffix = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  const dumpPath = `/data/local/tmp/argent-ui-dump-${randomSuffix}.xml`;
  const [size, rawBuf] = await Promise.all([
    getAndroidScreenSize(udid),
    adbExecOutBinary(
      udid,
      `uiautomator dump ${dumpPath} >/dev/null && cat ${dumpPath} && rm -f ${dumpPath}`,
      { timeoutMs: 20_000 }
    ),
  ]);
  const raw = rawBuf.toString("utf-8");
  const trimmed = raw.trim();
  if (/^ERROR:/i.test(trimmed) || (!trimmed.includes("<hierarchy") && /error/i.test(trimmed))) {
    throw new Error(
      `uiautomator could not capture the screen: ${trimmed}. ` +
        `Common causes: device locked / keyguard, DRM or secure overlay, Play Integrity screen. ` +
        `Unlock the device or take a screenshot as a fallback.`
    );
  }
  const tree = parseUiAutomatorDump(raw, size.width, size.height);
  return { tree, source: "native-devtools" };
}

export function createDescribeTool(
  registry: Registry
): ToolDefinition<z.infer<typeof zodSchema>, DescribeResult> {
  return {
    id: "describe",
    description: `Get the current screen's UI hierarchy as a tree of elements with roles, labels, identifiers, values, and frame coordinates.
Returns dialog elements when a system modal is visible, otherwise the foreground app's elements.
Frame coordinates are normalized to [0,1] — same space as gesture-tap. Use frame.x + frame.width/2 as tap X, frame.y + frame.height/2 as tap Y.
For React Native apps, prefer \`debugger-component-tree\` when a Metro debugger connection is available — it returns richer component-level data.
Call before every tap — never guess coordinates from a screenshot.`,
    zodSchema,
    services: () => ({}),
    async execute(_services, params, _options) {
      if ((await classifyDevice(params.udid)) === "android") {
        return describeAndroid(params.udid);
      }
      const axApi = await registry.resolveService<AXServiceApi>(
        `${AX_SERVICE_NAMESPACE}:${params.udid}`
      );
      const response = await axApi.describe();
      const tree = adaptAXDescribeToDescribeResult(response);

      if (tree.children.length > 0) {
        return { tree, source: "ax-service" };
      }

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
        return { tree, source: "ax-service" };
      }
    },
  };
}
