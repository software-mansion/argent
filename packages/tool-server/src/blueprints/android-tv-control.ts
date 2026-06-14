import {
  TypedEventEmitter,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceInstance,
  type ServiceEvents,
} from "@argent/registry";
import { adbExecOutBinary, adbShell, shellQuote, getAndroidRuntimeKind } from "../utils/adb";
import { getAndroidScreenSize } from "../utils/android-screen";
import {
  parseUiAutomatorXml,
  parseUiAutomatorBounds,
} from "../tools/describe/platforms/android/uiautomator-parser";
import type {
  TvControlApi,
  TvDescribeResponse,
  TvDirection,
  TvElement,
} from "./tv-control-types";

export const ANDROID_TV_CONTROL_NAMESPACE = "AndroidTvControl";

// DeviceInfo-via-options pattern, matching the other Android/Apple blueprints.
type AndroidTvControlFactoryOptions = Record<string, unknown> & {
  device: DeviceInfo;
};

/**
 * Build the `ServiceRef` for the Android TV control service keyed by a resolved
 * `DeviceInfo`. The factory verifies the target really is an Android TV
 * (leanback) device — `resolveDevice` only classifies by serial shape and tags
 * every Android target `platform: "android"`, so the runtime-kind check lives
 * in the factory (mirroring `tvControlRef` on the tvOS side).
 */
export function androidTvControlRef(device: DeviceInfo): {
  urn: string;
  options: AndroidTvControlFactoryOptions;
} {
  return {
    urn: `${ANDROID_TV_CONTROL_NAMESPACE}:${device.id}`,
    options: { device },
  };
}

// D-pad / system keyevents. Android TV is driven entirely through the remote's
// directional pad — there is no touch — so the same eight logical actions the
// tvOS Siri-remote exposes map onto Android KEYCODE_* values:
//   menu → BACK (tvOS "menu" is the back gesture; Android's equivalent is BACK,
//   KEYCODE_MENU opens an options menu which is not the same affordance).
const KEYEVENTS: Record<TvDirection, number> = {
  up: 19, // KEYCODE_DPAD_UP
  down: 20, // KEYCODE_DPAD_DOWN
  left: 21, // KEYCODE_DPAD_LEFT
  right: 22, // KEYCODE_DPAD_RIGHT
  select: 23, // KEYCODE_DPAD_CENTER
  menu: 4, // KEYCODE_BACK
  home: 3, // KEYCODE_HOME
  playpause: 85, // KEYCODE_MEDIA_PLAY_PAUSE
};

interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// One parsed focusable node, kept in pixel space for the set-focus geometry walk.
interface TvNode {
  label: string;
  value: string;
  rect: PixelRect | null;
  focused: boolean;
  selected: boolean;
  disabled: boolean;
  isButton: boolean;
  isEditable: boolean;
  pkg: string;
}

function attrIsTrue(attrs: Record<string, string>, key: string): boolean {
  return attrs[key] === "true";
}

// Prefer the screen-reader label (content-desc) and surface the user-typed text
// as `value`, the same split `describe` uses. Either may be empty.
function labelOf(attrs: Record<string, string>): string {
  const cd = (attrs["content-desc"] ?? "").trim();
  if (cd) return cd;
  return (attrs.text ?? "").trim();
}

function valueOf(attrs: Record<string, string>): string {
  const cd = (attrs["content-desc"] ?? "").trim();
  const text = (attrs.text ?? "").trim();
  // When both are populated and differ, content-desc is the label and text is
  // the value (an editable field with a placeholder + typed content). When only
  // one is set it's already the label, so there's no separate value.
  return cd && text && cd !== text ? text : "";
}

/**
 * Walk a parsed uiautomator tree collecting the focused node and every
 * focusable node. Unlike `parseUiAutomatorDump` (which drops the `focused`
 * attribute and normalises to the describe contract), the focus walk needs the
 * raw `focused` flag and pixel bounds, so this is a dedicated lightweight pass.
 */
function collectTvNodes(xml: string): { focused: TvNode | null; focusable: TvNode[] } {
  const root = parseUiAutomatorXml(xml);
  const focusable: TvNode[] = [];
  let focused: TvNode | null = null;
  if (!root) return { focused, focusable };

  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    // Push children in reverse so they pop back in document order — the agent
    // sees focusables in the same top-to-bottom / left-to-right order the dump
    // lists them, which matches how D-pad focus traverses them.
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);

    const attrs = node.attrs;
    const isFocusable = attrIsTrue(attrs, "focusable");
    const isFocused = attrIsTrue(attrs, "focused");
    if (!isFocusable && !isFocused) continue;

    const label = labelOf(attrs);
    // A focusable node with no label is a layout focus-trap, not something the
    // agent can identify — skip it for the focusable list (but still honour it
    // as the focused node so describe can report "focused but unlabelled").
    const className = attrs.class ?? "";
    const tvNode: TvNode = {
      label,
      value: valueOf(attrs),
      rect: parseUiAutomatorBounds(attrs.bounds ?? ""),
      focused: isFocused,
      selected: attrIsTrue(attrs, "selected"),
      disabled: attrs.enabled === "false",
      isButton: /Button/.test(className),
      isEditable: /EditText/.test(className),
      pkg: attrs.package ?? "",
    };
    if (isFocused && !focused) focused = tvNode;
    if (isFocusable && label) focusable.push(tvNode);
  }
  return { focused, focusable };
}

