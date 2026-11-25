import { describe, vi, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { AXTreeNode, AXTreeResponse } from "../../src/blueprints/ax-service";
import { readIosSimulatorUiTree } from "../../src/tools/flows/flow-ios-tree";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow, type FlowSelector } from "../../src/tools/flows/flow-utils";

// The reason a step reports when its target is under an alert, a sheet or a
// dialog, through the REAL runner and the real tree adapters. The only seams
// are the services, and a pass-through spy on the id path's extra read, so a
// test can count it: the flow's own reads call the reader inside its module.
vi.mock("../../src/tools/flows/flow-ios-tree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/flows/flow-ios-tree")>();
  return { ...actual, readIosSimulatorUiTree: vi.fn(actual.readIosSimulatorUiTree) };
});
vi.setConfig({ clearMocks: false });

const APP = "com.example.app";
const DLG = "com.argent.dlglist";
const IN_APP =
  "it is covered by an alert, sheet or popover. Dismiss it first, or add an await step for it to close.";
const SYSTEM =
  "a system alert covers it. Add a step before this one that taps a button of the alert, such as " +
  "`tap: { text: Allow }`, or grant the permission before the e2e test with the " +
  "`settings-permissions` tool.";
const plain = (sel: string) =>
  `no visible element matched selector ${sel} — if it is off-screen, add a scroll-to step before this one`;

const frame = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

/**
 * An app with a grid (id `grid`) of one button `u11` (id `u-1-1`) and one
 * off the screen, `u99`. With `cover: "app"` an in-app alert covers the grid;
 * with `cover: "system"` a system alert covers the whole app.
 */
function axTree(cover: "app" | "system"): AXTreeResponse {
  const app: AXTreeNode[] = [
    { index: 10, label: APP, bundleId: APP, ...(cover === "system" ? { covered: true } : {}) },
    {
      index: 11,
      parentIndex: 10,
      identifier: "grid",
      frame: frame(0, 0.3, 1, 0.5),
      ...(cover === "app" ? { covered: true } : {}),
    },
    {
      index: 12,
      parentIndex: 11,
      identifier: "u-1-1",
      label: "u11",
      traits: ["button"],
      frame: frame(0.1, 0.3, 0.2, 0.05),
    },
    {
      index: 13,
      parentIndex: 11,
      identifier: "u-9-9",
      label: "u99",
      traits: ["button"],
      frame: frame(0.1, 1.4, 0.2, 0.05),
    },
  ];
  if (cover === "app") {
    app.push({
      index: 14,
      parentIndex: 10,
      label: "In-app alert",
      traits: ["staticText"],
      frame: frame(0.1, 0.4, 0.8, 0.05),
    });
  }
  const system: AXTreeNode[] =
    cover === "system"
      ? [
          { index: 0, label: "SpringBoard", bundleId: "com.apple.springboard" },
          {
            index: 1,
            parentIndex: 0,
            label: "Allow",
            traits: ["button"],
            frame: frame(0.2, 0.5, 0.6, 0.05),
          },
        ]
      : [];
  return {
    alertVisible: cover === "system",
    screenFrame: { width: 402, height: 874 },
    nodes: [...system, ...app],
    truncated: false,
    foregroundApp: APP,
    interfaceOrientation: "portrait",
    treeVersion: 3,
  };
}

/** Window roots, topmost first, as the helper dumps them. */
function androidXml(
  windows: string[],
  captureMode?: string
): { xml: string; captureMode?: string } {
  return {
    xml: `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
${windows.join("\n")}
</hierarchy>`,
    ...(captureMode ? { captureMode } : {}),
  };
}

const STATUS_BAR = `<node class="android.widget.FrameLayout" package="com.android.systemui" window-type="3" bounds="[0,0][1080,80]" />`;
const IME = `<node class="android.widget.FrameLayout" package="com.google.android.inputmethod.latin" window-type="2" bounds="[0,1200][1080,1920]"><node class="android.widget.Button" text="q" package="com.google.android.inputmethod.latin" bounds="[0,1200][100,1300]" /></node>`;
const appWindow = (pkg: string, bounds: string, text: string) =>
  `<node class="android.widget.FrameLayout" package="${pkg}" window-type="1" bounds="${bounds}"><node class="android.widget.Button" text="${text}" clickable="true" package="${pkg}" bounds="[100,1000][500,1100]" /></node>`;

