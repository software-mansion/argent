import {
  TypedEventEmitter,
  type DeviceInfo,
  type Registry,
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
  type ParsedXmlNode,
} from "../tools/describe/platforms/android/uiautomator-parser";
import type { TvControlApi, TvDescribeResponse, TvDirection, TvElement } from "./tv-control-types";
import { androidDevtoolsRef, type AndroidDevtoolsApi } from "./android-devtools";

export const ANDROID_TV_CONTROL_NAMESPACE = "AndroidTvControl";

// DeviceInfo-via-options pattern, matching the other Android/Apple blueprints.
type AndroidTvControlFactoryOptions = Record<string, unknown> & {
  device: DeviceInfo;
  /** Reads the hierarchy through the android-devtools helper; see `readHierarchy`. */
  readHelperHierarchy?: () => Promise<string>;
};

/**
 * `ServiceRef` for the Android TV control service. The leanback check happens in
 * the factory, not here (mirroring `tvControlRef` on the tvOS side). With a
 * registry, describe reads through the android-devtools helper first.
 */
export function androidTvControlRef(
  device: DeviceInfo,
  registry?: Registry
): {
  urn: string;
  options: AndroidTvControlFactoryOptions;
} {
  return {
    urn: `${ANDROID_TV_CONTROL_NAMESPACE}:${device.id}`,
    options: registry
      ? { device, readHelperHierarchy: () => readHelperHierarchy(registry, device) }
      : { device },
  };
}

// Resolved per read, not held: the registry respawns a helper that exited or
// was disposed, and a helper that can't start fails just this read.
async function readHelperHierarchy(registry: Registry, device: DeviceInfo): Promise<string> {
  const ref = androidDevtoolsRef(device);
  const devtools = await registry.resolveService<AndroidDevtoolsApi>(ref.urn, ref.options);
  // clearCache: describe is re-read right after each tv-remote press, and a
  // cached read can serve the focus from before it.
  const { xml } = await devtools.getHierarchy({ clearCache: true });
  return xml;
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

// AccessibilityWindowInfo.TYPE_INPUT_METHOD.
const WINDOW_TYPE_INPUT_METHOD = "2";

function hasFocusedNode(node: ParsedXmlNode): boolean {
  return attrIsTrue(node.attrs, "focused") || node.children.some(hasFocusedNode);
}

/**
 * The window the remote drives. The helper reads every interactive window, its
 * roots tagged `window-type` and topmost first, and the window under a dialog
 * keeps its view focus, so the topmost window holding focus wins. That is the
 * on-screen keyboard while it is up: the D-pad moves between its keys, so they
 * are the focusable set. A tree with no tagged roots (a dump, or the helper's
 * active-window fallback) is already one window.
 */
function activeWindow(root: ParsedXmlNode): ParsedXmlNode {
  const windows = root.children.filter((c) => c.attrs["window-type"] !== undefined);
  if (windows.length === 0) return root;
  return (
    windows.find(hasFocusedNode) ??
    windows.find((w) => w.attrs["window-type"] !== WINDOW_TYPE_INPUT_METHOD) ??
    windows[0]!
  );
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

  const stack = [activeWindow(root)];
  while (stack.length > 0) {
    const node = stack.pop()!;
    // `uiautomator dump` leaves out a node the user can't see and everything
    // under it; the helper keeps it and marks it, so skip it the same way.
    if (node.attrs["visible-to-user"] === "false") continue;
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
    const { device, readHelperHierarchy } = opts;
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
        const output = raw.trim().slice(0, 200);
        // `uiautomator` can't register its UiAutomation connection while another
        // client holds one, and the system kills it.
        if (/\bKilled\b/.test(output)) {
          throw new Error(
            `uiautomator could not capture the screen: ${output}. Another UiAutomation client ` +
              `(the argent devtools helper, or a test runner such as Espresso or Appium) holds ` +
              `the accessibility connection. Stop it, for the helper with ` +
              `\`adb shell am force-stop com.argent.androiddevtools\`, and try again.`
          );
        }
        throw new Error(
          `uiautomator could not capture the screen: ${output}. ` +
            `The device may be locked or showing a secure overlay — take a screenshot to confirm.`
        );
      }
      return raw;
    }

    // The helper first, `uiautomator dump` on any error. They can't both run:
    // the helper holds the device's UiAutomation connection, and a dump taken
    // while it does is killed (#1316). The helper's XML is the same format,
    // with the focusable / focused / selected attributes collectTvNodes reads.
    async function readHierarchy(): Promise<string> {
      if (readHelperHierarchy) {
        try {
          return await readHelperHierarchy();
        } catch (err) {
          console.debug(
            `[android-tv-control] devtools helper failed, falling back to uiautomator dump: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
      return dumpHierarchy();
    }

    async function read(): Promise<{ focused: TvNode | null; focusable: TvNode[] }> {
      return collectTvNodes(await readHierarchy());
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
