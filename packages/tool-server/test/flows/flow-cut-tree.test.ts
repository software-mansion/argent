import { describe, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode } from "../../src/tools/describe/contract";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow, type FlowSelector } from "../../src/tools/flows/flow-utils";

// A tree the source cut at a size limit, through the REAL runner and the real
// Android and Chromium tree adapters: the only seams are the services. Each
// case runs on the same nodes with and without the cut, and the cut must never
// change the status: it adds a warning, or names the cut in a miss.

vi.mock("../../src/tools/flows/version-1/flow-tree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/flows/version-1/flow-tree")>();
  return { ...actual, fetchFlowTree: vi.fn(actual.fetchFlowTree) };
});
import { fetchFlowTree as fetchVersion1Tree } from "../../src/tools/flows/version-1/flow-tree";

const CUT = "The UI tree was cut at a size limit";
const absence = (sel: string) =>
  `${CUT}, and no element before the cut matched ${sel}. An element past the cut is not in ` +
  "the tree, so this result does not prove that the element is absent.";
const part = (sel: string, text: string) =>
  `${CUT}, and ${sel} matched only a part of the text "${text}". An exact match can be past ` +
  "the cut. Use the full text or the id.";
const container = (sel: string) =>
  `${CUT}, so the text of ${sel} holds only the elements before the cut.`;
const cutMiss = (missed: string) =>
  `${missed}: the UI tree was cut at a size limit, and an element past the cut is not in the ` +
  "tree. Reduce what the screen shows before this step (for example, close a long list or web page).";

type Step = Parameters<typeof serializeFlow>[0]["steps"][number];

interface Sim {
  registry: Registry;
  tools: string[];
}

function registryFor(service: unknown): Sim {
  const sim: Sim = { tools: [], registry: undefined as unknown as Registry };
  sim.registry = {
    resolveService: async () => service,
    invokeTool: async (id: string) => {
      if (id === "list-devices") return { devices: [] };
      if (id !== "screenshot") sim.tools.push(id);
      return { ok: true };
    },
    getTool: () => ({ inputSchema: { properties: { udid: {} } } }),
  } as unknown as Registry;
  return sim;
}

async function runYaml(sim: Sim, deviceId: string, yaml: string): Promise<FlowRunResult> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-cut-"));
  try {
    const dir = path.join(root, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "flow.yaml"), yaml, "utf8");
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

const run = (sim: Sim, deviceId: string, steps: Step[]) =>
  runYaml(sim, deviceId, serializeFlow({ executionPrerequisite: "", steps }));

// --- Android: the helper's dump, flagged `truncated` when it hit its limit ---

const APP = "com.example.app";
const button = (text: string, top: number, extra = "") =>
  `<node class="android.widget.Button" text="${text}" clickable="true" package="${APP}" ` +
  `bounds="[100,${top}][900,${top + 100}]"${extra} />`;
const textView = (text: string, top: number) =>
  `<node class="android.widget.TextView" text="${text}" package="${APP}" bounds="[100,${top}][900,${top + 60}]" />`;
const box = (children: string[]) =>
  `<node class="android.widget.LinearLayout" resource-id="${APP}:id/box" package="${APP}" bounds="[0,1300][1080,1500]">${children.join("")}</node>`;
const appWindow = (children: string[], bounds = "[0,0][1080,1920]") =>
  `<node class="android.widget.FrameLayout" package="${APP}" window-type="1" bounds="${bounds}">${children.join("")}</node>`;

function android(windows: string[], truncated: boolean): Sim {
  return registryFor({
    getHierarchy: async () => ({
      xml: `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${windows.join("")}</hierarchy>`,
      truncated,
    }),
    getScreenSize: async () => ({ width: 1080, height: 1920 }),
  });
}

const LOGIN_SCREEN = [
  appWindow([
    button("Log in with Google", 200),
    button("Dismiss", 400),
    box([textView("Alpha", 1310), textView("Beta", 1400)]),
  ]),
];

// --- Chromium: the DOM walk's payload, with its node and depth cut fields ---

const FULL = { x: 0, y: 0, width: 1, height: 1 };
function el(partial: Partial<DescribeNode>): DescribeNode {
  return { role: "div", frame: FULL, children: [], ...partial } as DescribeNode;
}
const row = (y: number) => ({ x: 0.1, y, width: 0.8, height: 0.05 });