interface Sim {
  registry: Registry;
  tools: string[];
}

function device(opts: {
  ax?: AXTreeResponse;
  android?: { xml: string; captureMode?: string };
  /** The Android screen in pixels; 1080x1920 when absent. */
  screen?: { width: number; height: number };
  /** Called on each tool the run dispatches, e.g. to close a dialog on a tap. */
  onTool?: (id: string) => void;
}): Sim {
  const sim: Sim = { tools: [], registry: undefined as unknown as Registry };
  const ax = { degraded: false, tree: async () => opts.ax };
  const android = {
    getHierarchy: async () => opts.android,
    getScreenSize: async () => opts.screen ?? { width: 1080, height: 1920 },
  };
  sim.registry = {
    resolveService: async (urn: string) => (urn.startsWith("AndroidDevtools") ? android : ax),
    invokeTool: async (id: string) => {
      if (id === "list-devices") return { devices: [] };
      opts.onTool?.(id);
      if (id !== "screenshot") sim.tools.push(id);
      return { ok: true };
    },
    getTool: () => ({ inputSchema: { properties: { udid: {} } } }),
  } as unknown as Registry;
  return sim;
}

type Step = Parameters<typeof serializeFlow>[0]["steps"][number];

async function run(sim: Sim, deviceId: string, steps: Step[]): Promise<FlowRunResult> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-covered-"));
  try {
    const dir = path.join(root, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "flow.yaml"),
      serializeFlow({ executionPrerequisite: "", steps }),
      "utf8"
    );
    const r = await createRunFlowTool(sim.registry).execute(
      {},
      { name: "flow", project_root: root, device: deviceId },
      {} as never
    );
    if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
    return r;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** The reason of a one-step flow that must fail; no touch may be dispatched. */
async function reasonOf(sim: Sim, deviceId: string, step: Step): Promise<string> {
  const result = await run(sim, deviceId, [step]);
  const dispatched = sim.tools.filter((t) => t !== "gesture-swipe");
  if (result.steps[0]?.status !== "fail" || dispatched.length > 0) {
    throw new Error(`expected the step to fail: ${JSON.stringify([result.steps, sim.tools])}`);
  }
  return result.steps[0].reason ?? "";
}

function extraReads(sim: Sim): number {
  return vi.mocked(readIosSimulatorUiTree).mock.calls.filter(([r]) => r === sim.registry).length;
}

const tap = (selector: FlowSelector): Step => ({ kind: "tap", selector });
const U11 = { text: "u11" };
const MISSED = 'no visible element matched selector text="u11"';

