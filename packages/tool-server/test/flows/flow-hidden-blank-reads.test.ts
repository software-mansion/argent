import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// Serve the flow tree directly (flows hard-fail rather than degrade to the AX
// tree). The mock scripts the reads to shape evidence gaps: a trusted read
// followed by blank trees or throws — the shapes where waitForCondition must
// distinguish "condition false" from "could not look" (blind-read guard for
// `hidden`, dark-tail rule for every condition).
let currentFetch: () => DescribeTreeData;
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => currentFetch()),
}));

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
let tmpDir: string;

function n(partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }): DescribeNode {
  return { role: "AXOther", children: [], ...partial };
}

function screen(children: DescribeNode[]): DescribeNode {
  return n({ role: "AXWindow", frame: { x: 0, y: 0, width: 1, height: 1 }, children });
}

function mockRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "list-devices") return { devices: [] };
      return { ok: true };
    }),
    getTool: vi.fn(() => undefined),
  } as unknown as Registry;
}

async function writeFlow(name: string, yaml: Parameters<typeof serializeFlow>[0]): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), serializeFlow(yaml), "utf8");
}

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

async function run(name: string): Promise<FlowRunResult> {
  return asRun(
    await createRunFlowTool(mockRegistry()).execute(
      {},
      { name, project_root: tmpDir, device: DEVICE }
    )
  );
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-hidden-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("hidden timeout diagnostics", () => {
  it("does not claim the element was still visible when the final reads were blank", async () => {
    // Read 1: the spinner is visible (a trusted read — everMatched flips on).
    // Every later read is an empty tree, which the blind-read guard refuses to
    // trust for `hidden` once the selector has matched. The timeout reason must
    // say the check could not be confirmed — not that an element the last reads
    // never saw was "still visible".
    let reads = 0;
    currentFetch = () => {
      reads++;
      return {
        tree:
          reads === 1
            ? screen([
                n({ identifier: "spinner", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } }),
              ])
            : screen([]),
        source: "native-devtools",
      };
    };

    await writeFlow("blank-hidden", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "hidden", selector: { identifier: "spinner" } }],
    });

    const result = await run("blank-hidden");

    expect(result.ok).toBe(false);
    expect(result.steps[0].status).toBe("error");
    expect(result.steps[0].reason).toMatch(/could not confirm/);
    expect(result.steps[0].reason).not.toMatch(/still visible/);
  });

  it("does not claim the element was still visible when the final reads threw", async () => {
    // Same evidence gap as the blank-tree case, surfaced as a THROW: read 1
    // is trusted and sees the spinner, then the tree source disconnects and
    // every later fetch rejects. The stale read-1 match must not stand in as
    // current evidence — the failure must say the check could not be
    // confirmed (and why), not that the element was "still visible".
    let reads = 0;
    currentFetch = () => {
      if (reads++ === 0) {
        return {
          tree: screen([
            n({ identifier: "spinner", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } }),
          ]),
          source: "native-devtools",
        };
      }
      throw new Error("native devtools disconnected");
    };

    await writeFlow("dark-hidden", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "hidden", selector: { identifier: "spinner" } }],
    });

    const result = await run("dark-hidden");

    expect(result.ok).toBe(false);
    expect(result.steps[0].status).toBe("error");
    expect(result.steps[0].reason).toMatch(/could not confirm/);
    expect(result.steps[0].reason).toMatch(/native devtools disconnected/);
    expect(result.steps[0].reason).not.toMatch(/still visible/);
  });

  it("does not pass a hidden assert when the element was NEVER seen and the tree source is dark", async () => {
    // The runner's half of the no-windows fix: a `hidden` assert whose element
    // is NEVER seen, so `everMatched` never flips and the blind-read guard's
    // everMatched-only backstop can't catch it — the only defense is the tree
    // source refusing the read. The rejecting fetch is SCRIPTED here (this
    // file mocks fetchFlowTree wholesale; the message just mirrors
    // flow-ios-tree's no-windows guard, which flow-ios-tree-no-windows.test.ts
    // exercises at the unit level and flow-hidden-no-windows-e2e.test.ts
    // end-to-end). What this case locks in is the caller's contract with that
    // upstream throw: when every fetch rejects, the assert fails with the
    // outage — the /no window attached/ check pins the fetch error's text
    // landing in the step reason — instead of treating an unreadable screen as
    // a no-match that satisfies `hidden`. The scripted bundle id is a system
    // app because this flow has no `launch:` step, so its reads are unpinned -
    // the one path on which auto-resolve can still hand a connected
    // `com.apple.*` process to the read.
    currentFetch = () => {
      throw new Error(
        "getFullHierarchy returned no windows for com.apple.Preferences - it has no window attached to read"
      );
    };

    await writeFlow("never-seen-hidden", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "hidden", selector: { identifier: "General" } }],
    });

    const result = await run("never-seen-hidden");

    expect(result.ok).toBe(false);
    // `error`, not `fail`: the tree was never readable, so the app was never
    // judged — scoring it a failure would report an environment outage as a
    // regression.
    expect(result.steps[0].status).toBe("error");
    expect(result.steps[0].reason).toMatch(/could not read the UI tree/);
    expect(result.steps[0].reason).toMatch(/no window attached to read/);
    // Must NOT read as a confirmed-hidden pass.
    expect(result.steps[0].reason).not.toMatch(/still visible/);
  });

  it("still reports a genuinely visible element as still visible", async () => {
    currentFetch = () => ({
      tree: screen([
        n({ identifier: "spinner", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("stuck-spinner", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "hidden", selector: { identifier: "spinner" } }],
    });

    const result = await run("stuck-spinner");

    expect(result.ok).toBe(false);
    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/still visible/);
  });

  it("reports still visible when a mid-window throw is followed by a trusted read", async () => {
    // A blip that RECOVERS: read 2 throws, but every later read is trusted
    // and still shows the spinner. The final read is honest evidence, so the
    // determinate "still visible" verdict stands — indeterminacy is only for
    // windows whose last look at the screen was blind or failed.
    let reads = 0;
    currentFetch = () => {
      if (reads++ === 1) throw new Error("native devtools disconnected");
      return {
        tree: screen([
          n({ identifier: "spinner", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } }),
        ]),
        source: "native-devtools",
      };
    };

    await writeFlow("blip-spinner", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "hidden", selector: { identifier: "spinner" } }],
    });

    const result = await run("blip-spinner");

    expect(result.ok).toBe(false);
    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/still visible/);
  });
});

