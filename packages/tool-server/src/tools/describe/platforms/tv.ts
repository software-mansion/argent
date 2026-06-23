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
// look identical from the host:
//   1. The app is still on its splash / loading screen and genuinely has no
//      focusable views yet (a React Native app only exposes focus once its JS
//      bundle has loaded).
//   2. (Apple TV) the ax daemon's AXRuntime `primaryApp` cache is stale — still
//      pointing at the app process that launch-app / restart-app killed — so it
//      reports nothing for a screen that is actually fully rendered.
// We can't tell them apart from a single probe, so: first ride out a brief
// transition window with in-place retries (handles case 1's tail). If still
// empty, recycle the read path once and re-probe — on Apple TV a fresh daemon
// rebinds to the current foreground app, so a stale cache (case 2) now
// populates while a truly loading screen (case 1) stays empty. (On Android TV
// `recycleAx` is a no-op; the empty-focus fallback below covers it instead.)
const EMPTY_RETRY_ATTEMPTS = 3;
const EMPTY_RETRY_DELAY_MS = 600;
const EMPTY_HINT =
  "No focusable elements after retrying and recycling the read path. The app is most likely " +
  "still launching (splash / loading screen) or mid-transition — this is normal right after " +
  "launch-app / restart-app. Wait ~2-3s and call describe again; a React Native app only " +
  "exposes focus once its JS bundle has loaded. If it stays empty, take a screenshot to confirm " +
  "what's actually on screen.";

// Android TV reads focus from the OS accessibility tree (uiautomator). Many
// react-native-tvos screens manage focus with RN's *own* focus engine, which
// Android's accessibility tree does not expose — so the focus view can be empty
// on a screen that visibly has selectable tiles. When that happens we fall back
// to the full uiautomator tree (the same one `describe` returns on a phone) so
// the agent still gets a usable rendering instead of "(none reported)".
const ANDROID_FOCUS_EMPTY_HINT =
  "The Android TV focus engine reported no focusable elements — common on react-native-tvos " +
  "screens that drive focus with RN's own engine (invisible to the OS accessibility tree). " +
  "Falling back to the full UI tree below. `tv-remote` (direction/select) still moves focus on " +
  "these screens even though the labels aren't enumerable, so you can drive blind + screenshot " +
  "to confirm.";

/** A describe result is "empty" when the focus engine reports nothing actionable. */
function isEmpty(res: TvDescribeResponse): boolean {
  return res.focusable.length === 0 && !res.focused;
}

/**
 * tvOS AX labels are often compound multi-line strings, e.g.
 * "Home\nLander\nSide bar content item\n1 of 5\nselected". Focus-by-label
 * matches on the first line, so that is the label the agent should copy. Return
 * it as the actionable label and keep the remaining lines as compact context.
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
  // Surface any extra lines of a compound label as dim context, so the agent
  // sees the full text but knows the first line is what focus-by-label wants.
  const extraLines = (e.label ?? "")
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean);
  const context = extraLines.length ? ` (${extraLines.join(" · ")})` : "";
  return `${label}${value}${traits}${context}`;
}

/**
 * Render the TV focus state as text. A TV UI is focus-driven — there are no tap
 * coordinates to act on — so the agent moves the highlight with `tv-remote`
 * (up/down/left/right/select/…) and confirms with another `describe`.
 * The rendering centers on "what's focused" and "what can be focused".
 */
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
 * device). Returns the focus-driven view — the currently focused element and
 * all focusable elements — instead of the touch-oriented element tree, since a
 * TV UI has no tap coordinates. The agent moves the highlight with `tv-remote`
 * (up/down/left/right/select/…) and re-reads with `describe`.
 *
 * Routed here from `describe`'s execute before the iOS/Android dispatch, so the
 * agent uses one `describe` for every target and never has to know up front
 * whether a UDID is a phone or an Apple TV.
 */
export async function describeTv(registry: Registry, device: DeviceInfo): Promise<DescribeResult> {
  const api: TvControlApi = await resolveTvApi(registry, device.id);

  // Ride out a brief post-launch / transition window where the focus engine
  // hasn't populated yet (see EMPTY_RETRY_* / EMPTY_HINT).
  let res = await api.describe();
  for (let attempt = 1; attempt < EMPTY_RETRY_ATTEMPTS && isEmpty(res); attempt++) {
    await sleep(EMPTY_RETRY_DELAY_MS);
    res = await api.describe();
  }

  // Still empty after the transition window: on Apple TV the daemon may be
  // holding a stale primaryApp cache from a killed app. Recycle it once and
  // re-probe — a fresh daemon rebinds to the current foreground app, recovering
  // a fully-rendered screen the stale cache reported as empty. (No-op on
  // Android TV.)
  if (isEmpty(res)) {
    await api.recycleAx();
    res = await api.describe();
  }

  // Android TV with a still-empty focus engine: fall back to the full
  // uiautomator tree so describe stays useful on RN-focus-engine screens.
  if (isEmpty(res) && device.platform === "android") {
    try {
      const data = await describeAndroid(registry, device.id);
      return {
        description: `${ANDROID_FOCUS_EMPTY_HINT}\n\n${formatDescribeTree(data.tree, {
          source: data.source,
        })}`,
        source: data.source,
        hint: ANDROID_FOCUS_EMPTY_HINT,
      };
    } catch {
      // Fall through to the empty focus rendering + EMPTY_HINT below.
    }
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