function traitsOf(n: TvNode): string[] {
  const traits: string[] = [];
  if (n.isButton) traits.push("button");
  if (n.isEditable) traits.push("textfield");
  if (n.selected) traits.push("selected");
  if (n.disabled) traits.push("disabled");
  return traits;
}

function toTvElement(n: TvNode): TvElement {
  return {
    label: n.label || undefined,
    frame: n.rect
      ? { x: n.rect.x, y: n.rect.y, width: n.rect.w, height: n.rect.h }
      : undefined,
    traits: traitsOf(n),
    value: n.value || undefined,
    isFocused: n.focused,
  };
}

function centre(r: PixelRect): { cx: number; cy: number } {
  return { cx: r.x + r.w / 2, cy: r.y + r.h / 2 };
}

// First line, lowercased+trimmed — the label `tv-set-focus` matches on (Android
// labels are usually single-line, but content-desc can be compound).
function normaliseLabel(label: string): string {
  return (label.split("\n")[0] ?? "").toLowerCase().trim();
}

/** Case-insensitive match: exact first-line, then prefix, then substring. */
function labelMatches(candidate: string, target: string): boolean {
  const c = normaliseLabel(candidate);
  const t = target;
  return c === t || c.startsWith(t) || c.includes(t);
}

// Upper bound on D-pad hops for a set-focus walk. A TV grid is rarely deeper
// than this; the loop also bails early when focus stops moving, so this is just
// the backstop against a layout where focus cycles without ever landing.
const MAX_FOCUS_STEPS = 25;