describe("dark-tail diagnostics (non-hidden conditions)", () => {
  it("assert exists: reads going dark after one trusted read report indeterminate, not a stale verdict", async () => {
    // Read 1: trusted, "Done" absent — the expected STARTING state of a
    // wait, not evidence about the deadline. Reads 2+: the tree source dies
    // for the rest of the window. A determinate "no element matched" here
    // would narrate a screen nobody saw at the deadline and drop the fetch
    // error entirely — the verdict must say the screen was unreadable, and
    // say why.
    let reads = 0;
    currentFetch = () => {
      if (reads++ === 0) {
        return {
          tree: screen([n({ label: "Home", frame: { x: 0, y: 0, width: 1, height: 0.1 } })]),
          source: "native-devtools",
        };
      }
      throw new Error("native devtools disconnected");
    };

    await writeFlow("dark-exists", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "exists", selector: { text: "Done" } }],
    });

    const result = await run("dark-exists");

    expect(result.ok).toBe(false);
    expect(result.steps[0].status).toBe("error");
    expect(result.steps[0].reason).toMatch(/unreadable for the final \d+ms/i);
    expect(result.steps[0].reason).toMatch(/native devtools disconnected/);
    expect(result.steps[0].reason).not.toMatch(/no element matched/);
  });

  it("await exists: the same dark tail under an await window surfaces the fetch error", async () => {
    let reads = 0;
    currentFetch = () => {
      if (reads++ === 0) {
        return {
          tree: screen([n({ label: "Home", frame: { x: 0, y: 0, width: 1, height: 0.1 } })]),
          source: "native-devtools",
        };
      }
      throw new Error("native devtools disconnected");
    };

    await writeFlow("dark-await", {
      executionPrerequisite: "",
      steps: [{ kind: "await", condition: "exists", selector: { text: "Done" }, timeout: 1000 }],
    });

    const result = await run("dark-await");

    expect(result.ok).toBe(false);
    expect(result.steps[0].status).toBe("error");
    expect(result.steps[0].reason).toMatch(/unreadable for the final \d+ms/i);
    expect(result.steps[0].reason).toMatch(/native devtools disconnected/);
    expect(result.steps[0].reason).not.toMatch(/no element matched/);
  });

  it("assert text: does not quote stale element text from before the reads went dark", async () => {
    // Read 1 sees the banner saying "Loading"; then the source dies. Quoting
    // `its text was "Loading"` at the deadline would present a first-poll
    // snapshot as the state of a screen that was unreadable for essentially
    // the whole window.
    let reads = 0;
    currentFetch = () => {
      if (reads++ === 0) {
        return {
          tree: screen([
            n({
              identifier: "banner",
              label: "Loading",
              frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 },
            }),
          ]),
          source: "native-devtools",
        };
      }
      throw new Error("native devtools disconnected");
    };

    await writeFlow("dark-text", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "text",
          selector: { identifier: "banner" },
          expectedText: "Done",
          textMatch: "contains",
        },
      ],
    });

    const result = await run("dark-text");

    expect(result.ok).toBe(false);
    expect(result.steps[0].status).toBe("error");
    expect(result.steps[0].reason).toMatch(/unreadable for the final \d+ms/i);
    expect(result.steps[0].reason).toMatch(/native devtools disconnected/);
    expect(result.steps[0].reason).not.toMatch(/Loading/);
  });

  it("keeps the determinate verdict — with the error appended — when only the final polls throw", async () => {
    // The deliberate trailing tolerance: trusted reads showed "Done" absent
    // until ~one poll before the 1s assert deadline, so a fetch error on the
    // trailing polls is a blip, not doubt — the determinate reason stands.
    // The failed final read is appended rather than silently dropped (main
    // surfaced `could not read the UI tree: <err>` here; losing it was a
    // report-quality regression).
    let firstReadAt: number | undefined;
    currentFetch = () => {
      firstReadAt ??= Date.now();
      if (Date.now() - firstReadAt >= 950) throw new Error("native devtools disconnected");
      return {
        tree: screen([n({ label: "Home", frame: { x: 0, y: 0, width: 1, height: 0.1 } })]),
        source: "native-devtools",
      };
    };

    await writeFlow("blip-exists", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "exists", selector: { text: "Done" } }],
    });

    const result = await run("blip-exists");

    expect(result.ok).toBe(false);
    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/no element matched/);
    expect(result.steps[0].reason).toMatch(
      /final poll could not read the UI tree: native devtools disconnected/
    );
  });
});

