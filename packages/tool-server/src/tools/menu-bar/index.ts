import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { InvalidToolInputError, assertSupported } from "../../utils/capability";
import { resolveDevice } from "../../utils/device-info";
import { MACOS_CLICK_SETTLE_MS, macosAppServices, requireMacosApp } from "../../utils/macos-input";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The menu bar and eight levels of submenus. */
const MAX_PATH_TITLES = 9;

/** One item of the app's menu bar: a command, or a menu with its items. */
interface MacosMenuItem {
  title: string;
  enabled?: boolean;
  state?: "on" | "mixed";
  /** The raw key equivalent (`a`, `A` for Shift-A, a function-key character). */
  keyEquivalent?: string;
  /** `function` is the Fn (globe) key, which `keyboard` cannot press. */
  modifiers?: string[];
  /** Shown in place of the item before it while Option is held. */
  alternate?: boolean;
  /** Only an identifier that no other item carries. */
  identifier?: string;
  submenu?: boolean;
  items?: MacosMenuItem[];
}

const zodSchema = z.object({
  udid: z.string().describe("Mac app id from `list-devices` (macos-app-<bundle id>)."),
  action: z
    .enum(["list", "choose"])
    .describe(
      "list: the app's menu bar, one line per item. choose: run one menu item, by path or identifier."
    ),
  path: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_PATH_TITLES)
    .optional()
    .describe(
      'For choose: the titles from the menu bar down to the item, as list shows them, e.g. ["File", "Export..."]. ' +
        'Case and "..." versus "…" do not matter.'
    ),
  identifier: z
    .string()
    .min(1)
    .optional()
    .describe('For choose: the item\'s id="..." from list, instead of path.'),
});

type Params = z.infer<typeof zodSchema>;

type Result =
  | { menuBar: string[]; items: number; truncated?: true; hint?: string }
  | { chosen: string[]; identifier?: string };

const capability: ToolCapability = {
  macos: { app: true },
};

const invalid = (message: string) =>
  new InvalidToolInputError(message, { failure_stage: "menu_bar_params" });

// Named keys of the `keyboard` tool, by the character AppKit stores for them.
const NAMED_KEYS: Record<number, string> = {
  0x03: "enter",
  0x0d: "enter",
  0x09: "tab",
  0x20: "space",
  0x08: "backspace",
  0x7f: "backspace",
  0x1b: "escape",
  0xf700: "arrow-up",
  0xf701: "arrow-down",
  0xf702: "arrow-left",
  0xf703: "arrow-right",
  0xf728: "delete",
  0xf729: "home",
  0xf72b: "end",
  0xf72c: "page-up",
  0xf72d: "page-down",
};
const F1 = 0xf704;
const F12 = 0xf70f;
const MODIFIER_ORDER = ["command", "shift", "option", "control", "function"] as const;
// The Fn (globe) key has no name in `keyboard`; the list names it as macOS does.
const MODIFIER_LABEL: Record<string, string> = { function: "fn" };

/**
 * A key equivalent in the `keyboard` tool's syntax (`command+shift+z`), so the
 * agent can press it too. A capital letter is Shift and the lower-case letter.
 */
function shortcut(key: string, modifiers: readonly string[] = []): string {
  const held = new Set(modifiers);
  const code = key.codePointAt(0) ?? 0;
  let name = key;
  if (/^[A-Z]$/.test(key)) {
    held.add("shift");
    name = key.toLowerCase();
  } else if (key.length === 1 && NAMED_KEYS[code]) {
    name = NAMED_KEYS[code];
  } else if (key.length === 1 && code >= F1 && code <= F12) {
    name = `f${code - F1 + 1}`;
  }
  const names = MODIFIER_ORDER.filter((m) => held.has(m)).map((m) => MODIFIER_LABEL[m] ?? m);
  return [...names, name].join("+");
}

/**
 * One line per item, two spaces of indent per level: the title (` >` for a
 * menu), its flags, its shortcut and its id.
 */