/** The walk of a login page: `cutBox` says whether the cut came inside #box. */
function chromiumPage(cutBox: boolean): DescribeNode {
  return el({
    role: "html",
    cutInside: true,
    children: [
      el({ role: "button", clickable: true, label: "Log in with Google", frame: row(0.1) }),
      el({ role: "button", clickable: true, label: "Dismiss", frame: row(0.2) }),
      el({ role: "button", clickable: true, label: "Log in", frame: row(0.3) }),
      el({
        identifier: "box",
        frame: { x: 0, y: 0.5, width: 1, height: 0.2 },
        ...(cutBox ? { cutInside: true } : {}),
        children: [el({ value: "Alpha", frame: row(0.55) })],
      }),
      el({
        identifier: "own",
        label: "Total",
        frame: { x: 0, y: 0.75, width: 1, height: 0.1 },
        children: [el({ value: "42", frame: row(0.78) })],
      }),
    ],
  });
}

function chromium(tree: DescribeNode, cut: { truncated?: boolean; depthCut?: boolean }): Sim {
  return registryFor({
    refreshViewport: async () => ({ width: 1000, height: 1000 }),
    getViewport: () => ({ width: 1000, height: 1000 }),
    cdp: {
      send: async () => ({ result: { value: JSON.stringify({ tree, ...cut }) } }),
    },
  });
}

/** Runs `steps` on the cut and the uncut sim, and checks the statuses agree. */
async function both(
  make: (cut: boolean) => Sim,
  deviceId: (cut: boolean) => string,
  steps: Step[],
  expect: (typeof import("vitest"))["expect"]
): Promise<{ cut: FlowRunResult; whole: FlowRunResult; cutSim: Sim }> {
  const cutSim = make(true);
  const [cut, whole] = await Promise.all([
    run(cutSim, deviceId(true), steps),
    run(make(false), deviceId(false), steps),
  ]);
  expect(cut.steps.map((s) => s.status)).toEqual(whole.steps.map((s) => s.status));
  expect(cut.ok).toBe(whole.ok);
  for (const s of whole.steps) expect(s.warning).toBeUndefined();
  return { cut, whole, cutSim };
}

const tap = (selector: FlowSelector): Step => ({ kind: "tap", selector });