// Each case waits out the full auto-wait, so they run side by side; each owns
// its registry and device id.
describe.concurrent("a miss on a target an in-app alert, sheet or popover covers", () => {
  it.for<[string, string, FlowSelector, string]>([
    ["text", "d1", U11, 'text="u11"'],
    ["bare string", "d2", { text: "u11", loose: true }, 'text="u11"'],
    ["role", "d3", { role: "AXButton", text: "u11" }, 'text="u11" role="AXButton"'],
    [
      "within",
      "d4",
      { text: "u11", within: { identifier: "grid" } },
      'text="u11" within (id="grid")',
    ],
  ])(
    "names the cover for a %s selector, with no extra read",
    { timeout: 20_000 },
    async ([, suffix, selector, described], { expect }) => {
      const sim = device({ ax: axTree("app") });
      const reason = await reasonOf(
        sim,
        `00000000-0000-0000-0000-0000000000${suffix}`,
        tap(selector)
      );

      expect(reason).toBe(`no visible element matched selector ${described}: ${IN_APP}`);
      expect(extraReads(sim)).toBe(0);
    }
  );

  it("does not name the cover for a target scoped within the cover", async ({ expect }) => {
    const ax = axTree("app");
    // A covered button under the alert's title.
    ax.nodes.push({
      index: 15,
      parentIndex: 11,
      label: "u21",
      traits: ["button"],
      frame: frame(0.1, 0.41, 0.2, 0.03),
    });
    const scoped = await reasonOf(
      device({ ax }),
      "00000000-0000-0000-0000-0000000000d5",
      tap({ text: "u21", within: { text: "In-app alert" } })
    );
    const plainTap = await reasonOf(
      device({ ax }),
      "00000000-0000-0000-0000-0000000000d6",
      tap({ text: "u21" })
    );

    expect(scoped).toBe(plain('text="u21" within (text="In-app alert")'));
    expect(plainTap).toBe(`no visible element matched selector text="u21": ${IN_APP}`);
  }, 30_000);

  it.for<[string, string, Step, string]>([
    ["assert visible", "e1", { kind: "assert", condition: "visible", selector: U11 }, MISSED],
    ["await", "e2", { kind: "await", condition: "visible", selector: U11, timeout: 500 }, MISSED],
    [
      "scroll-to",
      "e3",
      { kind: "scroll-to", target: U11, direction: "down" },
      'reached the end of the scroll without finding text="u11"',
    ],
  ])(
    "names the cover on a %s step",
    { timeout: 30_000 },
    async ([, suffix, step, missed], { expect }) => {
      const sim = device({ ax: axTree("app") });
      const reason = await reasonOf(sim, `00000000-0000-0000-0000-0000000000${suffix}`, step);

      expect(reason).toBe(`${missed}: ${IN_APP}`);
      expect(extraReads(sim)).toBe(0);
    }
  );

  it("keeps the scroll hint for a covered element off the screen", async ({ expect }) => {
    const sim = device({ ax: axTree("app") });
    const reason = await reasonOf(
      sim,
      "00000000-0000-0000-0000-0000000000e4",
      tap({ text: "u99" })
    );

    expect(reason).toBe(plain('text="u99"'));
  }, 20_000);

  it("keeps the scroll hint for a text that is nowhere", async ({ expect }) => {
    const sim = device({ ax: axTree("app") });
    const reason = await reasonOf(sim, "00000000-0000-0000-0000-0000000000e5", tap({ text: "zz" }));

    expect(reason).toBe(plain('text="zz"'));
  }, 20_000);

  it("names the cover for an id selector, with no extra read", async ({ expect }) => {
    const sim = device({ ax: axTree("app") });
    const reason = await reasonOf(
      sim,
      "00000000-0000-0000-0000-0000000000e6",
      tap({ identifier: "u-1-1" })
    );

    expect(reason).toBe(`no visible element matched selector id="u-1-1": ${IN_APP}`);
    expect(extraReads(sim)).toBe(0);
  }, 20_000);

  // Only the extra read sees an id that is off the screen, or nowhere.
  it.for<[string, string, string, string]>([
    [
      "a covered id off the screen",
      "e8",
      "u-9-9",
      "the element with this id is covered by an alert, sheet or popover. Dismiss it first",
    ],
    [
      "an id that is nowhere",
      "e9",
      "nowhere",
      "no element with this id is in the accessibility tree",
    ],
  ])(
    "keeps the id path's own text and its one extra read for %s",
    { timeout: 20_000 },
    async ([, suffix, id, text], { expect }) => {
      const sim = device({ ax: axTree("app") });
      const reason = await reasonOf(
        sim,
        `00000000-0000-0000-0000-0000000000${suffix}`,
        tap({ identifier: id })
      );

      expect(reason).toContain(`no visible element matched selector id="${id}"`);
      expect(reason).toContain(text);
      expect(extraReads(sim)).toBe(1);
    }
  );

  it("gives no text and no read to an unmet when guard", async ({ expect }) => {
    const sim = device({ ax: axTree("app") });
    const result = await run(sim, "00000000-0000-0000-0000-0000000000e7", [
      {
        kind: "when",
        condition: { kind: "ui", condition: "visible", selector: U11 },
        steps: [{ kind: "echo", message: "never" }],
      },
    ]);

    expect(result.steps.map((st) => st.status)).not.toContain("fail");
    expect(extraReads(sim)).toBe(0);
  }, 20_000);
});

