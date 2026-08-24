/**
 * What a failing step SAW — the evidence the runner used to throw away.
 *
 * The reads are scripted per-poll (the same mechanism as
 * flow-hidden-blank-reads.test.ts) so each of `waitForCondition`'s three
 * evidence tiers, `waitForFrame`'s sink and `settleTree`'s sustained-outage
 * throw can be driven deliberately, and the tree the report ends up showing can
 * be checked against the read it is supposed to have come from.
 *
 * The load-bearing rule, and the most likely silent regression in the whole
 * feature: a step that failed BECAUSE the tree source was down must never
 * render a healthy screen just because a later read succeeds. The operator
 * would conclude the environment was fine and go edit a correct flow.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, FailureError, type Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

let currentFetch: () => DescribeTreeData | Promise<DescribeTreeData>;
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => currentFetch()),
}));

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";
import type { FlowFailureScreen, FlowStepFailure } from "../../src/tools/flows/flow-failure";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
let tmpDir: string;

function n(partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }): DescribeNode {
  return { role: "AXOther", children: [], ...partial };
}

function screen(children: DescribeNode[]): DescribeNode {
  return n({ role: "AXWindow", frame: { x: 0, y: 0, width: 1, height: 1 }, children });
}

function label(text: string, extra: Partial<DescribeNode> = {}): DescribeNode {
  return n({
    role: "AXStaticText",
    label: text,
    frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.05 },
    ...extra,
  });
}

function mockRegistry(onInvoke?: (id: string, args: Record<string, unknown>) => unknown): Registry {
  return {
    invokeTool: vi.fn(async (id: string, args: Record<string, unknown> = {}) => {
      if (id === "list-devices") return { devices: [] };
      const scripted = onInvoke?.(id, args);
      return scripted === undefined ? { ok: true } : scripted;
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
}

async function writeFlow(name: string, flow: Parameters<typeof serializeFlow>[0]): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), serializeFlow(flow), "utf8");
}

async function run(name: string, registry?: Registry): Promise<FlowRunResult> {
  const tool = createRunFlowTool(registry ?? mockRegistry());
  const result = await tool.execute({}, { name, project_root: tmpDir, device: DEVICE });
  if (!("steps" in result)) throw new Error(`expected a run result, got notice: ${result.notice}`);
  return result;
}

function singleFailure(result: FlowRunResult): FlowStepFailure {
  const carrying = result.steps.filter((s) => s.failure !== undefined);
  expect(carrying).toHaveLength(1);
  expect(carrying[0]!.failure!.message).toBe(carrying[0]!.reason);
  return carrying[0]!.failure!;
}

function available(screen: FlowFailureScreen): Extract<FlowFailureScreen, { state: "available" }> {
  if (screen.state !== "available") {
    throw new Error(`expected an available screen, got ${JSON.stringify(screen)}`);
  }
  return screen;
}

const SPINNER = n({ identifier: "spinner", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } });

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-failure-evidence-"));
  currentFetch = () => ({ tree: screen([label("Home")]), source: "native-devtools" });
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── The three waitForCondition tiers ───────────────────────────────────────

describe("waitForCondition evidence tiers", () => {
  it("tier 1 — no trusted read ever: condition-never-readable, indeterminate, no screen", async () => {
    currentFetch = () => {
      throw new Error("native devtools disconnected");
    };
    await writeFlow("tier1", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "exists", selector: { text: "Done" } }],
    });

    const failure = singleFailure(await run("tier1"));

    expect(failure.code).toBe("condition-never-readable");
    expect(failure.determinacy).toBe("indeterminate");
    // No trusted tree exists, and a stale one must never stand in for it.
    expect(failure.screen.state).toBe("unavailable");
    expect(failure.screen).toMatchObject({
      reason: "never-readable",
      detail: expect.stringContaining("native devtools disconnected"),
    });
    expect(failure.timing.attempts).toBeGreaterThan(0);
    // The gap between attempted and trusted IS the indeterminate story: every
    // read was attempted, none was trustworthy.
    expect(failure.timing.trustedAttempts).toBe(0);
    expect(failure.timing.lastTrustedReadAt).toBeUndefined();
  });

  it("tier 2 — `hidden` with an untrusted final read: condition-hidden-unconfirmable", async () => {
    // Read 1 sees the spinner (trusted); every later read is blank, which the
    // blind-read guard refuses to accept as proof the element left.
    let reads = 0;
    currentFetch = () => ({
      tree: reads++ === 0 ? screen([SPINNER, label("Cart total")]) : screen([]),
      source: "native-devtools",
    });
    await writeFlow("tier2-hidden", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "hidden", selector: { identifier: "spinner" } }],
    });

    const failure = singleFailure(await run("tier2-hidden"));

    expect(failure.code).toBe("condition-hidden-unconfirmable");
    expect(failure.determinacy).toBe("indeterminate");
    // The evidence is the last TRUSTED read — the screen that still had the
    // spinner — not the blank reads that followed it.
    const shown = available(failure.screen);
    expect(shown.capturedAt).toBe("at-failure");
    // In reading order (topmost first), the way `describe` would have shown it.
    expect(shown.elements.map((e) => e.identifier ?? e.label)).toEqual(["Cart total", "spinner"]);
    // The counts come from the SAME trusted read as the tree. Reporting the
    // last merely-successful read here would say "0 matched" — the opposite of
    // this failure's diagnosis, which is that the element WAS there and its
    // departure could not be confirmed.
    expect(failure.actual?.matchCount).toBe(1);
    expect(failure.actual?.visibleMatchCount).toBe(1);
    expect(failure.timing.trustedAttempts).toBe(1);
    expect(failure.timing.attempts).toBeGreaterThan(failure.timing.trustedAttempts!);
  });

  it("tier 2 — a dark tail beyond tolerance: condition-dark-tail with timing.darkTailMs", async () => {
    let reads = 0;
    currentFetch = () => {
      if (reads++ === 0) return { tree: screen([label("Home")]), source: "native-devtools" };
      throw new Error("native devtools disconnected");
    };
    await writeFlow("tier2-dark", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "exists", selector: { text: "Done" } }],
    });

    const failure = singleFailure(await run("tier2-dark"));

    expect(failure.code).toBe("condition-dark-tail");
    expect(failure.determinacy).toBe("indeterminate");
    // The tolerance is two poll intervals (600ms); anything longer means
    // consecutive polls went dark.
    expect(failure.timing.darkTailMs).toBeGreaterThan(600);
    expect(failure.timing.lastTrustedReadAt).toBeGreaterThan(0);
    expect(failure.timing.trustedAttempts).toBe(1);
    expect(failure.timing.attempts).toBeGreaterThan(1);
    // The trusted read still supplies the screen — but the report says plainly
    // that a read failed after it, so the tree can't read as "all was well".
    const shown = available(failure.screen);
    expect(shown.readError).toContain("native devtools disconnected");
  });

  it("tier 3 — a blip inside the tolerance stays DETERMINATE, with the assert code", async () => {
    // Trusted reads showed "Done" absent until ~one poll before the 1s assert
    // deadline; a fetch error on the trailing polls is a blip, not doubt.
    let firstReadAt: number | undefined;
    currentFetch = () => {
      firstReadAt ??= Date.now();
      if (Date.now() - firstReadAt >= 950) throw new Error("native devtools disconnected");
      return { tree: screen([label("Home")]), source: "native-devtools" };
    };
    await writeFlow("tier3", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "exists", selector: { text: "Done" } }],
    });

    const failure = singleFailure(await run("tier3"));

    expect(failure.code).toBe("selector-not-found");
    expect(failure.determinacy).toBe("determinate");
    // The failed final read is appended, never silently dropped.
    expect(failure.message).toMatch(/final poll could not read the UI tree/);
    expect(available(failure.screen).capturedAt).toBe("at-failure");
  });

  it("tier 3 — a BLIND blip names the cause the evidence shows, not the blank read", async () => {
    // The defect this pins: the determinate verdict was computed from the last
    // read that merely SUCCEEDED, while the evidence beside it came from the
    // last TRUSTED one. A blind read landing inside the dark-tail tolerance
    // emptied the former and left the latter holding the element — so a text
    // mismatch was classified `selector-not-found` ("fix your selector"), in a
    // payload whose own `actual` reported the element and its text.
    let firstReadAt: number | undefined;
    currentFetch = () => {
      firstReadAt ??= Date.now();
      // Blank AND flagged degraded — the shape a read taken mid-navigation has.
      if (Date.now() - firstReadAt >= 950) {
        return { tree: screen([]), source: "native-devtools" as const, hint: "app is relaunching" };
      }
      return {
        tree: screen([
          n({
            identifier: "banner",
            label: "Loading",
            frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 },
          }),
        ]),
        source: "native-devtools" as const,
      };
    };
    await writeFlow("tier3-blind", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "text",
          selector: { identifier: "banner" },
          expectedText: "Done",
          textMatch: "equals",
        },
      ],
    });

    const failure = singleFailure(await run("tier3-blind"));

    expect(failure.determinacy).toBe("determinate");
    expect(failure.code).toBe("text-mismatch");
    expect(failure.category).toBe("assertion");
    // The whole point: code, message and observation describe ONE read.
    expect(failure.message).toContain("Loading");
    expect(failure.actual?.matchCount).toBe(1);
    expect(failure.actual?.text).toBe("Loading");
    // ...and the read that went blind is still counted, never hidden.
    expect(failure.timing.attempts).toBeGreaterThan(failure.timing.trustedAttempts!);
  });
});

// ── Which read the screen comes from ───────────────────────────────────────

describe("screen provenance", () => {
  it("shows the last TRUSTED read, never a blind one that came after it", async () => {
    // Read 1 is the real screen. Reads 2+ are blank AND flagged degraded — the
    // shape a mid-navigation blank frame takes. Reporting the blind read would
    // tell the operator the app was empty when argent simply could not see it.
    let reads = 0;
    currentFetch = () =>
      reads++ === 0
        ? {
            tree: screen([
              label("Cart total"),
              n({
                identifier: "checkout-cta",
                label: "Check out",
                frame: { x: 0.1, y: 0.8, width: 0.8, height: 0.08 },
                clickable: true,
              }),
            ]),
            source: "native-devtools",
          }
        : { tree: screen([]), source: "native-devtools", hint: "app is relaunching" };

    await writeFlow("trusted", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "exists", selector: { text: "Checkout" } }],
    });

    const failure = singleFailure(await run("trusted"));

    const shown = available(failure.screen);
    expect(shown.capturedAt).toBe("at-failure");
    expect(shown.source).toBe("native-devtools");
    expect(shown.elementCount).toBe(2);
    expect(shown.elements.map((e) => e.label)).toEqual(["Cart total", "Check out"]);
    // ...but NO candidates. The verdict is indeterminate — argent could not
    // read the screen — and its hint says to re-run rather than edit the flow.
    // A "did you mean checkout-cta?" list beside that sentence invites exactly
    // the edit the hint warns against, on evidence the runner already declared
    // untrustworthy.
    expect(failure.determinacy).toBe("indeterminate");
    expect(failure.candidates).toEqual([]);
  });

  it("does not report a tree-source error that a later read recovered from", async () => {
    // `sink.error = undefined` on a successful read is the only stale-error
    // clear in the file, and nothing exercised recovery: a blip mid-navigation
    // set the error, the next read succeeded, and without the clear the failure
    // would have rendered `screen.readError` — telling the operator the tree
    // source was broken when it had recovered before the step even failed.
    let reads = 0;
    currentFetch = () => {
      reads++;
      // First read throws, every read after it succeeds.
      if (reads === 1) throw new Error("native devtools blipped");
      return { tree: screen([label("Home")]), source: "native-devtools" };
    };
    await writeFlow("recovers", {
      executionPrerequisite: "",
      // A `tap` drives `waitForFrame`, which owns the sink this clears.
      steps: [{ kind: "tap", selector: { text: "Nothing Here", loose: true } }],
    });

    const failure = singleFailure(await run("recovers"));

    expect(reads).toBeGreaterThan(1);
    // A determinate selector miss against a screen that WAS read — not an
    // environment failure.
    expect(failure.code).toBe("selector-not-found");
    expect(failure.determinacy).toBe("determinate");
    const shown = available(failure.screen);
    expect(shown.readError).toBeUndefined();
  }, 20_000);

  it("counts the icon-only elements a `describe` of the same tree would list", async () => {
    // The report tells the operator to compare its element list against a
    // `describe`, so it has to be the SAME subset. `describe` emits a node when
    // `hasContent(n) || CONTENT_ROLES.has(n.role)`; the report gated on
    // `hasContent` alone, which drops exactly the unlabeled
    // AXButton/AXStaticText/AXImage/AXTextField nodes the role term exists for.
    // Those are the icon-only iOS controls — the common case, not an edge one.
    currentFetch = () => ({
      tree: screen([
        // Carries its own identity: counted either way.
        n({ label: "Cart total", frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.05 } }),
        // Unlabeled content roles: counted by `describe`, dropped by
        // `hasContent`.
        n({ role: "AXButton", frame: { x: 0.1, y: 0.3, width: 0.1, height: 0.05 } }),
        n({ role: "AXImage", frame: { x: 0.3, y: 0.3, width: 0.1, height: 0.05 } }),
        // A bare container with nothing of its own: counted by neither.
        n({ role: "AXGroup", frame: { x: 0, y: 0.5, width: 1, height: 0.2 } }),
      ]),
      source: "native-devtools",
    });
    await writeFlow("icons", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "exists", selector: { text: "Nothing Here" } }],
    });

    const shown = available(singleFailure(await run("icons")).screen);

    expect(shown.elementCount).toBe(3);
    expect(shown.elements.map((e) => e.role)).toEqual(["AXOther", "AXButton", "AXImage"]);
  });

  it("marks a post-hoc read `after-failure` — the app may have moved on", async () => {
    // A `tool` step failure carries no tree of its own, so the assembler reads
    // one after the fact. That distinction is the whole reason the field exists.
    const registry = mockRegistry((id) => {
      if (id === "button") throw new Error("no such button");
      return undefined;
    });
    currentFetch = () => ({ tree: screen([label("Home")]), source: "native-devtools" });
    await writeFlow("post-hoc", {
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: "button", args: { button: "back" } }],
    });

    const failure = singleFailure(await run("post-hoc", registry));

    expect(failure.code).toBe("tool-step-failed");
    const shown = available(failure.screen);
    expect(shown.capturedAt).toBe("after-failure");
    expect(shown.elements.map((e) => e.label)).toEqual(["Home"]);
  });
});

// ── waitForFrame's sink: evidence for tap/type ─────────────────────────────

describe("waitForFrame sink", () => {
  it("gives a tap miss the settled tree and a ranked candidate list", async () => {
    // Before the sink existed, waitForFrame returned only a frame — so tap and
    // type failures carried zero evidence. This is the gap it closes.
    currentFetch = () => ({
      tree: screen([
        n({
          identifier: "checkout-cta",
          label: "Check out",
          frame: { x: 0.1, y: 0.8, width: 0.8, height: 0.08 },
          clickable: true,
        }),
        label("Cart total"),
      ]),
      source: "native-devtools",
    });
    await writeFlow("tap-miss", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", selector: { text: "Checkout", loose: true } }],
    });

    const failure = singleFailure(await run("tap-miss"));

    expect(failure.code).toBe("selector-not-found");
    const shown = available(failure.screen);
    expect(shown.capturedAt).toBe("at-failure");
    expect(shown.elements.length).toBe(2);
    expect(failure.candidates.length).toBeGreaterThan(0);
    expect(failure.candidates[0]!.node.label).toBe("Check out");
    expect(failure.candidates[0]!.score).toBeGreaterThan(0);
    // `alternatives` answers "what did it actually look for" — a bare-string
    // tap searched for an identifier AND for text, in that order.
    expect(failure.selector?.alternatives).toEqual([
      { identifier: "Checkout" },
      { text: "Checkout" },
    ]);
    expect(failure.selector?.loose).toBe(true);
    expect(failure.expected).toEqual({ kind: "gesture", gesture: "tap" });
    expect(failure.timing.budgetMs).toBeGreaterThan(0);
    expect(failure.timing.attempts).toBeGreaterThan(0);
  }, 15000);
});

// ── settleTree's sustained-outage throw ────────────────────────────────────

describe("tree-source throws", () => {
  it("classifies a settleTree outage as tree-source-unavailable and keeps the registry code", async () => {
    // The tree helpers throw a dozen different registry codes across four
    // platforms; the classification rides a marker, and the underlying code is
    // preserved separately so both spellings surface.
    currentFetch = () => {
      throw new FailureError("native devtools not connected for com.acme.app", {
        error_code: FAILURE_CODES.NATIVE_DEVTOOLS_NOT_CONNECTED,
        failure_stage: "native_devtools_rpc_connection",
        failure_area: "tool_server",
        // Mirrors the real production site (blueprints/native-devtools.ts) so
        // the fixture stays a faithful stand-in for the error it represents.
        error_kind: "not_found",
      });
    };
    await writeFlow("outage", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", selector: { text: "Checkout", loose: true } }],
    });

    const result = await run("outage");
    const failure = singleFailure(result);

    expect(result.steps[0]!.status).toBe("error");
    expect(failure.code).toBe("tree-source-unavailable");
    expect(failure.determinacy).toBe("indeterminate");
    expect(failure.cause).toEqual({
      code: FAILURE_CODES.NATIVE_DEVTOOLS_NOT_CONNECTED,
      message: "native devtools not connected for com.acme.app",
    });
    expect(failure.screen).toMatchObject({
      state: "unavailable",
      reason: "never-readable",
      detail: expect.stringContaining("native devtools not connected"),
    });
    expect(failure.hint).toMatch(/do not edit the flow/i);
  }, 15000);

  it("never lets a later healthy read mask the outage that failed the step", async () => {
    // THE regression this feature is most likely to grow: the step failed
    // because the tree source was down, a read after it succeeds, and the
    // report shows a perfectly healthy screen — so the operator concludes the
    // environment was fine and goes editing a correct flow.
    //
    // Scripted deterministically: each read takes 60ms and the await window is
    // 1ms, so the loop makes EXACTLY two reads (the deadline poll and its
    // back-to-back final retry), both of which throw. Read 3 — the only read a
    // post-hoc capture could make — returns a healthy screen.
    let reads = 0;
    currentFetch = async () => {
      reads++;
      await new Promise((resolve) => setTimeout(resolve, 60));
      if (reads <= 2) throw new Error("native devtools disconnected");
      return { tree: screen([label("Healthy Later Screen")]), source: "native-devtools" };
    };
    await writeFlow("masking", {
      executionPrerequisite: "",
      steps: [{ kind: "await", condition: "exists", selector: { text: "Done" }, timeout: 1 }],
    });

    const failure = singleFailure(await run("masking"));

    expect(failure.code).toBe("condition-never-readable");
    expect(failure.determinacy).toBe("indeterminate");
    expect(failure.screen.state).toBe("unavailable");
    expect(failure.screen).toMatchObject({
      reason: "never-readable",
      // The ORIGINAL tree error, not whatever a later read reported.
      detail: expect.stringContaining("native devtools disconnected"),
    });
    // The healthy screen must not appear anywhere in the payload…
    expect(JSON.stringify(failure)).not.toContain("Healthy Later Screen");
    // …and the assembler must not even have asked for it: two reads in, two
    // reads out. A third read here would mean a post-hoc capture ran.
    expect(reads).toBe(2);
  });
});