describe.concurrent("a step on a cut Android tree", () => {
  const sims = (screen: string[]) => (cut: boolean) => android(screen, cut);
  const serial = (n: number) => (cut: boolean) => `emulator-${5600 + n * 2 + (cut ? 0 : 1)}`;

  it("passes hidden with the absence warning", { timeout: 20_000 }, async ({ expect }) => {
    const { cut } = await both(
      sims(LOGIN_SCREEN),
      serial(0),
      [{ kind: "assert", condition: "hidden", selector: { text: "Payment failed" } }],
      expect
    );
    expect(cut.steps[0]).toMatchObject({
      status: "pass",
      warning: absence('text="Payment failed"'),
    });
  });

  it(
    "fails visible with the miss text, no scroll hint",
    { timeout: 20_000 },
    async ({ expect }) => {
      const { cut, whole } = await both(
        sims(LOGIN_SCREEN),
        serial(1),
        [{ kind: "assert", condition: "visible", selector: { text: "Payment failed" } }],
        expect
      );
      expect(cut.steps[0].reason).toBe(
        cutMiss('no element matched selector text="Payment failed"')
      );
      expect(cut.steps[0].warning).toBeUndefined();
      expect(whole.steps[0].reason).toBe('no element matched selector text="Payment failed"');
    }
  );

  it("taps a part match with the part warning", { timeout: 20_000 }, async ({ expect }) => {
    const { cut, cutSim } = await both(
      sims(LOGIN_SCREEN),
      serial(2),
      [tap({ text: "Log in" })],
      expect
    );
    expect(cut.steps[0]).toMatchObject({
      status: "pass",
      warning: part('text="Log in"', "Log in with Google"),
    });
    expect(cutSim.tools).toEqual(["gesture-tap"]);
  });

  it("taps an exact match with no warning", { timeout: 20_000 }, async ({ expect }) => {
    const { cut } = await both(sims(LOGIN_SCREEN), serial(3), [tap({ text: "Dismiss" })], expect);
    expect(cut.steps[0]).toMatchObject({ status: "pass" });
    expect(cut.steps[0].warning).toBeUndefined();
  });

  it("fails a tap miss with the miss text", { timeout: 20_000 }, async ({ expect }) => {
    const { cut, whole } = await both(
      sims(LOGIN_SCREEN),
      serial(4),
      [tap({ text: "Checkout" })],
      expect
    );
    expect(cut.steps[0].reason).toBe(
      cutMiss('no visible element matched selector text="Checkout"')
    );
    expect(whole.steps[0].reason).toBe(
      'no visible element matched selector text="Checkout" — if it is off-screen, add a scroll-to step before this one'
    );
  });

  it(
    "skips a when: guard with no match, warns on its marker, and runs on",
    { timeout: 20_000 },
    async ({ expect }) => {
      const { cut } = await both(
        sims(LOGIN_SCREEN),
        serial(5),
        [
          {
            kind: "when",
            condition: {
              kind: "selector",
              condition: "visible",
              selector: { text: "Payment failed" },
            },
            steps: [tap({ text: "Dismiss" })],
          } as unknown as Step,
          { kind: "assert", condition: "visible", selector: { text: "Log in with Google" } },
        ],
        expect
      );
      expect(cut.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
        "when:skip",
        "tap:skip",
        "assert:pass",
      ]);
      expect(cut.steps[0].warning).toBe(absence('text="Payment failed"'));
      expect(cut.ok).toBe(true);
    }
  );

  it(
    "gives a container text check the container warning",
    { timeout: 20_000 },
    async ({ expect }) => {
      const { cut } = await both(
        sims(LOGIN_SCREEN),
        serial(6),
        [
          {
            kind: "assert",
            condition: "text",
            selector: { identifier: "box" },
            expectedText: "Alpha Beta",
            textMatch: "equals",
          },
          {
            kind: "assert",
            condition: "text",
            selector: { identifier: "box" },
            expectedText: "Alpha",
          },
        ],
        expect
      );
      expect(cut.steps.map((s) => s.status)).toEqual(["pass", "pass"]);
      expect(cut.steps[0].warning).toBe(container('id="box"'));
      // A passing `contains` holds whatever the cut left out.
      expect(cut.steps[1].warning).toBeUndefined();
    }
  );

  it(
    "names the dialog, not the cut, for a target under it",
    { timeout: 20_000 },
    async ({ expect }) => {
      // Android leaves the app's window out of the tree while its dialog is on top.
      const screen = [appWindow([button("OK", 1100)], "[28,986][1052,1478]")];
      const { cut } = await both(sims(screen), serial(7), [tap({ text: "Model" })], expect);
      expect(cut.steps[0].reason).toBe(
        'no visible element matched selector text="Model": a dialog is on top of the app, and ' +
          "Android leaves the elements below it out of the tree. Dismiss it first, or add an " +
          "await step for it to close."
      );
    }
  );

  it(
    "ends a scroll-to on a cut tree with the end sentence",
    { timeout: 30_000 },
    async ({ expect }) => {
      const { cut, whole } = await both(
        sims(LOGIN_SCREEN),
        serial(8),
        [{ kind: "scroll-to", target: { text: "Checkout" }, direction: "down" }],
        expect
      );
      const end = 'reached the end of the scroll without finding text="Checkout"';
      expect(whole.steps[0].reason).toBe(end);
      expect(cut.steps[0].reason).toBe(
        `${end}. The UI tree was cut at a size limit, so the end of the scroll is not certain.`
      );
    }
  );
});

