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
    // U+110BD (KAITHI NUMBER SIGN, category Cf) is not one of the fold's
    // explicit classes, so it does NOT fold away — the check fails against two
    // strings that read identically on screen. The reason must say which
    // codepoints differ, not quote the same text twice (confusableTextNote,
    // reached only through assertReason, which nothing else exercised end-to-end).
    currentFetch = () => ({
      tree: screen([
        n({
          identifier: "amount",
          label: "PLN 42\u{110BD}",
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
    expect(result.steps[0].reason).toMatch(/U\+110BD/);
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
});
