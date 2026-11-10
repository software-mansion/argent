import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
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
import { isFlagEnabled } from "@argent/configuration-core";
import { ensureDep } from "../../utils/check-deps";
import { InvalidToolInputError, MACOS_APPS_FLAG } from "../../utils/capability";
import { FLAG_META_KEY, renderFlagGated } from "../../utils/flag-gated-text";
import { macosAppServices, macosClick, requireMacosApp } from "../../utils/macos-input";
import { sendCommand } from "../../utils/simulator-client";

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
  return `${action} at (${Math.round(params.x * 100)}%, ${Math.round(params.y * 100)}%)${button}`;
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

const zodSchema = z.object({
  udid: z
    .string()
    .describe(
      "Target device id from `list-devices` (iOS UDID, Android serial, <flag:harmonyos>HarmonyOS id, </flag:harmonyos><flag:macos-apps>Mac app id, </flag:macos-apps>or Chromium id)."
    ),
  x: z.number().min(0).max(1).describe("Horizontal position: 0 = left edge, 1 = right edge."),
  y: z.number().min(0).max(1).describe("Vertical position: 0 = top edge, 1 = bottom edge."),
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
});

type Params = z.infer<typeof zodSchema>;

export const gestureTapTool: ToolDefinition<Params, Result> = {
  id: "gesture-tap",
  description: `Press the device screen (iOS simulator or physical device, Android emulator, <flag:harmonyos>HarmonyOS device, </flag:harmonyos><flag:macos-apps>Mac app, </flag:macos-apps>or Chromium app) at a point given as fractions of the screen width and height (not pixels): a Down event followed by an Up event at the same spot.<flag:macos-apps> On a Mac app it is a click, and x/y are fractions of the area describe reports, not of the window.</flag:macos-apps>
Use when tapping a button, link, or any tappable element on the screen.
Returns { tapped: true, timestampMs }. On physical iOS, reactivated: true = app was re-fronted; re-describe. Fails if the device backend (simulator-server / emulator / Chromium CDP<flag:harmonyos> / \`hdc\`</flag:harmonyos>) is unreachable.
Before tapping, take the coordinates from \`describe\` on every platform (on Chromium it walks the DOM<flag:harmonyos>, on HarmonyOS it reads the \`uitest\` layout dump</flag:harmonyos>). More information in \`argent-device-interact\` skill`,
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
      `Failed to tap at (${Math.round(params.x * 100)}%, ${Math.round(params.y * 100)}%): ${failureSignal.error_code}`,
  },
  capability,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    if (device.platform === "macos") {
      return macosAppServices(device);
    }
    // Refused in `execute`, without starting a backend for a tap that never runs.
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
    const timestampMs = Date.now();
    const clickCount = params.clickCount ?? 1;
    if (device.platform === "macos") {
      const app = requireMacosApp(services, "gesture-tap", device);
      await macosClick(app, params.x, params.y, { clickCount, button: params.button });
      return { tapped: true, timestampMs };
    }
    // The other backends would land a right-click as a plain tap.
    if (params.button === "right") {
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
          isFlagEnabled
        )
      );
    }
    if (device.platform === "chromium") {
      const chromium = services.chromium as ChromiumCdpApi;
      // Mouse dispatch stalls at ~5s per event on a hidden window.
      await assertChromiumWindowVisible(chromium, "tap");
      await tapChromium(chromium, params.x, params.y, clickCount);
      return { tapped: true, timestampMs };
    }
    if (isIosPhysicalDevice(device)) {
      const runner = services.iosDeviceRunner as IosDeviceRunnerApi;
      const bundleId = requireCurrentIosDeviceApp(device.id);
      const viewport = await getViewport(runner, bundleId);
      const point = toPoints(viewport, params.x, params.y);
      // The whole count is one runner command: a double-tap must be the native one, and any loop
      // above 2 stays on-device (single taps either way, but without wire round trips between them).
      const tap = await tapAt(runner, bundleId, point, clickCount);
      // Either leg can be the one that re-fronted a backgrounded target: the
      // viewport read fronts it first, so the tap then finds it foreground.
      const reactivated = viewport.reactivated === true || tap.reactivated;
      return { tapped: true, timestampMs, ...(reactivated ? { reactivated: true as const } : {}) };
    }
    if (device.platform === "harmony") {
      await ensureDep("hdc");
      await tapHarmony(harmonyConnectKey(device.id), params.x, params.y, clickCount, ctx?.signal);
      return { tapped: true, timestampMs };
    }
    const api = services.simulatorServer as SimulatorServerApi;
    let warning: string | undefined;
    for (let i = 1; i <= clickCount; i++) {
      if (i > 1) await sleep(MULTI_TAP_GAP_MS);
      const down = await sendCommand(api, {
        cmd: "touch",
        type: "Down",
        x: params.x,
        y: params.y,
        second_x: null,
        second_y: null,
      });
      warning ??= down.warning;
      await sleep(TAP_HOLD_MS);
      await sendCommand(api, {
        cmd: "touch",
        type: "Up",
        x: params.x,
        y: params.y,
        second_x: null,
        second_y: null,
      });
    }
    return { tapped: true, timestampMs, ...(warning !== undefined ? { warning } : {}) };
  },
};
