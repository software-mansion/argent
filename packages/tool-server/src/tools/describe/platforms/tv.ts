import type { DeviceInfo, Registry } from "@argent/registry";
import type { DescribeResult } from "../contract";
import { formatDescribeTree } from "../format-tree";
import { resolveTvApi } from "../../tv/tv-service";
import { describeAndroid } from "./android";
import type {
  TvControlApi,
  TvDescribeResponse,
  TvElement,
} from "../../../blueprints/tv-control-types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// An empty focus set right after launch-app / restart-app has two causes that
// look identical from the host: the app is still on its splash screen (a React
// Native app exposes focus only once its JS bundle has loaded), or (Apple TV)
// the ax daemon's AXRuntime `primaryApp` cache still points at the killed app
// process. So retry in place first, then recycle the read path once — a fresh
// daemon rebinds to the current foreground app, so a stale cache populates
// while a genuinely loading screen stays empty.
const EMPTY_RETRY_ATTEMPTS = 3;
const EMPTY_RETRY_DELAY_MS = 600;
const EMPTY_HINT =
  "No focusable elements after retrying and recycling the read path. The app is most likely " +
  "still launching (splash / loading screen) or mid-transition — this is normal right after " +
  "launch-app / restart-app. Wait ~2-3s and call describe again; a React Native app only " +
  "exposes focus once its JS bundle has loaded. If it stays empty, take a screenshot to confirm " +
  "what's actually on screen.";

// Android TV reads focus from the OS accessibility tree (uiautomator), which
// does not expose focus driven by react-native-tvos's own focus engine — so the
// focus view can be empty on a screen that visibly has selectable tiles.
const ANDROID_FOCUS_EMPTY_HINT =
  "The Android TV focus engine reported no focusable elements — common on react-native-tvos " +
  "screens that drive focus with RN's own engine (invisible to the OS accessibility tree). " +
  "Falling back to the full UI tree below. `tv-remote` (direction/select) still moves focus on " +
  "these screens even though the labels aren't enumerable, so you can drive blind + screenshot " +
  "to confirm.";

function isEmpty(res: TvDescribeResponse): boolean {
  return res.focusable.length === 0 && !res.focused;
}

/**
 * tvOS AX labels are often compound multi-line strings, e.g.
 * "Home\nLander\nSide bar content item\n1 of 5\nselected".
 */
function primaryLabel(label: string | undefined): string {
  if (!label) return "(no label)";
  const firstLine = label.split("\n")[0]?.trim();
  return firstLine && firstLine.length ? firstLine : "(no label)";
}

function fmtElement(e: TvElement): string {
  const traits = e.traits?.length ? ` [${e.traits.join(",")}]` : "";
  const value = e.value ? ` = "${e.value}"` : "";
  const label = primaryLabel(e.label);
  const extraLines = (e.label ?? "")
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean);
  const context = extraLines.length ? ` (${extraLines.join(" · ")})` : "";
  return `${label}${value}${traits}${context}`;
}

function renderFocusView(res: TvDescribeResponse): string {
  const lines: string[] = [];
  if (res.bundleId) lines.push(`App: ${res.bundleId}`);
  lines.push(`Focused: ${res.focused ? fmtElement(res.focused) : "(none)"}`);
  if (res.focusable.length) {
    lines.push(`Focusable (${res.focusable.length}):`);
    for (const e of res.focusable) {
      const marker = e.isFocused ? "→ " : "  ";
      lines.push(`${marker}${fmtElement(e)}`);
    }
  } else {
    lines.push("Focusable: (none reported)");
  }
  return lines.join("\n");
}

/**
 * `describe` for a TV target (Apple TV simulator or Android TV / leanback
 * device): the focus-driven view instead of the touch element tree, since a TV
 * UI has no tap coordinates — the agent moves the highlight with `tv-remote`
 * and re-reads with `describe`.
 */
export async function describeTv(registry: Registry, device: DeviceInfo): Promise<DescribeResult> {
  const api: TvControlApi = await resolveTvApi(registry, device.id);

  // Ride out a brief post-launch transition window (see EMPTY_RETRY_*). Apple TV
  // only: on Android TV an empty focus set is steady state for react-native-tvos
  // screens, not a transition, so retrying would just burn uiautomator dumps
  // before the empty-focus fallback below.
  let res = await api.describe();
  if (device.platform !== "android") {
    for (let attempt = 1; attempt < EMPTY_RETRY_ATTEMPTS && isEmpty(res); attempt++) {
      await sleep(EMPTY_RETRY_DELAY_MS);
      res = await api.describe();
    }
  }

  // Still empty: on Apple TV the daemon may hold a stale primaryApp cache from a
  // killed app, and a fresh daemon rebinds to the current foreground app.
  // Skipped on Android TV, where `recycleAx` is a no-op and the re-probe would
  // only repeat the dump the retry loop already found empty.
  if (isEmpty(res) && device.platform !== "android") {
    await api.recycleAx();
    res = await api.describe();
  }

  // Android TV with a still-empty focus engine: fall back to the full
  // uiautomator tree so describe stays useful on RN-focus-engine screens.
  if (isEmpty(res) && device.platform === "android") {
    // The dispatcher routed us here via isAndroidTv, so pass isTv through to
    // skip a redundant probe. Let a capture failure propagate: describeAndroid
    // throws an actionable error (device locked / keyguard / DRM / secure
    // overlay, or an adb failure), more useful than the generic EMPTY_HINT.
    const data = await describeAndroid(registry, device.id, undefined, true);
    return {
      description: `${ANDROID_FOCUS_EMPTY_HINT}\n\n${formatDescribeTree(data.tree, {
        source: data.source,
      })}`,
      source: data.source,
      hint: ANDROID_FOCUS_EMPTY_HINT,
    };
  }

  const empty = isEmpty(res);
  const description = empty
    ? `${renderFocusView(res)}\n\nNote: ${EMPTY_HINT}`
    : renderFocusView(res);

  return {
    description,
    source: "tv-focus",
    ...(empty ? { hint: EMPTY_HINT } : {}),
  };
}
