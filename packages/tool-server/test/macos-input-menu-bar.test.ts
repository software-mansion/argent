import { afterEach, describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, ToolNotFoundError, getFailureSignal } from "@argent/registry";
import { assertSupported, UnsupportedOperationError } from "../src/utils/capability";
import { resolveDevice } from "../src/utils/device-info";
import { menuBarTool } from "../src/tools/menu-bar";
import { useMacosAppsFlag } from "./helpers/macos-apps-flag";
import { MAC_ID, errorOf, fakeMacosApp, macosToolRegistry } from "./helpers/macos-input-fake";

const flag = useMacosAppsFlag();

type Item = Record<string, unknown>;

const item = (path: string[], extra: Item = {}): Item => ({
  title: path[path.length - 1]!,
  path,
  enabled: true,
  ...extra,
});

/** A menu bar with each kind of line the list renders. */
const MENUS: Item[] = [
  item(["Probe"], {
    submenu: true,
    items: [item(["Probe", "Quit Probe"], { keyEquivalent: "q", modifiers: ["command"] })],
  }),
  item(["Edit"], {
    submenu: true,
    items: [
      item(["Edit", "Undo"], { enabled: false, keyEquivalent: "z", modifiers: ["command"] }),
      item(["Edit", "Redo"], { enabled: false, keyEquivalent: "Z", modifiers: ["command"] }),
      item(["Edit", "Delete Word"], { keyEquivalent: "\u007f", modifiers: ["option", "command"] }),
      item(["Edit", "Writing Tools"], { submenu: true, items: [] }),
    ],
  }),
  item(["View"], {
    submenu: true,
    items: [
      item(["View", "Enter Full Screen"], { keyEquivalent: "f", modifiers: ["function"] }),
      item(["View", "Previous Page"], {
        keyEquivalent: "",
        modifiers: ["command", "option"],
      }),
      item(["View", "Refresh"], { keyEquivalent: "" }),
      item(["View", "Sidebar"], { state: "on" }),
      item(["View", "Mixed"], { state: "mixed", enabled: false }),
      item(["View", "Close All"], {
        alternate: true,
        keyEquivalent: "w",
        modifiers: ["command", "option"],
      }),
    ],
  }),
  item(["Tools"], {
    submenu: true,
    items: [
      item(["Tools", "Export…"], { identifier: "tools.export" }),
      item(["Tools", "Speed"], {
        submenu: true,
        items: [item(["Tools", "Speed", "Fast"], { state: "on" })],
      }),
    ],
  }),
];

function harness(list: Item = { appName: "Probe", menus: MENUS, count: 17, truncated: false }) {
  const { app, calls } = fakeMacosApp({
    "Menu.list": () => list,
    "Menu.perform": (params) => ({
      // The path as the app titles it.
      path: ["Tools", "Export…"],
      ...(params.identifier ? { identifier: "tools.export" } : {}),
      performed: "scheduled",
    }),
  });
  const { registry, urns } = macosToolRegistry(app, () => [menuBarTool]);
  return {
    registry,
    calls,
    urns,
    invoke: (args: Record<string, unknown>) =>
      registry.invokeTool("menu-bar", { udid: MAC_ID, ...args }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("menu-bar", () => {
  it("is hidden behind the macos-apps flag and declared for Mac apps only", async () => {
    expect(menuBarTool.featureFlag).toBe("macos-apps");
    expect(menuBarTool.capability).toEqual({ macos: { app: true } });
    expect(() =>
      assertSupported("menu-bar", menuBarTool.capability, resolveDevice("emulator-5554"))
    ).toThrow(UnsupportedOperationError);
    flag.off();
    const { invoke, urns } = harness();
    expect(await errorOf(invoke({ action: "list" }))).toBeInstanceOf(ToolNotFoundError);
    expect(urns).toEqual([]);
  });

  it("refuses a device that is not a Mac app even when a flow skips the capability gate", async () => {
    const { registry, urns } = harness();
    const err = await errorOf(
      registry.invokeTool("menu-bar", { udid: "chromium-cdp-9222", action: "list" })
    );
    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.TOOL_CAPABILITY_UNSUPPORTED_OPERATION
    );
    expect(urns).toEqual([]);
  });

  it("lists the menu bar as indented lines with flags, shortcuts and ids", async () => {
    const { invoke, calls } = harness();
    await expect(invoke({ action: "list" })).resolves.toEqual({
      menuBar: [
        "Probe >",
        "  Quit Probe  command+q",
        "Edit >",
        "  Undo  [disabled]  command+z",
        "  Redo  [disabled]  command+shift+z",
        "  Delete Word  command+option+backspace",
        "  Writing Tools >",
        "View >",
        "  Enter Full Screen  fn+f",
        "  Previous Page  command+option+arrow-left",
        "  Refresh  f5",
        "  Sidebar  [checked]",
        "  Mixed  [disabled, mixed]",
        "  Close All  [alternate]  command+option+w",
        "Tools >",
        '  Export…  id="tools.export"',
        "  Speed >",
        "    Fast  [checked]",
      ],
      items: 17,
    });
    expect(calls).toEqual([{ method: "Menu.list", params: {} }]);
  });

  it("explains a modal session and a cut list in the hint", async () => {
    const { invoke } = harness({ menus: [], count: 2000, truncated: true, modal: true });
    const result = (await invoke({ action: "list" })) as { truncated?: boolean; hint?: string };
    expect(result.truncated).toBe(true);
    expect(result.hint).toMatch(/A modal dialog is open/);
    expect(result.hint).toMatch(/cut at the library's limit/);
  });

  it("list takes no path and no identifier", async () => {
    const { invoke, calls } = harness();
    const err = await errorOf(invoke({ action: "list", path: ["Edit"] }));
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.TOOL_INPUT_INVALID);
    expect(calls).toEqual([]);
  });

  it("choose sends the path and returns the path the app titles", async () => {
    const { invoke, calls } = harness();
    await expect(invoke({ action: "choose", path: ["tools", "Export..."] })).resolves.toEqual({
      chosen: ["Tools", "Export…"],
    });
    expect(calls).toEqual([{ method: "Menu.perform", params: { path: ["tools", "Export..."] } }]);
  });

  it("choose by identifier returns the identifier too", async () => {
    const { invoke, calls } = harness();
    await expect(invoke({ action: "choose", identifier: "tools.export" })).resolves.toEqual({
      chosen: ["Tools", "Export…"],
      identifier: "tools.export",
    });
    expect(calls).toEqual([{ method: "Menu.perform", params: { identifier: "tools.export" } }]);
  });

  it("choose needs exactly one of path and identifier", async () => {
    const { invoke, calls } = harness();
    for (const args of [{}, { path: ["Edit", "Copy"], identifier: "copy" }]) {
      const err = await errorOf(invoke({ action: "choose", ...args }));
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.TOOL_INPUT_INVALID);
      expect(err?.message).toMatch(/needs path .* or identifier, not both/);
    }
    expect(calls).toEqual([]);
  });
});
