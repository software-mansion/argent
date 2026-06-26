import {
  TypedEventEmitter,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceInstance,
  type ServiceEvents,
} from "@argent/registry";
import { adbExecOutBinary, adbShell, shellQuote, getAndroidRuntimeKind } from "../utils/adb";
import {
  parseUiAutomatorXml,
  attrIsTrue,
  labelOf,
} from "../tools/describe/platforms/android/uiautomator-parser";
import type { TvControlApi, TvDescribeResponse, TvDirection, TvElement } from "./tv-control-types";

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
// directional pad — there is no touch — so the full TV-remote vocabulary maps
// onto Android KEYCODE_* values:
//   back → BACK; menu → KEYCODE_MENU (the options-menu affordance, distinct from
//   back). The media-transport and volume keys map onto the standard Android
//   media/volume keycodes, all of which `adb input keyevent` accepts.
const KEYEVENTS: Record<TvDirection, number> = {
  up: 19, // KEYCODE_DPAD_UP
  down: 20, // KEYCODE_DPAD_DOWN
  left: 21, // KEYCODE_DPAD_LEFT
  right: 22, // KEYCODE_DPAD_RIGHT
  select: 23, // KEYCODE_DPAD_CENTER
  back: 4, // KEYCODE_BACK
  home: 3, // KEYCODE_HOME
  menu: 82, // KEYCODE_MENU
  playPause: 85, // KEYCODE_MEDIA_PLAY_PAUSE
  rewind: 89, // KEYCODE_MEDIA_REWIND
  fastForward: 90, // KEYCODE_MEDIA_FAST_FORWARD
  next: 87, // KEYCODE_MEDIA_NEXT
  previous: 88, // KEYCODE_MEDIA_PREVIOUS
  volumeUp: 24, // KEYCODE_VOLUME_UP
  volumeDown: 25, // KEYCODE_VOLUME_DOWN
  mute: 164, // KEYCODE_VOLUME_MUTE
};

// One parsed focusable node. A TV surface is focus-driven (no tap coordinates),
// so we keep only what the focus view renders — no pixel geometry.
interface TvNode {
  label: string;
  value: string;
  focused: boolean;
  selected: boolean;
  disabled: boolean;
  isButton: boolean;
  isEditable: boolean;
  pkg: string;
}

// `attrIsTrue` and `labelOf` (the content-desc-vs-text label contract) are
// shared with the phone describe parser so the two stay in lockstep — imported
// from uiautomator-parser rather than re-implemented here.

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
 * raw `focused` flag, so this is a dedicated lightweight pass.
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
    traits: traitsOf(n),
    value: n.value || undefined,
    isFocused: n.focused,
  };
}

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

      async navigate(direction: TvDirection): Promise<void> {
        await pressKey(direction);
      },

      async type(text: string): Promise<void> {
        // `input text` decodes the two-char sequence "%s" back into a space on
        // the device — and a bare space is an argument separator — so the old
        // `replace(/ /g, "%s")` was not round-trip safe: a user string that
        // already contained "%s" came out with a stray space and no error.
        //
        // Instead, send real spaces as KEYCODE_SPACE keyevents (never emitting
        // "%s" ourselves), and split each non-space run after every "%" so a
        // user-supplied "%s" can never sit adjacent inside one `input text`
        // call — `%` and `s` land in separate invocations and arrive verbatim.
        // Quoting keeps all other shell metacharacters inert. Empty input is a
        // no-op.
        if (text.length === 0) return;
        const KEYCODE_SPACE = 62;
        const words = text.split(" ");
        for (let i = 0; i < words.length; i++) {
          if (i > 0) {
            await adbShell(serial, `input keyevent ${KEYCODE_SPACE}`, { timeoutMs: 10_000 });
          }
          for (const chunk of words[i]!.split(/(?<=%)/)) {
            if (chunk) {
              await adbShell(serial, `input text ${shellQuote(chunk)}`, { timeoutMs: 15_000 });
            }
          }
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