export const androidTvControlBlueprint: ServiceBlueprint<TvControlApi, DeviceInfo> = {
  namespace: ANDROID_TV_CONTROL_NAMESPACE,

  getURN(device: DeviceInfo) {
    return `${ANDROID_TV_CONTROL_NAMESPACE}:${device.id}`;
  },

  async factory(_deps, _payload, options) {
    const opts = options as unknown as AndroidTvControlFactoryOptions | undefined;
    if (!opts?.device) {
      throw new Error(
        `${ANDROID_TV_CONTROL_NAMESPACE}.factory requires a resolved DeviceInfo via options.device. ` +
          `Use androidTvControlRef(device) when registering the service ref.`
      );
    }
    const { device } = opts;
    if (typeof device.id !== "string" || device.id.length === 0) {
      throw new Error(
        `${ANDROID_TV_CONTROL_NAMESPACE}.factory requires a non-empty device.id; got ${JSON.stringify(device.id)}.`
      );
    }
    const serial = device.id;

    // resolveDevice classifies by serial shape alone and tags every Android
    // target `platform: "android"`, so confirm this is actually a leanback (TV)
    // device here. Yields a clear error when someone points a tv-* tool at a
    // phone/tablet emulator.
    const kind = await getAndroidRuntimeKind(serial);
    if (kind === undefined) {
      throw new Error(
        `${ANDROID_TV_CONTROL_NAMESPACE}: no ready Android device with serial '${serial}'. ` +
          `Run list-devices to find a booted Android TV (a device with runtimeKind 'tv').`
      );
    }
    if (kind !== "tv") {
      throw new Error(
        `${ANDROID_TV_CONTROL_NAMESPACE} is Android-TV-only. Serial '${serial}' is a ${kind} device, ` +
          `not a leanback TV — use the standard gesture/keyboard tools for it.`
      );
    }

    const events = new TypedEventEmitter<ServiceEvents>();

    async function dumpHierarchy(): Promise<string> {
      // Per-call dump path so concurrent calls on the same serial don't race on
      // a shared /sdcard file (one call's cat reading the other's mid-write).
      // /data/local/tmp is world-writable on every Android we support; trailing
      // `; rm -f` (not `&&`) so cleanup fires even when dump/cat fails.
      const suffix = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
      const dumpPath = `/data/local/tmp/argent-tv-dump-${suffix}.xml`;
      const raw = (
        await adbExecOutBinary(
          serial,
          `uiautomator dump --compressed ${dumpPath} >/dev/null && cat ${dumpPath}; rm -f ${dumpPath}`,
          { timeoutMs: 20_000 }
        )
      ).toString("utf-8");
      if (!raw.includes("<hierarchy")) {
        throw new Error(
          `uiautomator could not capture the screen: ${raw.trim().slice(0, 200)}. ` +
            `The device may be locked or showing a secure overlay — take a screenshot to confirm.`
        );
      }
      return raw;
    }

    async function read(): Promise<{ focused: TvNode | null; focusable: TvNode[] }> {
      return collectTvNodes(await dumpHierarchy());
    }

    async function pressKey(direction: TvDirection): Promise<void> {
      await adbShell(serial, `input keyevent ${KEYEVENTS[direction]}`, { timeoutMs: 10_000 });
    }

    const api: TvControlApi = {
      async describe(): Promise<TvDescribeResponse> {
        const { focused, focusable } = await read();
        const pkg = focused?.pkg || focusable.find((n) => n.pkg)?.pkg;
        return {
          bundleId: pkg || undefined,
          focused: focused ? toTvElement(focused) : null,
          focusable: focusable.map(toTvElement),
        };
      },

      async hierarchy(): Promise<unknown> {
        return parseUiAutomatorXml(await dumpHierarchy());
      },

      async navigate(direction: TvDirection): Promise<void> {
        await pressKey(direction);
      },

      async type(text: string): Promise<void> {
        // `input text` treats a literal space as an argument separator, so
        // spaces must be sent as %s. Quoting the whole token keeps every other
        // shell metacharacter inert (adb re-parses the command through the
        // device shell). Empty input is a no-op.
        if (text.length === 0) return;
        const encoded = text.replace(/ /g, "%s");
        await adbShell(serial, `input text ${shellQuote(encoded)}`, { timeoutMs: 15_000 });
      },

      async setFocus(label: string): Promise<{ ok: boolean; message: string }> {
        const target = normaliseLabel(label);
        if (!target) return { ok: false, message: "Empty label" };

        let state = await read();
        // Already focused? (focus engine treats a no-op move as a failure, so
        // short-circuit like the tvOS backend does.)
        if (state.focused && labelMatches(state.focused.label, target)) {
          return { ok: true, message: "Already focused" };
        }

        // Confirm the target is actually on screen before walking — otherwise
        // we'd burn the whole step budget chasing a label that isn't there.
        const targetNode = state.focusable.find((n) => labelMatches(n.label, target));
        if (!targetNode || !targetNode.rect) {
          return {
            ok: false,
            message:
              `No focusable element matching "${label}" is on screen. ` +
              `Call tv-describe to see the available labels, or tv-navigate step by step.`,
          };
        }

        // Geometry-driven D-pad walk: each step move along whichever axis has
        // the larger remaining gap between the focused element and the target,
        // re-read, and stop when focus lands on the target. Android TV has no
        // "jump to label" primitive (unlike tvOS's setNativeFocus), so this
        // emulates it with directional presses — best-effort and bounded.
        const seen = new Set<string>();
        const tc = centre(targetNode.rect);
        for (let step = 0; step < MAX_FOCUS_STEPS; step++) {
          const cur = state.focused;
          if (cur && labelMatches(cur.label, target)) {
            return { ok: true, message: `Focused after ${step} step(s)` };
          }
          if (!cur || !cur.rect) {
            // No focus anywhere — nudge once to give the engine a focused node.
            await pressKey("down");
            state = await read();
            continue;
          }
          // Detect a loop: if we return to a focused element we've already
          // visited, the walk can't reach the target (disjoint focus groups).
          const fingerprint = `${normaliseLabel(cur.label)}@${cur.rect.x},${cur.rect.y}`;
          if (seen.has(fingerprint)) {
            return {
              ok: false,
              message:
                `Could not reach "${label}" by D-pad navigation (focus looped without landing on it). ` +
                `It may be in a separate focus group — use tv-navigate to cross over manually.`,
            };
          }
          seen.add(fingerprint);

          const cc = centre(cur.rect);
          const dx = tc.cx - cc.cx;
          const dy = tc.cy - cc.cy;
          const direction: TvDirection =
            Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
          await pressKey(direction);
          state = await read();
        }

        const landed = state.focused?.label ?? "(none)";
        return {
          ok: false,
          message:
            `Could not reach "${label}" within ${MAX_FOCUS_STEPS} D-pad steps (focus is on "${landed}"). ` +
            `Use tv-navigate to step the remaining distance.`,
        };
      },

      async ping(): Promise<boolean> {
        try {
          // `wm size` is a cheap, always-available shell command — a successful
          // parse proves the adb shell to this serial is responsive.
          await getAndroidScreenSize(serial);
          return true;
        } catch {
          return false;
        }
      },

      // Android TV reads the live hierarchy on every describe (no cached
      // daemon), so there is no stale-cache class of bug to recover from.
      async recycleAx(): Promise<void> {},
    };

    const instance: ServiceInstance<TvControlApi> = {
      api,
      // Stateless: every method is a fresh adb shell-out, so there is nothing to
      // tear down. Present to satisfy the ServiceInstance contract.
      dispose: async () => {},
      events,
    };
    return instance;
  },
};