describe("compatibility miss note is scoped to a MISS", () => {
  // A fullwidth "＠bsky.app" is an NFKC variant of "@bsky.app". The fold does
  // not equate them, so a selector for the plain form never matches it.

  it("does not append backwards 'copy the rendered characters' advice to a hidden failure", async () => {
    // `hidden` requires the absence of the element, not a change of characters.
    currentFetch = () => ({
      tree: screen([
        n({ label: "‪@bsky.app‬", frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.05 } }),
        n({ label: "＠bsky.app", frame: { x: 0.1, y: 0.2, width: 0.5, height: 0.05 } }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("hidden-compat", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "hidden", selector: { text: "@bsky.app" } }],
    });

    const result = await run("hidden-compat");

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/still visible/);
    expect(result.steps[0].reason).not.toMatch(/typographic variant/);
    expect(result.steps[0].reason).not.toMatch(/Copy the characters/);
  });

  it("does not append the note to a regex `matches` failure (wanted is a pattern, not text)", async () => {
    // In `matches` mode the expected string is a pattern, not text.
    currentFetch = () => ({
      tree: screen([
        n({
          identifier: "lbl",
          label: "Add more languages…",
          frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 },
        }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("matches-compat", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "text",
          selector: { identifier: "lbl" },
          expectedText: "Add more languages...",
          textMatch: "matches",
        },
      ],
    });

    const result = await run("matches-compat");

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/but its text was/);
    expect(result.steps[0].reason).not.toMatch(/typographic variant/);
  });

  it("does not quote hoisted subtree text on the whole-tree walk an `exists` miss takes", async () => {
    // With nothing located, the walk reads each node's own label and value, never
    // its subtreeText, so this reason quotes a leaf and not the whole hoisted
    // card - which is why it does not grow with the depth cap.
    currentFetch = () => ({
      tree: screen([
        n({
          identifier: "card",
          subtreeText: "row-a-content row-b-content Add more languages…",
          frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.4 },
          children: [
            n({
              label: "Add more languages…",
              frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 },
            }),
          ],
        }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("exists-compat", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "exists", selector: { text: "Add more languages..." } }],
    });

    const result = await run("exists-compat");
    const reason = result.steps[0].reason ?? "";

    expect(result.steps[0].status).toBe("fail");
    expect(reason).toMatch(/typographic variant/);
    // The leaf's own label is quoted. The container's hoisted string is not.
    expect(reason).not.toMatch(/row-a-content/);
  });

  it("still fires the note on a genuine miss (visible), so the guard is not over-broad", async () => {
    currentFetch = () => ({
      tree: screen([
        n({ label: "Add more languages…", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 } }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("visible-compat", {
      executionPrerequisite: "",
      steps: [
        { kind: "assert", condition: "visible", selector: { text: "Add more languages..." } },
      ],
    });

    const result = await run("visible-compat");

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/typographic variant/);
    expect(result.steps[0].reason).toMatch(/Add more languages…/);
  });
});

describe("text/equals failure notes are wired through the runner and scoped to the element", () => {
  it("names the differing invisible codepoints when the two strings look identical", async () => {
    // U+034F (COMBINING GRAPHEME JOINER) is not one of the fold's classes, so
    // the fold keeps it. The two strings look the same on screen.
    currentFetch = () => ({
      tree: screen([
        n({
          identifier: "amount",
          label: "PLN 42\u034F",
          frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.05 },
        }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("confusable-equals", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "text",
          selector: { identifier: "amount" },
          expectedText: "PLN 42",
          textMatch: "equals",
        },
      ],
    });

    const result = await run("confusable-equals");

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/differ only in invisible characters/);
    expect(result.steps[0].reason).toMatch(/U\+034F/);
  });

  it("emits only ONE note when own text and subtree text miss in different ways", async () => {
    // The node's own text differs by an invisible U+034F. The hoisted subtree
    // text differs by a ligature ("ﬁle"). The codepoint note is more precise.
    currentFetch = () => ({
      tree: screen([
        n({
          identifier: "x",
          label: "file\u034F",
          subtreeText: "ﬁle",
          frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.05 },
        }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("cross-case-note", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "text",
          selector: { identifier: "x" },
          expectedText: "file",
          textMatch: "equals",
        },
      ],
    });

    const result = await run("cross-case-note");

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/differ only in invisible characters/);
    expect(result.steps[0].reason).toMatch(/U\+034F/);
    expect(result.steps[0].reason).not.toMatch(/typographic variant/);
  });

  it("names the invisible codepoints via the own-text fallback when subtree text differs visibly", async () => {
    currentFetch = () => ({
      tree: screen([
        n({
          identifier: "amt",
          label: "PLN 42\u034F",
          subtreeText: "Total due now",
          frame: { x: 0.1, y: 0.1, width: 0.6, height: 0.05 },
        }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("confusable-own-fallback", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "text",
          selector: { identifier: "amt" },
          expectedText: "PLN 42",
          textMatch: "equals",
        },
      ],
    });

    const result = await run("confusable-own-fallback");

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/differ only in invisible characters/);
    expect(result.steps[0].reason).toMatch(/U\+034F/);
  });

  it("does not add the invisible-codepoint note to a regex `matches` failure", async () => {
    // Same exemption as the compat note: a pattern is not text.
    currentFetch = () => ({
      tree: screen([
        n({
          identifier: "amt",
          label: "PLN 42\u034F",
          frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.05 },
        }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("matches-confusable", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "text",
          selector: { identifier: "amt" },
          expectedText: "^PLN 42$",
          textMatch: "matches",
        },
      ],
    });

    const result = await run("matches-confusable");

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/but its text was/);
    expect(result.steps[0].reason).not.toMatch(/differ only in invisible characters/);
  });

  it("does NOT let an unrelated compat-variant node hijack a genuine text miss", async () => {
    // The note is scoped to the located element, not to look-alikes elsewhere.
    currentFetch = () => ({
      tree: screen([
        n({
          identifier: "banner",
          label: "Loading",
          frame: { x: 0.1, y: 0.1, width: 0.4, height: 0.05 },
        }),
        n({ label: "More…", frame: { x: 0.1, y: 0.8, width: 0.4, height: 0.05 } }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("text-miss-no-hijack", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "text",
          selector: { identifier: "banner" },
          expectedText: "More...",
          textMatch: "contains",
        },
      ],
    });

    const result = await run("text-miss-no-hijack");

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/but its text was "Loading"/);
    expect(result.steps[0].reason).not.toMatch(/typographic variant/);
    expect(result.steps[0].reason).not.toMatch(/More…/);
  });

  it("still names the compat variant when it IS the located element's own text", async () => {
    currentFetch = () => ({
      tree: screen([
        n({
          identifier: "lbl",
          label: "Add more languages…",
          frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 },
        }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("text-compat-own", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "text",
          selector: { identifier: "lbl" },
          expectedText: "Add more languages...",
          textMatch: "equals",
        },
      ],
    });

    const result = await run("text-compat-own");

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/typographic variant/);
    expect(result.steps[0].reason).toMatch(/Add more languages…/);
  });

  it("explains a LOCATOR miss under `matches` too, as `exists` is explained", async () => {
    // The `matches` exemption is about the expectation. This branch never
    // reads the expectation - it walks the tree for a literal `selector.text`.
    currentFetch = () => ({
      tree: screen([
        n({ label: "Add more languages…", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 } }),
      ]),
      source: "native-devtools",
    });

    for (const [name, step] of [
      ["locator-miss-exists", { condition: "exists" as const }],
      [
        "locator-miss-contains",
        { condition: "text" as const, expectedText: "whatever", textMatch: "contains" as const },
      ],
      [
        "locator-miss-matches",
        { condition: "text" as const, expectedText: "whatever", textMatch: "matches" as const },
      ],
    ] as const) {
      await writeFlow(name, {
        executionPrerequisite: "",
        steps: [
          {
            kind: "assert",
            selector: { text: "Add more languages..." },
            ...step,
          },
        ],
      });

      const result = await run(name);

      expect(result.steps[0].status).toBe("fail");
      expect(result.steps[0].reason, name).toMatch(/typographic variant/);
      expect(result.steps[0].reason, name).toMatch(/Add more languages…/);
    }
  });
});

describe("compatibility miss note: what it is scoped to", () => {
  it("does not re-quote a label the reason already carries", async () => {
    // On the located branch assertReason has already printed `its text was
    // "<shown>"`. assertText prefers the hoisted subtreeText, so re-printing it
    // in the note carried the whole aggregated card twice in one reason.
    const CARD = `${"Total 42. ".repeat(140)}Add more languages…`;
    const TYPED = `${"Total 42. ".repeat(140)}Add more languages...`;
    currentFetch = () => ({
      tree: screen([
        n({
          identifier: "card",
          subtreeText: CARD,
          frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.4 },
        }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("compat-no-requote", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "text",
          selector: { identifier: "card" },
          expectedText: TYPED,
          textMatch: "equals",
        },
      ],
    });

    const result = await run("compat-no-requote");
    const reason = result.steps[0].reason!;

    expect(result.steps[0].status).toBe("fail");
    expect(reason).toMatch(/typographic variant/);
    // The label prints once, and the expectation once. Not the label twice: the
    // reason fits both plus the prose, where a second copy could not.
    expect(reason.split("Add more languages…").length - 1).toBe(1);
    expect(reason.length).toBeLessThan(CARD.length + TYPED.length + 1000);
  });

  it("names only an element the REST of the selector could have accepted", async () => {
    // The walk must re-apply role, id and scopes, not the text test alone.
    currentFetch = () => ({
      tree: screen([
        n({
          identifier: "ellipsis",
          label: "Add more languages…",
          frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 },
        }),
        n({
          identifier: "plain",
          label: "Sign in",
          frame: { x: 0.1, y: 0.3, width: 0.8, height: 0.05 },
        }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("compat-wrong-id", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "visible",
          selector: { text: "Add more languages...", identifier: "plain" },
        },
      ],
    });

    const wrongId = await run("compat-wrong-id");
    expect(wrongId.steps[0].status).toBe("fail");
    expect(wrongId.steps[0].reason).not.toMatch(/typographic variant/);
    expect(wrongId.steps[0].reason).not.toMatch(/Add more languages…/);

    // Control: with the id the look-alike carries, the note must still fire.
    await writeFlow("compat-right-id", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "visible",
          selector: { text: "Add more languages...", identifier: "ellipsis" },
        },
      ],
    });

    const rightId = await run("compat-right-id");
    expect(rightId.steps[0].status).toBe("fail");
    expect(rightId.steps[0].reason).toMatch(/typographic variant/);
  });

  it("describes the very node assertReason quotes, not a zero-area shadow above it", async () => {
    // The pick is visible-first, so the note and the quoted text name one node.
    currentFetch = () => ({
      tree: screen([
        // Zero-area and first in reading order: what an unfiltered pick takes.
        n({
          role: "AXButton",
          label: "Add more languages…",
          frame: { x: 0.1, y: 0.1, width: 0, height: 0 },
        }),
        // The visible match, which is the one the reason quotes.
        n({
          role: "AXButton",
          label: "Something else",
          frame: { x: 0.1, y: 0.3, width: 0.8, height: 0.05 },
        }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("compat-visible-first", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "text",
          selector: { role: "AXButton" },
          expectedText: "Add more languages...",
          textMatch: "equals",
        },
      ],
    });

    const result = await run("compat-visible-first");
    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/but its text was "Something else"/);
    expect(result.steps[0].reason).not.toMatch(/typographic variant/);
  });

  it("asks the whole-string question for `equals` and the substring one for `contains`", async () => {
    // The label holds a compat variant plus more text. A copy of the rendered
    // characters rescues `contains`, but never `equals`.
    currentFetch = () => ({
      tree: screen([
        n({
          identifier: "lbl",
          label: "Add more languages… now",
          frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 },
        }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("compat-equals-longer", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "text",
          selector: { identifier: "lbl" },
          expectedText: "Add more languages...",
          textMatch: "equals",
        },
      ],
    });
    const equals = await run("compat-equals-longer");
    expect(equals.steps[0].status).toBe("fail");
    expect(equals.steps[0].reason).not.toMatch(/typographic variant/);

    await writeFlow("compat-contains-longer", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "text",
          selector: { identifier: "lbl" },
          expectedText: "Add more languages...",
          textMatch: "contains",
        },
      ],
    });
    const contains = await run("compat-contains-longer");
    expect(contains.steps[0].status).toBe("fail");
    expect(contains.steps[0].reason).toMatch(/typographic variant/);
  });

  it("names the code points when only an invisible kept the SELECTOR from matching", async () => {
    // The compat note asks the NFKC question only. The selector path also
    // needs the codepoint note.
    currentFetch = () => ({
      tree: screen([
        n({ label: "SaveChanges", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 } }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("selector-invisible", {
      executionPrerequisite: "",
      steps: [
        // U+034F in the selector, not on the screen: the two look the same.
        { kind: "assert", condition: "visible", selector: { text: "Save͏Changes" } },
      ],
    });

    const result = await run("selector-invisible");
    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/differ only in invisible characters/);
    expect(result.steps[0].reason).toMatch(/U\+034F/);
  });

  it("does not name a zero-area node to a `visible` step that matched nothing", async () => {
    // With no matches the walk runs, and must not name a node that is off screen.
    currentFetch = () => ({
      tree: screen([
        // The only look-alike is zero-area, so it is no answer for `visible`.
        n({ label: "Add more languages…", frame: { x: 0.1, y: 0.3, width: 0, height: 0 } }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("compat-zero-area-lookalike", {
      executionPrerequisite: "",
      steps: [
        { kind: "assert", condition: "visible", selector: { text: "Add more languages..." } },
      ],
    });

    const result = await run("compat-zero-area-lookalike");
    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).not.toMatch(/typographic variant/);

    // `exists` deliberately accepts zero-area nodes, so it still gets the note.
    await writeFlow("compat-zero-area-exists", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "exists", selector: { text: "Add more languages..." } }],
    });

    const exists = await run("compat-zero-area-exists");
    expect(exists.steps[0].status).toBe("fail");
    expect(exists.steps[0].reason).toMatch(/typographic variant/);
  });

  it("stays quiet when `visible` failed on zero-area matches, not on a miss", async () => {
    // The locator worked, so the note has nothing to correct. Only Vega keeps
    // zero-area nodes. iOS, Android and Chromium prune them.
    currentFetch = () => ({
      tree: screen([
        // The match itself, zero-area.
        n({ label: "Add more languages...", frame: { x: 0.1, y: 0.1, width: 0, height: 0 } }),
        // A look-alike elsewhere, which a whole-tree walk names.
        n({ label: "Add more languages…", frame: { x: 0.1, y: 0.3, width: 0.8, height: 0.05 } }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("zero-area-visible", {
      executionPrerequisite: "",
      steps: [
        { kind: "assert", condition: "visible", selector: { text: "Add more languages..." } },
      ],
    });

    const result = await run("zero-area-visible");

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/none was visible/);
    expect(result.steps[0].reason).not.toMatch(/typographic variant/);
  });

  it("fires for a `text` condition whose LOCATOR missed, as `exists` already does", async () => {
    currentFetch = () => ({
      tree: screen([
        n({ label: "Add more languages…", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 } }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("text-locator-miss", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "text",
          selector: { text: "Add more languages..." },
          expectedText: "Add more languages...",
          textMatch: "equals",
        },
      ],
    });

    const result = await run("text-locator-miss");

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/no element matched/);
    expect(result.steps[0].reason).toMatch(/typographic variant/);
    expect(result.steps[0].reason).toMatch(/Add more languages…/);
  });

  it("never suggests hoisted subtree text, which no `text` selector can match", async () => {
    // A selector's `text` matches a label or a value only, so no selector can
    // match the hoisted subtree string.
    currentFetch = () => ({
      tree: screen([
        n({
          identifier: "card",
          subtreeText: "Add more languages… now",
          frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.2 },
          children: [
            n({
              label: "Add more languages…",
              frame: { x: 0.1, y: 0.1, width: 0.4, height: 0.05 },
            }),
            n({ label: "now", frame: { x: 0.5, y: 0.1, width: 0.2, height: 0.05 } }),
          ],
        }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("subtree-suggestion", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "visible",
          selector: { text: "Add more languages... now" },
        },
      ],
    });

    const result = await run("subtree-suggestion");

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).not.toMatch(/Add more languages… now/);
  });

  it("still suggests a LEAF label on the same tree shape", async () => {
    // A `text` selector can match a leaf's own label, so the note names it.
    currentFetch = () => ({
      tree: screen([
        n({
          identifier: "card",
          subtreeText: "Add more languages… now",
          frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.2 },
          children: [
            n({
              label: "Add more languages…",
              frame: { x: 0.1, y: 0.1, width: 0.4, height: 0.05 },
            }),
            n({ label: "now", frame: { x: 0.5, y: 0.1, width: 0.2, height: 0.05 } }),
          ],
        }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("leaf-suggestion", {
      executionPrerequisite: "",
      steps: [
        { kind: "assert", condition: "visible", selector: { text: "Add more languages..." } },
      ],
    });

    const result = await run("leaf-suggestion");

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/typographic variant/);
    expect(result.steps[0].reason).toMatch(/text is "Add more languages…"/);
  });

  it("fires on a PARTIAL miss, the default comparator's own shape", async () => {
    // A selector's `text` is a substring test, so a partial variant fires the note.
    currentFetch = () => ({
      tree: screen([
        n({
          label: "Settings — Add more languages… now",
          frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 },
        }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("partial-compat", {
      executionPrerequisite: "",
      steps: [
        { kind: "assert", condition: "visible", selector: { text: "Add more languages..." } },
      ],
    });

    const result = await run("partial-compat");

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/typographic variant/);
  });

  it("neutralises a directional override in the SCREEN text it quotes", async () => {
    // An unbalanced U+202E reverses every character after it. The fold keeps
    // the controls that reorder, so the message neutralises them instead.
    currentFetch = () => ({
      tree: screen([
        n({
          label: "Add more languages…‮",
          frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 },
        }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("rlo-quote", {
      executionPrerequisite: "",
      steps: [
        { kind: "assert", condition: "visible", selector: { text: "Add more languages..." } },
      ],
    });

    const result = await run("rlo-quote");

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/typographic variant/);
    expect(result.steps[0].reason).not.toContain("‮");
    expect(result.steps[0].reason).toMatch(/<U\+202E>/);
  });

  it("neutralises a directional override in the AUTHORED expectation too", async () => {
    // `JSON.stringify` does not escape U+202E, and the note prints after it.
    currentFetch = () => ({
      tree: screen([n({ label: "bedrock", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 } })]),
      source: "native-devtools",
    });

    await writeFlow("rlo-expect", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "text",
          selector: { text: "bedrock" },
          expectedText: "bed\u202Erock",
          textMatch: "contains",
        },
      ],
    });

    const result = await run("rlo-expect");

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).not.toContain("\u202E");
    expect(result.steps[0].reason).toMatch(/<U\+202E>/);
    // The note that follows is still present and in the correct order.
    expect(result.steps[0].reason).toMatch(/REORDERS/);
  });

  it("neutralises a directional override in the SELECTOR, which prints first of all", async () => {
    // The selector opens the reason, so an override there reverses all of it.
    currentFetch = () => ({
      tree: screen([
        n({ label: "Save\u202EChanges", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 } }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("rlo-selector", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "text",
          selector: { text: "Save\u202EChanges" },
          expectedText: "nope",
          textMatch: "equals",
        },
      ],
    });

    const result = await run("rlo-selector");

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).not.toContain("\u202E");
    expect(result.steps[0].reason).toMatch(/matched text="Save<U\+202E>Changes"/);
  });

  it("neutralises it in the selector of a MISS, where the miss note follows", async () => {
    currentFetch = () => ({
      tree: screen([
        n({ label: "SaveChanges", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 } }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("rlo-selector-miss", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "visible",
          selector: { text: "Save\u202E\u034FChanges" },
        },
      ],
    });

    const result = await run("rlo-selector-miss");

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).not.toContain("\u202E");
    expect(result.steps[0].reason).toMatch(/selector text="Save<U\+202E>\u034FChanges"/);
    expect(result.steps[0].reason).toMatch(/REORDERS/);
  });

  it("leaves ordinary quoted text alone, so it stays copy-pasteable", async () => {
    currentFetch = () => ({
      tree: screen([
        n({ label: "Add more languages…", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 } }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("plain-quote", {
      executionPrerequisite: "",
      steps: [
        { kind: "assert", condition: "visible", selector: { text: "Add more languages..." } },
      ],
    });

    const result = await run("plain-quote");

    expect(result.steps[0].reason).toMatch(/text is "Add more languages…"/);
    expect(result.steps[0].reason).not.toMatch(/<U\+/);
  });

  it("neutralises it in the TEXT-miss reason, where the codepoint note follows", async () => {
    // "report<U+202E>txt.exe" renders as "reportexe.txt".
    currentFetch = () => ({
      tree: screen([
        n({
          identifier: "file",
          label: "report‮txt.exe",
          frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 },
        }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("rlo-text-miss", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "text",
          selector: { identifier: "file" },
          expectedText: "reporttxt.exe",
          textMatch: "equals",
        },
      ],
    });

    const result = await run("rlo-text-miss");

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).not.toContain("‮");
    expect(result.steps[0].reason).toMatch(/<U\+202E>/);
    expect(result.steps[0].reason).toMatch(/REORDERS/);
  });
});

describe("a `matches` (regex) miss still explains an invisible it cannot see", () => {
  it("names the ignorable codepoints in the text the pattern was tested against", async () => {
    // `matches` is exempt from the fold and both other notes, so it needs its own.
    currentFetch = () => ({
      tree: screen([
        n({
          identifier: "who",
          label: "‪Hubert Gancarczyk‬",
          frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 },
        }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("matches-invisible", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "text",
          selector: { identifier: "who" },
          expectedText: "^Hubert Gancarczyk$",
          textMatch: "matches",
        },
      ],
    });

    const result = await run("matches-invisible");

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/U\+202A/);
    expect(result.steps[0].reason).toMatch(/U\+202C/);
    // The note does not compare code points against the pattern, which is not text.
    expect(result.steps[0].reason).not.toMatch(/vs expected \[/);
  });

  it("names a bidi wrapper as REORDERING, never as an invisible character", async () => {
    // A directional control draws nothing but moves the glyphs around it.
    currentFetch = () => ({
      tree: screen([
        n({
          identifier: "who",
          label: "‪Hubert Gancarczyk‬",
          frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 },
        }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("matches-directional", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "text",
          selector: { identifier: "who" },
          expectedText: "^Hubert Gancarczyk$",
          textMatch: "matches",
        },
      ],
    });

    const result = await run("matches-directional");

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/directional formatting/);
    expect(result.steps[0].reason).toMatch(/REORDERS/);
    expect(result.steps[0].reason).not.toMatch(/invisible characters/);
  });

  it("names the invisible without claiming it is why the pattern missed", async () => {
    // The note states a fact about the text rather than diagnosing the miss.
    // Re-running the author's pattern on the stripped text to prove causality
    // is what an ignorable-blocked anchored pattern makes catastrophic, and it
    // is the more useful sentence anyway: a pattern corrected for some other
    // reason still has to account for these characters on the next run.
    currentFetch = () => ({
      tree: screen([
        n({
          identifier: "who",
          label: "‪Bob Smith‬",
          frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 },
        }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("matches-irrelevant", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "text",
          selector: { identifier: "who" },
          expectedText: "^Alice Jones$",
          textMatch: "matches",
        },
      ],
    });

    const result = await run("matches-irrelevant");

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/but its text was/);
    expect(result.steps[0].reason).toMatch(/the text carries/);
    // It reports what the text holds. It does not say this is the reason.
    expect(result.steps[0].reason).not.toMatch(/must account for/);
    expect(result.steps[0].reason).toMatch(/has to match them literally/);
    // The wrapper is dropped from the quoted label, not named: the fold strips
    // it, so the screen draws none of it.
    expect(result.steps[0].reason).not.toMatch(/<U\+202A>/);
    expect(result.steps[0].reason).toMatch(/its text was "Bob Smith"/);
  });

  it("stays quiet when the pattern already spells the invisible out", async () => {
    // Nothing to point out: the author accounted for every one of them.
    currentFetch = () => ({
      tree: screen([
        n({
          identifier: "who",
          label: "\u202ABob Smith\u202C",
          frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 },
        }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("matches-spelled", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "text",
          selector: { identifier: "who" },
          expectedText: "^\u202AAlice Jones\u202C$",
          textMatch: "matches",
        },
      ],
    });

    const result = await run("matches-spelled");

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).not.toMatch(/the text carries/);
  });

  it("stays quiet when the text carries no invisible at all", async () => {
    currentFetch = () => ({
      tree: screen([
        n({
          identifier: "who",
          label: "Someone Else",
          frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 },
        }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("matches-plain", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "text",
          selector: { identifier: "who" },
          expectedText: "^Hubert Gancarczyk$",
          textMatch: "matches",
        },
      ],
    });

    const result = await run("matches-plain");

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/but its text was/);
    expect(result.steps[0].reason).not.toMatch(/U\+/);
  });
});

describe("evidence and tree-source gaps the widened match set now reaches", () => {
  it("keeps `hidden` unconfirmable once a FOLD-widened selector has matched", async () => {
    // Characterisation, not a defect. The blind-read guard distrusts any empty
    // tree after a match, and the fold widens the set of labels that match.
    let reads = 0;
    currentFetch = () => {
      reads++;
      return {
        tree:
          reads === 1
            ? screen([
                n({ label: "Sign​ in", frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.05 } }),
              ])
            : screen([]),
        source: "native-devtools",
      };
    };

    await writeFlow("folded-hidden", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "hidden", selector: { text: "Sign in" } }],
    });

    const result = await run("folded-hidden");

    // Scored `error`, not `fail`: an empty read cannot decide the assertion, and
    // the indeterminate rule this PR adds reports that as an environment problem
    // rather than a failed check. The reason is unchanged.
    expect(result.steps[0].status).toBe("error");
    expect(result.steps[0].reason).toMatch(/could not confirm/);
  });

  it("still emits the miss note when the FINAL read went blind", async () => {
    // Only a trusted read updates lastTree, so a trailing degraded tree must
    // not erase the evidence the note needs. The blind read must occur inside
    // the dark-tail tolerance of 2 poll intervals. The deadline poll and its
    // final retry run with no sleep between them, so the tail is fetch latency.
    const ASSERT_WINDOW_MS = 1000; // DEFAULT_ASSERT_TIMEOUT_MS in flow-actions
    let firstReadAt: number | undefined;
    let servedWindowEnd = false;
    currentFetch = () => {
      firstReadAt ??= Date.now();
      // Just inside the window, so this is the last read with budget left.
      const atWindowEnd = Date.now() - firstReadAt >= ASSERT_WINDOW_MS - 50;
      if (!atWindowEnd || !servedWindowEnd) {
        servedWindowEnd ||= atWindowEnd;
        return {
          tree: screen([
            n({
              label: "Add more languages…",
              frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 },
            }),
          ]),
          source: "native-devtools",
        };
      }
      // Empty and flagged degraded: a blind read, whatever everMatched says.
      return { tree: screen([]), source: "native-devtools", hint: "AX is warming up" };
    };

    await writeFlow("blind-tail-note", {
      executionPrerequisite: "",
      steps: [
        { kind: "assert", condition: "visible", selector: { text: "Add more languages..." } },
      ],
    });

    const result = await run("blind-tail-note");

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/typographic variant/);
    expect(result.steps[0].reason).toMatch(/Add more languages…/);
  });

  it("finds the near-match on a node's VALUE, not only its label", async () => {
    currentFetch = () => ({
      tree: screen([
        n({
          role: "AXStaticText",
          value: "Add more languages…",
          frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 },
        }),
      ]),
      source: "native-devtools",
    });

    await writeFlow("value-near-match", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "exists", selector: { text: "Add more languages..." } }],
    });

    const result = await run("value-near-match");

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/typographic variant/);
    expect(result.steps[0].reason).toMatch(/text is "Add more languages…"/);
  });
});
