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
import { detectPlatform } from "../../utils/platform-detect";
import { adbExecOutBinary } from "../../utils/adb";
import { getAndroidScreenSize } from "../../utils/android-screen";
import { parseUiAutomatorDump } from "../../utils/uiautomator-parser";

const zodSchema = z.object({
  udid: z
    .string()
    .describe(
      "Device id. For iOS: simulator UDID (UUID shape). For Android: adb serial (e.g. `emulator-5554`)."
    ),
  bundleId: z
    .string()
    .optional()
    .describe(
      "iOS-only: target hint when AX-service returns nothing and the tool falls back to native-devtools inspection. " +
        "If omitted, falls back to the frontmost connected app. Ignored on Android."
    ),
});

async function describeAndroid(udid: string): Promise<DescribeResult> {
  const [size, rawBuf] = await Promise.all([
    getAndroidScreenSize(udid),
    adbExecOutBinary(
      udid,
      "uiautomator dump /sdcard/window_dump.xml >/dev/null && cat /sdcard/window_dump.xml",
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
    description: `Get the UI hierarchy for the current screen on iOS or Android.

iOS: accessibility element tree from AXRuntime. Returns dialog elements when a system modal is visible, otherwise the foreground app's accessible tree. Falls back to native-devtools inspection if AX is empty.
Android: uiautomator dump parsed into the same DescribeNode shape. Uses \`resource-id\` as identifier, \`content-desc\`/\`text\` as label.

Both return frame coordinates normalized to [0,1] — same coord space as gesture-tap. Use frame.x + frame.width/2 as tap X, frame.y + frame.height/2 as tap Y.

For React Native apps on either platform, \`debugger-component-tree\` returns richer component data (requires Metro connection; on Android also requires \`adb reverse tcp:8081 tcp:8081\`).`,
    zodSchema,
    services: () => ({}),
    async execute(_services, params, _options) {
      if (detectPlatform(params.udid) === "android") {
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
