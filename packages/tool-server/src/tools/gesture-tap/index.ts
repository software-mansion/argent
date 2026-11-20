import { z } from "zod";
import type {
  DeviceInfo,
  Registry,
  ServiceRef,
  ToolCapability,
  ToolDefinition,
} from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { iosDeviceRunnerRef, type IosDeviceRunnerApi } from "../../blueprints/ios-device-runner";
import { requireCurrentIosDeviceApp } from "../../utils/ios-device/app-session";
import { getViewport, tapAt, toPoints } from "../../utils/ios-device/runner-commands";
import { assertChromiumWindowVisible } from "../../utils/chromium-visibility";
import { isIosPhysicalDevice, resolveDevice, harmonyConnectKey } from "../../utils/device-info";
import {
  HARMONY_INTERACTION_TIMEOUT_MS,
  assertHarmonyDisplayReady,
  harmonyDisplay,
  holdUitestQueue,
  HARMONY_DISPLAY_TIMEOUT_MS,
  remainingBudget,
  toDevicePoint,
} from "../../utils/harmony-uitest";
import { ensureDep } from "../../utils/check-deps";
import { InvalidToolInputError, isFlagOffered, MACOS_APPS_FLAG } from "../../utils/capability";
import { FLAG_META_KEY, renderFlagGated } from "../../utils/flag-gated-text";
import { macosAppServices, macosClick, requireMacosApp } from "../../utils/macos-input";
import { sendCommand } from "../../utils/simulator-client";
import { sleepOrAbort } from "../../utils/timing";
import { selectorSchema, selectorTapTargets, type Selector } from "../../utils/ui-tree-match";
import {
  getDescribeTapPoint,
  type DescribeFrame,
  type DescribeNode,
  type DescribeSource,
  type DescribeTreeData,
} from "../describe/contract";
import { formatDescribeLine } from "../describe/format-tree";
import { describeIos } from "../describe/platforms/ios";
import { describeAndroid } from "../describe/platforms/android";
import { describeChromium } from "../describe/platforms/chromium";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Result {
  tapped: boolean;
  timestampMs: number;
  /**
   * Physical iOS only: the target app was backgrounded and the runner
   * re-fronted it to run this tap, so the foreground screen changed as a side
   * effect. Set only when true.
   */
  reactivated?: true;
  /**
   * Foldable iOS simulators only: the panel the device renders to could not
   * be resolved, so the tap went to the cover panel. Says why and what to check.
   */
  warning?: string;
}

function tapDescription(params: Params, tense: "present" | "past"): string {
  const count = params.clickCount ?? 1;
  const action =
    count === 1
      ? tense === "present"
        ? "Tapping"
        : "Tapped"
      : count === 2
        ? tense === "present"
          ? "Double-tapping"
          : "Double-tapped"
        : `${tense === "present" ? "Tapping" : "Tapped"} ${count} times`;

  const button = params.button === "right" ? " with the right button" : "";
  return `${action} ${tapTarget(params)}${button}`;
}

function tapTarget(params: Params): string {
  if (params.selector) return JSON.stringify(params.selector);
  return `at (${Math.round((params.x ?? 0) * 100)}%, ${Math.round((params.y ?? 0) * 100)}%)`;
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
  harmony: { device: true },
  macos: { app: true },
};

// Timings keep a multi-tap inside the OS double-tap window, which separate
// tool calls could not guarantee.
const TAP_HOLD_MS = 50;
const MULTI_TAP_GAP_MS = 100;

async function tapChromium(
  api: ChromiumCdpApi,
  x: number,
  y: number,
  clickCount: number
): Promise<void> {
  const vp = api.getViewport();
  const pxX = Math.max(0, Math.min(vp.width, x * vp.width));
  const pxY = Math.max(0, Math.min(vp.height, y * vp.height));
  await api.dispatchMouseEvent({ type: "mouseMoved", x: pxX, y: pxY });
  // dblclick fires off the escalating clickCount, not off timing.
  for (let i = 1; i <= clickCount; i++) {
    if (i > 1) await sleep(MULTI_TAP_GAP_MS);
    await api.dispatchMouseEvent({ type: "mousePressed", x: pxX, y: pxY, clickCount: i });
    await sleep(TAP_HOLD_MS);
    await api.dispatchMouseEvent({ type: "mouseReleased", x: pxX, y: pxY, clickCount: i });
  }
}

