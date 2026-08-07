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
    expect(result.steps[0].status).toBe("fail");
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
    expect(result.steps[0].status).toBe("fail");
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
    // outage — the /not injectable/ check pins the fetch error's text landing
    // in the step reason — instead of treating an unreadable screen as a
    // no-match that satisfies `hidden`.
    currentFetch = () => {
      throw new Error(
        "getFullHierarchy returned no windows for com.apple.Preferences — the app is not injectable"
      );
    };

    await writeFlow("never-seen-hidden", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "hidden", selector: { identifier: "General" } }],
    });

    const result = await run("never-seen-hidden");

    expect(result.ok).toBe(false);
    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/could not read the UI tree/);
    expect(result.steps[0].reason).toMatch(/not injectable/);
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
    expect(result.steps[0].status).toBe("fail");
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
    expect(result.steps[0].status).toBe("fail");
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
    expect(result.steps[0].status).toBe("fail");
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
  // A fullwidth "＠bsky.app" is a compatibility variant of "@bsky.app" (NFKC
  // folds ＠→@) but is deliberately NOT folded together, so a selector for the
  // plain form never matches it. The note names it only where naming it helps.

  it("does not append backwards 'copy the rendered characters' advice to a hidden failure", async () => {
    // `hidden` fails because the PLAIN handle is still on screen. Telling the
    // author to copy the rendered characters of a fullwidth look-alike is
    // backwards for an assertion that wants the element GONE.
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
    // The element renders a single "…"; the pattern uses three dots. The note
    // would compare the pattern's code points to the rendered label, which has
    // nothing to do with why the regex failed — the same exemption the
    // confusable note draws.
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

  it("still fires the note on a genuine miss (visible), so the guard is not over-broad", async () => {
    // The intended case: a selector typed with three dots misses a label the app
    // renders with one "…". Naming it turns an unexplainable miss into a fix.
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
    // U+034F (COMBINING GRAPHEME JOINER) is not one of the fold's explicit
    // classes, so it does NOT fold away — the check fails against two
    // strings that read identically on screen. The reason must say which
    // codepoints differ, not quote the same text twice (confusableTextNote,
    // reached only through assertReason, which nothing else exercised end-to-end).
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
    // A pathological node: its OWN text differs from "file" by an invisible
    // (U+034F), while its hoisted SUBTREE text differs by a ligature ("ﬁle").
    // The invisible-codepoint note (from assertReason) and the typographic
    // variant note would both fire and print two conflicting explanations of one
    // failure. The codepoint note is more precise, so the compat note stands down.
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
    // The hoisted subtree text is a visibly different string, so the confusable
    // note falls through to the node's OWN text, which differs from the expected
    // only by an invisible U+034F. Exercises the second operand of the `??`.
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
    // The label carries an invisible U+034F; an anchored pattern fails on it.
    // In `matches` mode the expected string is a pattern, not text, so the
    // confusable note must not compare their codepoints (the same exemption the
    // compat note draws, but for the confusable note reached via assertReason).
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
    // The located element (id=banner) genuinely renders "Loading" — a real
    // mismatch for "More...". A DIFFERENT, unrelated node renders "More…" (one
    // U+2026). The compat note is scoped to the located element, so it must stay
    // silent rather than tell the author to copy the rendered characters of a
    // look-alike that has nothing to do with why the banner failed.
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
    // The intended case survives the scoping: the located element itself renders
    // "Add more languages…" (one U+2026) while the author typed three dots.
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
    // The `matches` exemption is about the EXPECTATION, and the not-located
    // branch never reads the expectation — it walks the tree for
    // `selector.text`, which is a literal whatever comparator the step uses.
    // Applied before the branch was chosen, it dropped the explanation for the
    // one comparator whose expectation was irrelevant to why the selector
    // missed, so the same selector on the same screen was explained under
    // `exists` and left bare under `text`.
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
  it("names only an element the REST of the selector could have accepted", async () => {
    // The walk applied the text test alone, never re-applying role/id/scopes,
    // so it named a node the step could never have matched. Taking the advice
    // meant changing the one field that was already correct and landing back on
    // a bare miss with no further hint.
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

    // Control: with the id the look-alike actually carries, the note is the
    // whole point and must still fire.
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

  it("does not name a zero-area node to a `visible` step that matched nothing", async () => {
    // The `visible`-with-matches exemption does not cover this: with NO matches
    // the walk runs, and could name a node the runner simultaneously knows is
    // off screen. Following that advice only flips the failure to
    // "matched … but none was visible".
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
    // The locator WORKED — assertReason says so ("none was visible"). Appending
    // "copy the characters the app actually renders" then blames the wrong
    // thing entirely. Reachable on Vega, whose flow adapter keeps zero-area
    // nodes; iOS/Android/Chromium prune them.
    currentFetch = () => ({
      tree: screen([
        // The match itself, zero-area.
        n({ label: "Add more languages...", frame: { x: 0.1, y: 0.1, width: 0, height: 0 } }),
        // A look-alike elsewhere that the whole-tree walk would seize on.
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
    // Same selector, same screen: `exists` explained the miss and `text` said
    // nothing. The docstring justified the silence with "for `text` the element
    // WAS located" — which is exactly what did not happen here.
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
    // The card's hoisted string is a compat variant of the needle; no single
    // node's label is. A selector's `text` is compared against label/value
    // only, so quoting the hoisted string sent the author to a rewritten
    // selector that still matched nothing. Silence beats advice that cannot
    // work.
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
    // The other half: the hoisted string is not what makes the note useful,
    // the leaf's own label is — and that one a `text` selector can match.
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
    expect(result.steps[0].reason).toMatch(/does show "Add more languages…"/);
  });

  it("fires on a PARTIAL miss, the default comparator's own shape", async () => {
    // `contains` and a selector's `text` are substring tests, but the note only
    // ever asked whether the WHOLE strings were compat-variants — so under the
    // default comparator it could never fire.
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
    // An unbalanced U+202E in a label reverses every character printed after
    // it, so quoting screen text verbatim reverses the ~300 characters of
    // advice that follow. The label survives the fold on purpose — a control
    // that reorders is exactly what must not be stripped — so the message has
    // to defuse it instead. The selector here is plain, to isolate the quoted
    // SCREEN text as the source.
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
    // Defused AND named, so the author can see what is in their label.
    expect(result.steps[0].reason).toMatch(/<U\+202E>/);
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

    expect(result.steps[0].reason).toMatch(/does show "Add more languages…"/);
    expect(result.steps[0].reason).not.toMatch(/<U\+/);
  });

  it("neutralises it in the TEXT-miss reason, where the codepoint note follows", async () => {
    // The compat note was defused; the reason that quotes the located element's
    // own text on every `text` failure was not — and that is the one the
    // codepoint note is appended to, so an unbalanced U+202E reversed the whole
    // explanation rather than a short suffix.
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
    // The explanation it protects is still there, and still last.
    expect(result.steps[0].reason).toMatch(/REORDERS/);
  });
});

describe("a `matches` (regex) miss still explains an invisible it cannot see", () => {
  it("names the ignorable codepoints in the text the pattern was tested against", async () => {
    // `matches` is exempt from folding, from the confusable note and from the
    // compat note — so the ONE comparison mode the fold cannot rescue was the
    // one left with no explanation at all: two identical-looking strings and
    // nothing else.
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
    // Still no codepoint comparison AGAINST the pattern — that would describe a
    // mismatch that has nothing to do with the pattern that failed.
    expect(result.steps[0].reason).not.toMatch(/vs expected \[/);
  });

  it("names a bidi wrapper as REORDERING, never as an invisible character", async () => {
    // Its sibling refuses to describe the same code point that way, and for a
    // reason that holds here too: a directional control draws nothing but moves
    // the glyphs around it, so "invisible" is a false story about it.
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

  it("stays quiet when the ignorable is not why the pattern missed", async () => {
    // No relevance gate, and the note fired on ANY `matches` failure whose text
    // carried an ignorable. On an app that wraps every display name that is
    // every failing assertion against a name, and "the pattern must account for
    // them" then points at a wrapper the pattern never tripped over.
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
    // Removing the wrapper would not have matched "Alice Jones" either, so no
    // note. The `<U+202A>` still in the quoted label is quoteScreenText
    // defusing it, which is a separate job and must keep happening.
    expect(result.steps[0].reason).not.toMatch(/must account for/);
    expect(result.steps[0].reason).not.toMatch(/the text carries/);
    expect(result.steps[0].reason).toMatch(/<U\+202A>/);
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
    // Characterisation, not a defect: the blind-read guard treats any empty
    // tree after a match as untrustworthy, and folding enlarged the set of
    // labels a selector matches — so labels carrying an invisible now reach a
    // rule that plain ones always did. Verified identical on the pre-fold base
    // build with a plain "Sign in" label, so the escalation is the guard's, not
    // the fold's; this pins the interaction so a future change to either half
    // has to acknowledge the other.
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

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/could not confirm/);
  });

  it("still emits the miss note when the FINAL read went blind", async () => {
    // lastTree is only updated by a TRUSTED read, so a trailing degraded tree
    // must not wipe out the evidence the note draws on. The blip has to land
    // inside the dark-tail tolerance (2 poll intervals), or the verdict goes
    // indeterminate and there is no reason left to annotate — so go blind only
    // in the window's last stretch, keyed on elapsed time rather than a count.
    const started = Date.now();
    currentFetch = () => {
      if (Date.now() - started < 850) {
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
      // Empty AND flagged degraded — a blind read, whatever everMatched says.
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
    expect(result.steps[0].reason).toMatch(/does show "Add more languages…"/);
  });
});
