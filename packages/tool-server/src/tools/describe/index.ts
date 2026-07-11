import { z } from "zod";
import type {
  InvokeToolOptions,
  Registry,
  ServiceRef,
  ToolCapability,
  ToolDefinition,
} from "@argent/registry";
import type { DescribeResult, DescribeTreeData } from "./contract";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { describeAndroid, androidRequires } from "./platforms/android";
import { iosRequires, describeIos } from "./platforms/ios";
import { describeChromium } from "./platforms/chromium";
import { describeTv } from "./platforms/tv";
import { describeVega, vegaRequires } from "./platforms/vega";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { resolveDevice } from "../../utils/device-info";
import { isTvOsSimulator } from "../../utils/ios-devices";
import { isAndroidTv } from "../../utils/adb";
import { DESCRIBE_FIELDS, formatDescribeSelection, formatDescribeTree } from "./format-tree";
import { describeSelectorSchema } from "./selectors";

// In-between layer between the per-platform adapters (which still own all
// pruning — the Android v2 trimmer in uiautomator-parser stays untouched) and
// the public DescribeResult. The internal `tree` is converted to a token-
// efficient text rendering here and then dropped, so the caller (LLM) never
// pays for the JSON tree.
function compactOptions(params: Params) {
  if (!params.selector) return undefined;
  return {
    selector: params.selector,
    projection: params.projection ?? "matches",
    fields: params.fields ?? DESCRIBE_FIELDS,
    limit: params.limit ?? 50,
    maxChars: params.maxChars ?? 12_000,
  } as const;
}

function withDescription(data: DescribeTreeData, params: Params): DescribeResult {
  // The selector-less path deliberately stays byte-for-byte compatible with
  // the original formatter and response shape.
  const options = compactOptions(params);
  const compact = options
    ? formatDescribeSelection(data.tree, { source: data.source, ...options })
    : undefined;
  const out: DescribeResult = compact
    ? { source: data.source, ...compact }
    : {
        description: formatDescribeTree(data.tree, { source: data.source }),
        source: data.source,
      };
  if (data.should_restart) out.should_restart = data.should_restart;
  if (data.hint) out.hint = data.hint;
  return out;
}

const zodSchema = z
  .object({
    udid: z
      .string()
      .min(1)
      .describe(
        "Target device id from `list-devices` (iOS UDID, Android serial, Vega serial, or Chromium id)."
      ),
    bundleId: z
      .string()
      .optional()
      .describe(
        "Optional app bundle ID. Used as a target hint on iOS when the AX-service returns no elements " +
          "and the describe tool falls back to native-devtools inspection. " +
          "If omitted, the fallback auto-detects the frontmost connected app. Ignored on Android / Chromium."
      ),
    selector: describeSelectorSchema
      .optional()
      .describe(
        "Optional element selector. When omitted, describe preserves its full legacy output exactly."
      ),
    projection: z
      .enum(["matches", "matches-and-ancestors", "full"])
      .optional()
      .describe(
        "Selector output shape (default `matches`): matching elements only, their ancestor paths, or the full tree with matches highlighted."
      ),
    fields: z
      .array(z.enum(DESCRIBE_FIELDS))
      .min(1)
      .optional()
      .describe(
        "Element fields to render in selector mode. Defaults to role, label, value, identifier, package, flags, and frame."
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("Maximum element lines emitted in selector mode (default 50)."),
    maxChars: z
      .number()
      .int()
      .min(256)
      .max(100_000)
      .optional()
      .describe("Maximum description characters in selector mode (default 12000)."),
  })
  .superRefine((params, ctx) => {
    if (
      params.selector === undefined &&
      (params.projection !== undefined ||
        params.fields !== undefined ||
        params.limit !== undefined ||
        params.maxChars !== undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["selector"],
        message: "projection, fields, limit, and maxChars require selector",
      });
    }
  });

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
  vega: { vvd: true },
};

interface ChromiumServices {
  chromium: ChromiumCdpApi;
}