/** A count of 2 uses `uitest`'s native `doubleClick`; separate clicks are a round trip apart. */
async function tapHarmony(
  connectKey: string,
  x: number,
  y: number,
  clickCount: number,
  signal?: AbortSignal
): Promise<void> {
  // One deadline for the whole multi-tap.
  const deadline = Date.now() + HARMONY_INTERACTION_TIMEOUT_MS;
  // Prefilter without queueing; the trusted check is inside the hold.
  const display = await harmonyDisplay(connectKey);
  assertHarmonyDisplayReady(display, "tap");
  await holdUitestQueue(
    connectKey,
    deadline,
    async (ui) => {
      const live = await harmonyDisplay(
        connectKey,
        Math.min(
          HARMONY_DISPLAY_TIMEOUT_MS,
          remainingBudget(connectKey, deadline, "the display re-read")
        )
      );
      assertHarmonyDisplayReady(live, "tap");
      const point = toDevicePoint(x, y, live);
      if (clickCount === 2) {
        await ui.touch("doubleClick", point);
        return;
      }
      for (let i = 0; i < clickCount; i++) {
        if (i > 0) await sleep(MULTI_TAP_GAP_MS);
        await ui.touch("click", point);
      }
    },
    signal
  );
}

// A selector tap waits this long for the element to appear, like a short await-ui-element.
const SELECTOR_WAIT_MS = 2000;
const SELECTOR_POLL_MS = 300;
const MAX_LISTED_TARGETS = 5;

function selectorSupported(device: DeviceInfo): boolean {
  return (
    (device.platform === "ios" && device.kind === "simulator") ||
    device.platform === "android" ||
    device.platform === "chromium"
  );
}

function assertSelectorSupported(device: DeviceInfo): void {
  if (selectorSupported(device)) return;
  throw new InvalidToolInputError(
    `gesture-tap selector works on an iOS simulator, Android or a Chromium app, not on ` +
      `${device.platform} ${device.kind}: pass x/y from describe instead.`
  );
}

function selectorTreeReader(
  registry: Registry,
  device: DeviceInfo,
  services: Record<string, unknown>
): () => Promise<DescribeTreeData> {
  if (device.platform === "ios") {
    return () => describeIos(registry, device, {}, { isTvOs: false });
  }
  if (device.platform === "android") {
    return () => describeAndroid(registry, device.id, undefined, false);
  }
  return () => describeChromium(services.chromium as ChromiumCdpApi);
}

function noMatchError(selector: Selector, data: DescribeTreeData): Error {
  const hint = data.hint ? ` (${data.hint})` : "";
  return new Error(
    `No visible element matches selector ${JSON.stringify(selector)}${hint}. ` +
      `Check the element tree, or pass x/y.`
  );
}

function ambiguousSelectorError(
  selector: Selector,
  targets: DescribeNode[],
  source: DescribeSource
): Error {
  const listed = targets
    .slice(0, MAX_LISTED_TARGETS)
    .map((n) => `  ${formatDescribeLine(n, source)}`);
  const hidden = targets.length - listed.length;
  return new InvalidToolInputError(
    [
      `Selector ${JSON.stringify(selector)} matches ${targets.length} elements. ` +
        `Narrow it with more fields (text, identifier, role) or pass x/y:`,
      ...listed,
      ...(hidden > 0 ? [`  ...and ${hidden} more`] : []),
    ].join("\n")
  );
}