describe.concurrent("a miss on the app below a system alert", () => {
  it("names the system alert for a text selector", async ({ expect }) => {
    const sim = device({ ax: axTree("system") });
    const reason = await reasonOf(sim, "00000000-0000-0000-0000-0000000000f1", tap(U11));

    expect(reason).toBe(`${MISSED}: ${SYSTEM}`);
    expect(extraReads(sim)).toBe(0);
  }, 20_000);

  it("names the system alert for an id selector", async ({ expect }) => {
    const sim = device({ ax: axTree("system") });
    const reason = await reasonOf(
      sim,
      "00000000-0000-0000-0000-0000000000f2",
      tap({ identifier: "u-1-1" })
    );

    expect(reason).toBe(`no visible element matched selector id="u-1-1": ${SYSTEM}`);
    expect(extraReads(sim)).toBe(0);
  }, 20_000);
});

describe.concurrent("an Android miss while a window is on top of the app", () => {
  const FULL = "[0,0][1080,1920]";

  const DIALOG =
    'no visible element matched selector text="Model": a dialog is on top of the app, and ' +
    "Android leaves the elements below it out of the tree. Dismiss it first, or add an await " +
    "step for it to close.";

  it.for<[string, string, string[]]>([
    // Settings, About, "Device name" on an API 35 emulator, under the keyboard.
    ["a dialog", "5551", [STATUS_BAR, IME, appWindow(APP, "[28,986][1052,1478]", "OK")]],
    [
      "a full-width bottom sheet",
      "5552",
      [STATUS_BAR, appWindow(APP, "[0,1200][1080,1920]", "OK")],
    ],
    [
      "a dialog below a window root with no package",
      "5553",
      [
        `<node class="android.widget.FrameLayout" window-type="1" bounds="${FULL}" />`,
        appWindow(APP, "[28,986][1052,1478]", "OK"),
      ],
    ],
  ])("names %s of the app", { timeout: 20_000 }, async ([, serial, windows], { expect }) => {
    const sim = device({ android: androidXml(windows) });
    const reason = await reasonOf(sim, `emulator-${serial}`, tap({ text: "Model" }));

    expect(reason).toBe(DIALOG);
  });

  it("drops the dialog text once a later read finds no dialog", async ({ expect }) => {
    const dump = { current: androidXml([STATUS_BAR, appWindow(APP, "[28,986][1052,1478]", "OK")]) };
    const sim = device({
      // Tapping OK closes the dialog: the app's own screen comes back.
      onTool: (id) => {
        if (id === "gesture-tap")
          dump.current = androidXml([STATUS_BAR, appWindow(APP, FULL, "Home")]);
      },
    });
    (sim.registry as unknown as { resolveService: unknown }).resolveService = async () => ({
      getHierarchy: async () => dump.current,
      getScreenSize: async () => ({ width: 1080, height: 1920 }),
    });
    const result = await run(sim, "emulator-5554", [tap({ text: "OK" }), tap({ text: "Model" })]);

    expect(result.steps.map((st) => st.status)).toEqual(["pass", "fail"]);
    expect(result.steps[1]?.reason).toBe(plain('text="Model"'));
  }, 20_000);

  it.for<[string, string, string, string]>([
    [
      "a permission prompt",
      "com.google.android.permissioncontroller",
      "[28,817][1052,1648]",
      ", or grant the permission before the e2e test with the `settings-permissions` tool.",
    ],
    // A share sheet asks for no permission.
    ["the share sheet", "android", FULL, "."],
  ])(
    "names %s as a system dialog",
    { timeout: 20_000 },
    async ([, pkg, bounds, remedy], { expect }) => {
      const sim = device({ android: androidXml([STATUS_BAR, appWindow(pkg, bounds, "Allow")]) });
      const reason = await reasonOf(sim, `emulator-${pkg.length}`, tap({ text: "Organize" }));

      expect(reason).toBe(
        `no visible element matched selector text="Organize": a system dialog or sheet of ${pkg} ` +
          "is on top of the app, and Android leaves the elements below it out of the tree. Add a " +
          `step before this one that taps a button of it${remedy}`
      );
    }
  );

  describe("on a 1080x2400 API 35 emulator", () => {
    const SCREEN = { width: 1080, height: 2400 };
    const BAR = `<node class="android.widget.FrameLayout" package="com.android.systemui" window-type="3" bounds="[0,0][1080,136]" />`;
    // A window of `pkg` holding a list that scrolls, with its first rows.
    const listWindow = (pkg: string, bounds: string, list: string, rows: string[]) =>
      `<node class="android.widget.FrameLayout" package="${pkg}" window-type="1" bounds="${bounds}">` +
      `<node class="android.widget.ListView" scrollable="true" package="${pkg}" bounds="${list}">` +
      rows
        .map(
          (r, i) =>
            `<node class="android.widget.TextView" text="${r}" clickable="true" package="${pkg}" ` +
            `bounds="[70,${560 + i * 126}][1010,${686 + i * 126}]" />`
        )
        .join("") +
      "</node></node>";
    // A centred dialog whose 560dp list of 30 colors scrolls (a test app).
    const COLORS = listWindow(DLG, "[28,400][1052,2072]", "[70,560][1010,2030]", [
      "Color 1",
      "Color 2",
    ]);
    const IN_DIALOG =
      "a dialog is on top of the app, and Android leaves the elements below it out of the tree. " +
      "If the element is in the dialog,";
    const ELSE = "Else dismiss the dialog first, or add an await step for it to close.";

    it("gives the scroll remedy with the dialog text for a dialog whose list scrolls", async ({
      expect,
    }) => {
      const sim = device({ android: androidXml([BAR, COLORS]), screen: SCREEN });
      const reason = await reasonOf(sim, "emulator-5571", tap({ text: "Color 25" }));

      expect(reason).toBe(
        `no visible element matched selector text="Color 25": ${IN_DIALOG} add a scroll-to ` +
          `step before this one. ${ELSE}`
      );
    }, 20_000);

    it("names within: on a scroll-to step in a dialog whose list scrolls", async ({ expect }) => {
      const sim = device({ android: androidXml([BAR, COLORS]), screen: SCREEN });
      const reason = await reasonOf(sim, "emulator-5572", {
        kind: "scroll-to",
        target: { text: "Color 25" },
        direction: "down",
      });

      expect(reason).toBe(
        `reached the end of the scroll without finding text="Color 25": ${IN_DIALOG} add ` +
          `within: with the dialog's scroll container to this step. ${ELSE}`
      );
    }, 30_000);

    it("gives the dialog text alone to a scroll-to step that names its within:", async ({
      expect,
    }) => {
      const sim = device({ android: androidXml([BAR, COLORS]), screen: SCREEN });
      const reason = await reasonOf(sim, "emulator-5579", {
        kind: "scroll-to",
        target: { text: "Color 25" },
        direction: "down",
        within: { role: "ScrollView" },
      });

      expect(reason).toBe(
        'reached the end of the scroll without finding text="Color 25": a dialog is on top of ' +
          "the app, and Android leaves the elements below it out of the tree. Dismiss it first, " +
          "or add an await step for it to close."
      );
    }, 30_000);

    it("gives no scroll remedy for a scroller hidden from the user", async ({ expect }) => {
      const hidden = COLORS.replace(
        'scrollable="true"',
        'scrollable="true" visible-to-user="false"'
      );
      const sim = device({ android: androidXml([BAR, hidden]), screen: SCREEN });
      const reason = await reasonOf(sim, "emulator-5580", tap({ text: "Model" }));

      expect(reason).toBe(DIALOG);
    }, 20_000);

    // A landscape-only app the system letterboxes on a portrait screen.
    it("keeps the scroll hint for a letterboxed app", async ({ expect }) => {
      const app = listWindow(DLG, "[0,795][1080,1605]", "[0,795][1080,1605]", ["Land row 1"]);
      const sim = device({ android: androidXml([BAR, app]), screen: SCREEN });
      const reason = await reasonOf(sim, "emulator-5581", tap({ text: "Nowhere" }));

      expect(reason).toBe(plain('text="Nowhere"'));
    }, 20_000);

    it("gives no scroll remedy for a dialog whose ScrollViews do not scroll", async ({
      expect,
    }) => {
      // Settings, About, "Device name": the title and the field sit in ScrollViews.
      const scrollView = (bounds: string) =>
        `<node class="android.widget.ScrollView" scrollable="false" package="com.android.settings" bounds="${bounds}" />`;
      const sim = device({
        android: androidXml([
          BAR,
          `<node class="android.widget.FrameLayout" package="com.android.settings" window-type="1" bounds="[28,990][1052,1482]">` +
            scrollView("[70,1150][1010,1276]") +
            scrollView("[70,1276][1010,1440]") +
            "</node>",
        ]),
        screen: SCREEN,
      });
      const reason = await reasonOf(sim, "emulator-5578", tap({ text: "Model" }));

      expect(reason).toBe(DIALOG);
    }, 20_000);

    it("gives no scroll remedy for a scroller of the dialog off the screen", async ({ expect }) => {
      const sim = device({
        android: androidXml([
          BAR,
          listWindow(DLG, "[28,400][1052,2072]", "[70,2400][1010,2900]", ["Color 1"]),
        ]),
        screen: SCREEN,
      });
      const reason = await reasonOf(sim, "emulator-5573", tap({ text: "Model" }));

      expect(reason).toBe(DIALOG);
    }, 20_000);

    // The share sheet: `scroll-to` swipes at the centre of the screen, above the
    // sheet, and closes it, so the system text stays as it is.
    it("gives a system sheet whose list scrolls the system text alone", async ({ expect }) => {
      const sheet = listWindow("android", "[0,0][1080,2400]", "[0,0][1080,2400]", ["Copy"]);
      const sim = device({ android: androidXml([BAR, sheet]), screen: SCREEN });
      const reason = await reasonOf(sim, "emulator-5574", tap({ text: "Quick Share" }));

      expect(reason).toBe(
        'no visible element matched selector text="Quick Share": a system dialog or sheet of ' +
          "android is on top of the app, and Android leaves the elements below it out of the " +
          "tree. Add a step before this one that taps a button of it."
      );
    }, 20_000);

    const DIVIDER = `<node class="android.widget.FrameLayout" package="com.android.systemui" window-type="5" bounds="[0,1131][1080,1257]" />`;
    const SETTINGS = listWindow(
      "com.android.settings",
      "[0,1207][1080,2400]",
      "[0,1400][1080,2400]",
      ["Network"]
    );
    it.for<[string, string, string[]]>([
      // Contacts on top, Settings (focused) below it.
      [
        "a split screen",
        "5575",
        [
          BAR,
          DIVIDER,
          SETTINGS,
          appWindow("com.google.android.contacts", "[0,0][1080,1181]", "Add"),
        ],
      ],
      // The first read of a split: the other app's window is not listed yet.
      ["a split screen as it starts", "5576", [BAR, DIVIDER, SETTINGS]],
      [
        "a freeform window",
        "5577",
        [
          BAR,
          listWindow("com.android.settings", "[276,696][853,1776]", "[276,800][853,1776]", [
            "Network",
          ]),
          appWindow("com.google.android.contacts", "[0,0][1080,2400]", "Add"),
        ],
      ],
    ])(
      "keeps the scroll hint in %s",
      { timeout: 20_000 },
      async ([, serial, windows], { expect }) => {
        const sim = device({ android: androidXml(windows), screen: SCREEN });
        const reason = await reasonOf(sim, `emulator-${serial}`, tap({ text: "Nowhere" }));

        expect(reason).toBe(plain('text="Nowhere"'));
      }
    );
  });

  it.for<[string, string, { xml: string; captureMode?: string }]>([
    ["a full-screen app window", "5561", androidXml([STATUS_BAR, appWindow(APP, FULL, "Home")])],
    // A landscape app inset by the display cutout (the Dialer on an API 35 emulator).
    [
      "an app window inset on one side",
      "5564",
      androidXml([STATUS_BAR, appWindow(APP, "[136,0][1080,1920]", "Home")]),
    ],
    // Inset by a cutout on one side and a navigation bar on the other.
    [
      "an app window inset on both sides",
      "5565",
      androidXml([STATUS_BAR, appWindow(APP, "[136,0][960,1920]", "Home")]),
    ],
    [
      "a dump with no window list",
      "5562",
      androidXml([appWindow(APP, "[28,986][1052,1478]", "OK")], "active-window"),
    ],
    [
      "a dump without window types",
      "5563",
      androidXml([
        `<node class="android.widget.FrameLayout" package="${APP}" bounds="[28,986][1052,1478]" />`,
      ]),
    ],
  ])(
    "keeps the scroll hint under %s",
    { timeout: 20_000 },
    async ([, serial, dump], { expect }) => {
      const sim = device({ android: dump });
      const reason = await reasonOf(sim, `emulator-${serial}`, tap({ text: "Model" }));

      expect(reason).toBe(plain('text="Model"'));
    }
  );
});