describe.concurrent("a step on a cut Chromium tree", () => {
  const port = (n: number) => (cut: boolean) => `chromium-cdp-${9400 + n * 2 + (cut ? 0 : 1)}`;
  const sims =
    (cutBox = true, kind: "truncated" | "depthCut" = "truncated") =>
    (cut: boolean) =>
      chromium(chromiumPage(cutBox), cut ? { [kind]: true } : {});

  it(
    "passes hidden with the absence warning, also on a depth cut",
    { timeout: 20_000 },
    async ({ expect }) => {
      for (const [n, kind] of [
        [0, "truncated"],
        [1, "depthCut"],
      ] as const) {
        const { cut } = await both(
          sims(true, kind),
          port(n),
          [{ kind: "assert", condition: "hidden", selector: { text: "Payment failed" } }],
          expect
        );
        expect(cut.steps[0]).toMatchObject({
          status: "pass",
          warning: absence('text="Payment failed"'),
        });
      }
    }
  );

  it(
    "warns a part match, also one scored exact by its role",
    { timeout: 20_000 },
    async ({ expect }) => {
      const page = chromiumPage(true);
      // No exact "Log in" before the cut.
      page.children.splice(2, 1);
      const make = (cut: boolean) => chromium(page, cut ? { truncated: true } : {});
      const { cut } = await both(
        make,
        port(2),
        [tap({ text: "Log in" }), tap({ text: "Log in", role: "button" })],
        expect
      );
      expect(cut.steps.map((s) => s.warning)).toEqual([
        part('text="Log in"', "Log in with Google"),
        part('text="Log in" role="button"', "Log in with Google"),
      ]);
    }
  );

  it(
    "gives an exact match and a role-only tap no warning",
    { timeout: 20_000 },
    async ({ expect }) => {
      const { cut } = await both(
        sims(),
        port(3),
        [tap({ text: "Log in" }), tap({ role: "button" }), tap({ text: "Log in", loose: true })],
        expect
      );
      expect(cut.steps.map((s) => `${s.status}:${s.warning ?? ""}`)).toEqual([
        "pass:",
        "pass:",
        "pass:",
      ]);
    }
  );

  it("warns only a container the walk marked as cut", { timeout: 20_000 }, async ({ expect }) => {
    const equalsAlpha: Step = {
      kind: "assert",
      condition: "text",
      selector: { identifier: "box" },
      expectedText: "Alpha",
      textMatch: "equals",
    };
    const ownText: Step = {
      kind: "assert",
      condition: "text",
      selector: { identifier: "own" },
      expectedText: "Total",
      textMatch: "equals",
    };
    const marked = await both(sims(true), port(4), [equalsAlpha, ownText], expect);
    expect(marked.cut.steps.map((s) => s.status)).toEqual(["pass", "pass"]);
    expect(marked.cut.steps[0].warning).toBe(container('id="box"'));
    // Passes on the element's own text, which the cut cannot shorten.
    expect(marked.cut.steps[1].warning).toBeUndefined();

    const unmarked = await both(sims(false), port(5), [equalsAlpha], expect);
    expect(unmarked.cut.steps[0].warning).toBeUndefined();
  });

  it(
    "gives a failing contains on a cut container the container warning",
    { timeout: 20_000 },
    async ({ expect }) => {
      const { cut } = await both(
        sims(true),
        port(6),
        [
          {
            kind: "assert",
            condition: "text",
            selector: { identifier: "box" },
            expectedText: "Omega",
          },
        ],
        expect
      );
      expect(cut.steps[0]).toMatchObject({ status: "fail", warning: container('id="box"') });
    }
  );

  it("fails a tap miss with the miss text", { timeout: 20_000 }, async ({ expect }) => {
    const { cut } = await both(sims(), port(7), [tap({ text: "Checkout" })], expect);
    expect(cut.steps[0].reason).toBe(
      cutMiss('no visible element matched selector text="Checkout"')
    );
  });
});

describe("a version 1 e2e test on an iOS simulator", () => {
  it(
    "passes hidden on a cut tree as before, with no warning",
    { timeout: 20_000 },
    async ({ expect }) => {
      vi.mocked(fetchVersion1Tree).mockResolvedValue({
        tree: {
          role: "Screen",
          frame: FULL,
          children: [el({ role: "AXButton", label: "Log in with Google", frame: row(0.1) })],
        },
        source: "native-devtools",
        truncated: true,
      });
      const result = await runYaml(
        registryFor({}),
        "00000000-0000-0000-0000-0000000000c1",
        "steps:\n  - assert: { hidden: { text: Payment failed } }\n"
      );
      expect(vi.mocked(fetchVersion1Tree)).toHaveBeenCalled();
      expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["assert:pass"]);
      expect(result.steps[0].warning).toBeUndefined();
    }
  );
});
