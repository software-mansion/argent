import {
  TypedEventEmitter,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceInstance,
  type ServiceEvents,
} from "@argent/registry";
import { adbExecOutBinary, adbShell, getAndroidRuntimeKind } from "../utils/adb";
import { assertTypeableAndroidText, injectAndroidText } from "../utils/android-input";
import { UnsupportedOperationError } from "../utils/capability";
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
 * `ServiceRef` for the Android TV control service. The leanback check happens in
 * the factory, not here (mirroring `tvControlRef` on the tvOS side).
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

// android.view.KeyEvent keycodes for the TV-remote vocabulary (`adb input keyevent`).
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

// One parsed node. A TV surface is focus-driven, so no pixel geometry is kept.
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

function valueOf(attrs: Record<string, string>): string {
  const cd = (attrs["content-desc"] ?? "").trim();
  const text = (attrs.text ?? "").trim();
  // content-desc is the label, so `text` is a distinct value only when both are
  // set and differ (an editable field with a placeholder + typed content).
  return cd && text && cd !== text ? text : "";
}

/**
 * Collect the focused node and every focusable node. `parseUiAutomatorDump`
 * drops the `focused` attribute, so the focus walk needs its own pass.
 */
function collectTvNodes(xml: string): { focused: TvNode | null; focusable: TvNode[] } {
  const root = parseUiAutomatorXml(xml);
  const focusable: TvNode[] = [];
  let focused: TvNode | null = null;
  if (!root) return { focused, focusable };

  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    // Push children in reverse so they pop back in document order.
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);

    const attrs = node.attrs;
    const isFocusable = attrIsTrue(attrs, "focusable");
    const isFocused = attrIsTrue(attrs, "focused");
    if (!isFocusable && !isFocused) continue;

    const label = labelOf(attrs);
    // An unlabelled focusable is a layout focus-trap: kept out of `focusable`,
    // but still reported as the focused node.
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
    // target `platform: "android"`, so confirm leanback here.
    const kind = await getAndroidRuntimeKind(serial);
    if (kind === undefined) {
      throw new Error(
        `${ANDROID_TV_CONTROL_NAMESPACE}: no ready Android device with serial '${serial}'. ` +
          `Run list-devices to find a booted Android TV (a device with runtimeKind 'tv').`
      );
    }
    if (kind !== "tv") {
      // UnsupportedOperationError so http.ts maps it to 400, not a 500 that
      // reads as transient and invites retries of a wrong target.
      throw new UnsupportedOperationError(
        "tv-remote",
        device,
        `${ANDROID_TV_CONTROL_NAMESPACE} is Android-TV-only — serial '${serial}' is a ${kind} ` +
          `device, not a leanback TV; use the standard gesture/keyboard tools for it`
      );
    }

    const events = new TypedEventEmitter<ServiceEvents>();

    async function dumpHierarchy(): Promise<string> {
      // Per-call dump path so concurrent calls on the same serial don't race on
      // a shared /sdcard file. `uiautomator` rejects unwritable paths, hence
      // /data/local/tmp; trailing `; rm -f` so cleanup fires even when it fails.
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
        // `input text` cannot type a newline, crashes on emoji and silently
        // drops other non-ASCII — reject up front as a 400, not a raw adb 500.
        assertTypeableAndroidText(text);
        // `input text` decodes "%s" back into a space on the device, and a bare
        // space is an argument separator — so spaces go as KEYCODE_SPACE
        // keyevents and each space-free word through `injectAndroidText`, which
        // owns the `%`-adjacency handling and the shell quoting. An empty word
        // is a no-op there, so repeated/leading/trailing spaces round-trip.
        const KEYCODE_SPACE = 62;
        const words = text.split(" ");
        for (let i = 0; i < words.length; i++) {
          if (i > 0) {
            await adbShell(serial, `input keyevent ${KEYCODE_SPACE}`, { timeoutMs: 10_000 });
          }
          await injectAndroidText(serial, words[i]!);
        }
      },

      // Android TV reads the live hierarchy on every describe — no cache to drop.
      async recycleAx(): Promise<void> {},
    };

    const instance: ServiceInstance<TvControlApi> = {
      api,
      // Stateless: every call is a fresh adb shell-out, so nothing to tear down.
      dispose: async () => {},
      events,
    };
    return instance;
  },
};