function renderMenus(items: readonly MacosMenuItem[], depth: number, lines: string[]): void {
  for (const item of items) {
    const parts = [`${"  ".repeat(depth)}${item.title}${item.submenu ? " >" : ""}`];
    const flags: string[] = [];
    if (item.enabled === false) flags.push("disabled");
    if (item.state === "on") flags.push("checked");
    if (item.state === "mixed") flags.push("mixed");
    if (item.alternate) flags.push("alternate");
    if (flags.length > 0) parts.push(`[${flags.join(", ")}]`);
    if (item.keyEquivalent) parts.push(shortcut(item.keyEquivalent, item.modifiers));
    if (item.identifier) parts.push(`id="${item.identifier}"`);
    lines.push(parts.join("  "));
    if (item.items) renderMenus(item.items, depth + 1, lines);
  }
}

export const menuBarTool: ToolDefinition<Params, Result> = {
  id: "menu-bar",
  featureFlag: "macos-apps",
  interaction: {
    startedMsg: ({ params }) =>
      params.action === "list"
        ? "Reading the menu bar"
        : `Choosing ${params.path?.join(" > ") ?? params.identifier} in the menu bar`,
    completedMsg: ({ params }) =>
      params.action === "list" ? "Read the menu bar" : "Chose the menu item",
    failedMsg: ({ params, failureSignal }) =>
      `Failed to ${params.action === "list" ? "read" : "choose from"} the menu bar: ${failureSignal.error_code}`,
  },
  description: `Read and choose the menu bar commands of a Mac app (File > Export..., Edit > Select All). The menu bar is outside the app window: describe does not show it, and gesture-tap cannot reach it.
Use when a command lives in the app's menus. Use keyboard instead for a shortcut you already know, and file-panel for the open or save panel that a command shows.
list returns { menuBar }, one line per item indented under its menu: the title (a menu ends with " >"), [disabled] or [checked], the shortcut in keyboard syntax, and id="..." when the item has one. choose takes path (the titles from the menu bar down, e.g. ["File", "Export..."]) or identifier, and returns { chosen } with the path; the command runs right after the reply.
Fails if no item matches (the error lists the titles at that level), if the item is disabled or is a menu, if a menu of the app is open, or if the device is not a Mac app.`,
  searchHint: "menu bar main menu command item file edit view window help choose mac app",
  zodSchema,
  capability,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    return device.platform === "macos" ? macosAppServices(device) : {};
  },
  async execute(services, params) {
    const device = resolveDevice(params.udid);
    // A flow step skips the HTTP capability gate.
    assertSupported("menu-bar", capability, device);
    const app = requireMacosApp(services, "menu-bar", device);
    if (params.action === "list") {
      if (params.path !== undefined || params.identifier !== undefined) {
        throw invalid("menu-bar list takes no path and no identifier.");
      }
      const bar = await app.call<{
        menus: MacosMenuItem[];
        count: number;
        truncated: boolean;
        modal?: boolean;
      }>("Menu.list");
      const lines: string[] = [];
      renderMenus(bar.menus, 0, lines);
      const hints: string[] = [];
      if (bar.modal) {
        hints.push(
          "A modal dialog is open: the app takes only the commands of that dialog, so the other items are disabled until it closes."
        );
      }
      if (bar.truncated) {
        hints.push(
          "The list was cut at the library's limit (2000 items or 8 levels of submenus), so some items are missing."
        );
      }
      return {
        menuBar: lines,
        items: bar.count,
        ...(bar.truncated ? { truncated: true as const } : {}),
        ...(hints.length > 0 ? { hint: hints.join(" ") } : {}),
      };
    }
    if ((params.path === undefined) === (params.identifier === undefined)) {
      throw invalid(
        'menu-bar choose needs path (the titles from the menu bar down, e.g. ["Edit", "Select All"]) or identifier, not both.'
      );
    }
    const chosen = await app.call<{ path: string[]; identifier?: string }>(
      "Menu.perform",
      params.path !== undefined ? { path: params.path } : { identifier: params.identifier }
    );
    // The command runs right after the reply; wait as after a click.
    await sleep(MACOS_CLICK_SETTLE_MS);
    return {
      chosen: chosen.path,
      ...(chosen.identifier !== undefined ? { identifier: chosen.identifier } : {}),
    };
  },
};