function sameFrame(a: DescribeFrame | undefined, b: DescribeFrame): boolean {
  return (
    a !== undefined && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}

/** An element that appears during the wait is tapped once two reads in a row give the same frame. */
async function resolveSelectorPoint(
  read: () => Promise<DescribeTreeData>,
  selector: Selector,
  signal?: AbortSignal
): Promise<{ x: number; y: number }> {
  const deadline = Date.now() + SELECTOR_WAIT_MS;
  let data = await read();
  let targets = selectorTapTargets(data.tree, selector, data.uiOrientation);
  let moving = false;
  while ((targets.length === 0 || moving) && Date.now() < deadline) {
    const before = targets[0]?.frame;
    if (!(await sleepOrAbort(SELECTOR_POLL_MS, signal))) {
      throw new Error("gesture-tap was cancelled while waiting for the selector to match");
    }
    data = await read();
    targets = selectorTapTargets(data.tree, selector, data.uiOrientation);
    moving = targets.length === 1 && !sameFrame(before, targets[0]!.frame);
  }
  if (targets.length === 0) throw noMatchError(selector, data);
  if (targets.length > 1) throw ambiguousSelectorError(selector, targets, data.source);
  return getDescribeTapPoint(targets[0]!.frame);
}

function tapsOnePlace(params: { x?: number; y?: number; selector?: Selector }): boolean {
  const hasX = params.x !== undefined;
  const hasY = params.y !== undefined;
  return params.selector ? !hasX && !hasY : hasX && hasY;
}

const zodSchema = z
  .object({
    udid: z
      .string()
      .describe(
        "Target device id from `list-devices` (iOS UDID, Android serial, <flag:harmonyos>HarmonyOS id, </flag:harmonyos><flag:macos-apps>Mac app id, </flag:macos-apps>or Chromium id)."
      ),
    x: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Horizontal position: 0 = left edge, 1 = right edge."),
    y: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Vertical position: 0 = top edge, 1 = bottom edge."),
    selector: selectorSchema
      .optional()
      .describe(
        "Instead of x/y: the element to tap, matched as in await-ui-element. Taps its centre; " +
          "fails listing the candidates if several match. iOS simulator, Android and Chromium."
      ),
    clickCount: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe(
        "Number of taps/clicks dispatched as ONE gesture inside the OS double-tap window (2 = double-tap / " +
          "double-click), which two separate tap calls cannot guarantee. On physical iOS, higher counts " +
          "loop single taps, which a double-tap recognizer may pair.<flag:harmonyos> On HarmonyOS they " +
          "land as separate taps.</flag:harmonyos> Default 1."
      ),
    button: z
      .enum(["left", "right"])
      .optional()
      .describe(
        'Mouse button, Mac app only: "right" is a right-click, for example to open a context menu; ' +
          'any other device refuses it. Default "left".'
      )
      .meta({ [FLAG_META_KEY]: MACOS_APPS_FLAG }),
  })
  .refine(tapsOnePlace, { message: "pass either selector or both x and y" });

type Params = z.infer<typeof zodSchema>;

export function createGestureTapTool(registry: Registry): ToolDefinition<Params, Result> {
  return {
    id: "gesture-tap",
    description: `Press the device screen (iOS simulator or physical device, Android emulator, <flag:harmonyos>HarmonyOS device, </flag:harmonyos><flag:macos-apps>Mac app, </flag:macos-apps>or Chromium app) at an element matched by \`selector\`, or at a point given as fractions of the screen width and height (not pixels): a Down event followed by an Up event at the same spot.<flag:macos-apps> On a Mac app it is a click, and x/y are fractions of the area describe reports, not of the window.</flag:macos-apps>
Use when tapping a button, link, or any tappable element on the screen.
Returns { tapped: true, timestampMs }. On physical iOS, reactivated: true = app was re-fronted; re-describe. Fails if the device backend (simulator-server / emulator / Chromium CDP<flag:harmonyos> / \`hdc\`</flag:harmonyos>) is unreachable.
On an iOS simulator, Android or Chromium, prefer \`selector\` for an element the tree lists by text or id; otherwise take x/y from the element tree (\`describe\`<flag:harmonyos>, on HarmonyOS the \`uitest\` layout dump</flag:harmonyos>). More information in \`argent-device-interact\` skill`,
    zodSchema,
    alwaysLoad: true,
    // A physical iPhone's first call waits out the runner build, past the MCP fetch timeout,
    // whose abort replays the call: the gesture would land once per replay.
    longRunning: true,
    searchHint:
      "tap press button element device simulator emulator chromium<flag:macos-apps> mac</flag:macos-apps> touch down up click<flag:macos-apps> right-click context menu</flag:macos-apps>",
    interaction: {
      startedMsg: ({ params }) => tapDescription(params, "present"),
      completedMsg: ({ params }) => tapDescription(params, "past"),
      failedMsg: ({ params, failureSignal }) =>
        `Failed to tap ${tapTarget(params)}: ${failureSignal.error_code}`,
    },
    capability,
    services: (params): Record<string, ServiceRef> => {
      const device = resolveDevice(params.udid);
      // Refused in `execute`, without starting a backend for a tap that never runs.
      if (params.selector && !selectorSupported(device)) return {};
      if (device.platform === "macos") {
        return macosAppServices(device);
      }
      if (params.button === "right") return {};
      if (device.platform === "chromium") {
        return { chromium: chromiumCdpRef(device) };
      }
      if (isIosPhysicalDevice(device)) {
        return { iosDeviceRunner: iosDeviceRunnerRef(device) };
      }
      // No simulator-server controller exists for HarmonyOS.
      if (device.platform === "harmony") return {};
      return { simulatorServer: simulatorServerRef(device) };
    },
    async execute(services, params, ctx) {
      const device = resolveDevice(params.udid);
      const clickCount = params.clickCount ?? 1;
      // The other backends would land a right-click as a plain tap.
      if (params.button === "right" && device.platform !== "macos") {
        // gesture-custom has a backend on iOS and Android only.
        const refusal =
          device.platform === "chromium"
            ? `<flag:macos-apps>, which argent sends only to a Mac app</flag:macos-apps>: argent ` +
              `does not support a right-click on a chromium app yet.`
            : `<flag:macos-apps>, which only a Mac app takes</flag:macos-apps>: ${device.platform} ` +
              `${device.kind} takes no right-click.` +
              (device.platform === "harmony"
                ? ""
                : ` To open a context menu on a touch screen, press and hold: gesture-custom with ` +
                  `a Down, then an Up after 800 ms.`);
        throw new InvalidToolInputError(
          renderFlagGated(
            `gesture-tap button "right" is a mouse right-click${refusal}`,
            isFlagOffered
          )
        );
      }
      if (params.selector) assertSelectorSupported(device);
      if (device.platform === "chromium") {
        // Mouse dispatch stalls at ~5s per event on a hidden window.
        await assertChromiumWindowVisible(services.chromium as ChromiumCdpApi, "tap");
      }
      const { x, y } = params.selector
        ? await resolveSelectorPoint(
            selectorTreeReader(registry, device, services),
            params.selector,
            ctx?.signal
          )
        : { x: params.x ?? 0, y: params.y ?? 0 };
      const timestampMs = Date.now();
      if (device.platform === "macos") {
        const app = requireMacosApp(services, "gesture-tap", device);
        await macosClick(app, x, y, { clickCount, button: params.button });
        return { tapped: true, timestampMs };
      }
      if (device.platform === "chromium") {
        await tapChromium(services.chromium as ChromiumCdpApi, x, y, clickCount);
        return { tapped: true, timestampMs };
      }
      if (isIosPhysicalDevice(device)) {
        const runner = services.iosDeviceRunner as IosDeviceRunnerApi;
        const bundleId = requireCurrentIosDeviceApp(device.id);
        const viewport = await getViewport(runner, bundleId);
        const point = toPoints(viewport, x, y);
        // The whole count is one runner command: a double-tap must be the native one, and any loop
        // above 2 stays on-device (single taps either way, but without wire round trips between them).
        const tap = await tapAt(runner, bundleId, point, clickCount);
        // Either leg can be the one that re-fronted a backgrounded target: the
        // viewport read fronts it first, so the tap then finds it foreground.
        const reactivated = viewport.reactivated === true || tap.reactivated;
        return {
          tapped: true,
          timestampMs,
          ...(reactivated ? { reactivated: true as const } : {}),
        };
      }
      if (device.platform === "harmony") {
        await ensureDep("hdc");
        await tapHarmony(harmonyConnectKey(device.id), x, y, clickCount, ctx?.signal);
        return { tapped: true, timestampMs };
      }
      const api = services.simulatorServer as SimulatorServerApi;
      let warning: string | undefined;
      for (let i = 1; i <= clickCount; i++) {
        if (i > 1) await sleep(MULTI_TAP_GAP_MS);
        const down = await sendCommand(api, {
          cmd: "touch",
          type: "Down",
          x,
          y,
          second_x: null,
          second_y: null,
        });
        warning ??= down.warning;
        await sleep(TAP_HOLD_MS);
        await sendCommand(api, {
          cmd: "touch",
          type: "Up",
          x,
          y,
          second_x: null,
          second_y: null,
        });
      }
      return { tapped: true, timestampMs, ...(warning !== undefined ? { warning } : {}) };
    },
  };
}