// `describe` doesn't fit dispatchByPlatform's standard service-typed
// signature because the iOS handler resolves AX / native-devtools through
// `registry` (closed over here) rather than via the registry's services()
// declaration. We still feed `iosRequires` / `androidRequires` to the
// dispatcher so the per-branch host-binary preflight fires uniformly. The
// Chromium branch *does* go through services() since the CDP session lives in
// the registry as a normal service blueprint.
//
// TV targets are handled *inside* the platform branches rather than as a
// fourth branch: TV is not a `platform` (a tvOS sim classifies as "ios" and an
// Android TV emulator as "android" by id shape), it's a `runtimeKind` that
// spans both. So each platform branch runtime-probes its own TV kind and
// delegates to the shared focus-driven `describeTv` (in platforms/tv.ts) —
// returning the focused / focusable view instead of the iOS ax-service or
// Android uiautomator tree, which a focus-driven UI either can't serve or
// shouldn't be tapped from. One `describe` thus covers phones, tablets, and
// TVs through the normal dispatch.
function makeDescribeExecute(
  registry: Registry
): (
  services: Record<string, unknown>,
  params: Params,
  options?: InvokeToolOptions
) => Promise<DescribeResult> {
  return dispatchByPlatform<
    Record<string, unknown>,
    Record<string, unknown>,
    Params,
    DescribeResult,
    ChromiumServices,
    Record<string, unknown>
  >({
    toolId: "describe",
    capability,
    ios: {
      requires: iosRequires,
      handler: async (_services, params, device) =>
        // Probe tvOS once here, then pass the verdict into describeIos.
        (await isTvOsSimulator(device.id))
          ? describeTv(registry, device, compactOptions(params))
          : withDescription(await describeIos(registry, device, params, { isTvOs: false }), params),
    },
    iosRemote: {
      // describeIos already handles both ax-service (TCP) and native-devtools
      // fallback — both blueprints route through sim-remote when the device is
      // ios-remote. Only the preflight dep differs. Remote sims are iOS-only
      // (never tvOS), so the isTvOs verdict is always false.
      requires: ["sim-remote"],
      handler: async (_services, params, device) =>
        withDescription(await describeIos(registry, device, params, { isTvOs: false }), params),
    },
    android: {
      requires: androidRequires,
      handler: async (_services, params, device) =>
        // Resolve the form factor once and route on it: a TV goes to the
        // focus-driven describe, a phone to the uiautomator tree — and pass the
        // known `isTv: false` through so describeAndroid doesn't re-probe.
        (await isAndroidTv(device.id))
          ? describeTv(registry, device, compactOptions(params))
          : withDescription(
              await describeAndroid(registry, params.udid, params.bundleId, false),
              params
            ),
    },
    chromium: {
      handler: async (services, params) =>
        withDescription(await describeChromium(services.chromium), params),
    },
    vega: {
      requires: vegaRequires,
      handler: async (_services, params) =>
        withDescription(await describeVega(params.udid), params),
    },
  });
}

export function createDescribeTool(registry: Registry): ToolDefinition<Params, DescribeResult> {
  return {
    id: "describe",
    description: `Get the accessibility / DOM element tree for the current screen.
On iOS, uses the AXRuntime accessibility service to inspect whatever is currently visible — including
system dialogs, permission prompts, and any foreground app content. On Android, runs \`uiautomator dump\`.
On Chromium, walks the renderer's DOM via Chrome DevTools Protocol — every visible element with its ARIA
role, accessible name, and bounding rect (normalized to 0–1).
On Vega (Fire TV), reads the on-device automation toolkit (\`getPageSource\`); each element carries
\`[focused]\`/\`[selected]\` so you can see where the D-pad cursor is, then move it with the \`tv-remote\` tool
(Vega is remote-driven, not touch). If describe returns an empty tree on Vega, relaunch the foreground
app (the toolkit attaches at launch) and try again.

When a system dialog is visible, describe returns the dialog's interactive elements (buttons, text)
with tap coordinates. When no dialog is present, it returns the foreground app's accessible elements.

Returns \`{ description, source }\` where \`description\` is a text rendering of the UI tree — one
line per element with its role, label/value/id, interactivity flags, and frame. Frame coordinates
are normalized [0,1] fractions of the screen / window width/height (not pixels) — the same space as
gesture-tap / gesture-swipe / gesture-pinch.

For a smaller targeted response, pass selector \`{ text?, identifier?, role?, package? }\`; every supplied
field matches as a case-insensitive substring. Selector mode defaults to projection \`matches\`, all
fields (including Android package provenance), limit 50, and maxChars 12000. Use \`matches-and-ancestors\` to retain the path to each match,
or \`full\` to retain the complete tree while highlighting matches. Selector responses also return
\`matched\`, \`emitted\`, and \`truncated\`; truncation is marked in the description. Omitting selector
preserves the original full description and response shape exactly.

To tap an element use the centre of its frame: \`tap_x = frame.x + frame.width / 2\`,
\`tap_y = frame.y + frame.height / 2\`. The same formula appears in the response header so it
can be applied to a line in isolation.

For app-scoped inspection with full UIKit properties (accessibilityIdentifier, viewClassName),
use native-describe-screen with an explicit bundleId instead (iOS only).
For React Native apps, debugger-component-tree returns React component names with tap coordinates.

On a TV target (Apple TV / Android TV — a \`list-devices\` entry with runtimeKind 'tv') this returns
the focus-driven view instead: the currently FOCUSED element and the list of FOCUSABLE elements,
since a TV UI has no tap coordinates. Move the highlight with \`tv-remote\` (up/down/left/right/select/
back/menu/home), then call describe again to confirm where focus landed.`,
    alwaysLoad: true,
    searchHint:
      "accessibility element tree ui hierarchy tap coordinates ios android chromium vega dom tv tvos apple tv android tv fire tv focus focusable remote dpad",
    zodSchema,
    capability,
    services: (params): Record<string, ServiceRef> => {
      const device = resolveDevice(params.udid);
      if (device.platform === "chromium") {
        return { chromium: chromiumCdpRef(device) };
      }
      return {};
    },
    execute: makeDescribeExecute(registry),
  };
}
