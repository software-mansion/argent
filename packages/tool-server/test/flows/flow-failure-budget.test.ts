/**
 * Size and secret discipline for the failure payload.
 *
 * A failure report rides the `--json` output AND every NDJSON progress event,
 * and in CI it is uploaded as an artifact. So it is bounded at four layers —
 * projection, element cap, byte-accurate field cap, whole-payload budget with
 * spill — and it must never carry a resolved `{{secret:NAME}}` value or a
 * password field's contents.
 *
 * The caps are asserted against the exported constants rather than literals, so
 * retuning a budget updates the tests with it while a REMOVED cap still fails.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry, ToolContext } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

let currentFetch: () => DescribeTreeData | Promise<DescribeTreeData>;
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => currentFetch()),
}));

import { ArtifactStore } from "../../src/artifacts";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";
import {
  truncateUtf8Field,
  FLOW_FAILURE_BYTE_LIMIT,
  FLOW_FAILURE_CANDIDATE_LIMIT,
  FLOW_FAILURE_ELEMENT_LIMIT,
  FLOW_FAILURE_FIELD_BYTE_LIMIT,
  type FlowFailureScreen,
  type FlowStepFailure,
} from "../../src/tools/flows/flow-failure";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
/** A second device, for the cases that must NOT inherit {@link DEVICE}'s secret latch. */
const CLEAN_DEVICE = "00000000-0000-0000-0000-0000000000cd";
const SECRET_ENV = "ARGENT_SECRET_TESTPW";
const SECRET_VALUE = "hunter2-correct-horse-battery-staple";
let tmpDir: string;
let previousSecret: string | undefined;

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
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
}

async function writeFlow(name: string, flow: Parameters<typeof serializeFlow>[0]): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), serializeFlow(flow), "utf8");
}

async function run(
  name: string,
  ctx?: Partial<ToolContext>,
  // The secret-screenshot guard latches on the DEVICE and is never cleared, so
  // a test that must run un-guarded needs a device nothing has typed onto —
  // which is the production rule, not a test workaround.
  device: string = DEVICE
): Promise<FlowRunResult> {
  const tool = createRunFlowTool(mockRegistry());
  const result = await tool.execute(
    {},
    { name, project_root: tmpDir, device },
    ctx as ToolContext | undefined
  );
  if (!("steps" in result)) throw new Error(`expected a run result, got notice: ${result.notice}`);
  return result;
}

function singleFailure(result: FlowRunResult): FlowStepFailure {
  const carrying = result.steps.filter((s) => s.failure !== undefined);
  expect(carrying).toHaveLength(1);
  return carrying[0]!.failure!;
}

function available(s: FlowFailureScreen): Extract<FlowFailureScreen, { state: "available" }> {
  if (s.state !== "available") {
    throw new Error(`expected an available screen, got ${JSON.stringify(s)}`);
  }
  return s;
}

/** A flow whose only step is an assert that cannot hold — the failure vehicle. */
async function missingAssert(name: string): Promise<void> {
  await writeFlow(name, {
    executionPrerequisite: "",
    steps: [{ kind: "assert", condition: "exists", selector: { text: "Nothing Here" } }],
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-failure-budget-"));
  previousSecret = process.env[SECRET_ENV];
  delete process.env[SECRET_ENV];
  currentFetch = () => ({ tree: screen([]), source: "native-devtools" });
});
afterEach(async () => {
  // Restore the ambient environment exactly — the scrubber reads process.env on
  // every assembly, so a leaked variable would quietly rewrite other suites.
  if (previousSecret === undefined) delete process.env[SECRET_ENV];
  else process.env[SECRET_ENV] = previousSecret;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Element cap ────────────────────────────────────────────────────────────

describe("element budget", () => {
  it("caps the element list while reporting the TRUE total", async () => {
    const rows = Array.from({ length: 500 }, (_, i) =>
      n({
        role: "AXStaticText",
        label: `Row ${i}`,
        frame: { x: 0.05, y: i / 600, width: 0.9, height: 0.001 },
      })
    );
    currentFetch = () => ({ tree: screen(rows), source: "native-devtools" });
    await missingAssert("big");

    const failure = singleFailure(await run("big"));
    const shown = available(failure.screen);

    expect(shown.elements).toHaveLength(FLOW_FAILURE_ELEMENT_LIMIT);
    // The count is what the screen HAD, not what the report kept — "40 of 500"
    // is actionable, "40 elements" is a lie.
    expect(shown.elementCount).toBe(500);
    expect(shown.truncated).toBe(true);
    // Reading order, so the kept subset is the top of the screen.
    expect(shown.elements[0]!.label).toBe("Row 0");
  });

  it("omits `truncated` when the whole screen fit", async () => {
    currentFetch = () => ({
      tree: screen([n({ label: "Only row", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 } })]),
      source: "native-devtools",
    });
    await missingAssert("small");

    const shown = available(singleFailure(await run("small")).screen);

    expect(shown.elementCount).toBe(1);
    expect(shown.elements).toHaveLength(1);
    expect(shown.truncated).toBeUndefined();
  });
});

// ── Whole-payload budget and spill ─────────────────────────────────────────

/** 40 elements whose every text field is at the field cap — deliberately oversize. */
function bulkyTree(): DescribeNode {
  const filler = (seed: string): string => seed.repeat(400).slice(0, 400);
  return screen(
    Array.from({ length: FLOW_FAILURE_ELEMENT_LIMIT }, (_, i) =>
      n({
        role: "AXStaticText",
        identifier: `id-${i}-${filler("i")}`,
        label: `label-${i}-${filler("l")}`,
        value: `value-${i}-${filler("v")}`,
        subtreeText: `subtree-${i}-${filler("s")}`,
        frame: { x: 0.05, y: i / 100, width: 0.9, height: 0.005 },
      })
    )
  );
}

describe("payload byte budget", () => {
  it("spills the element list when the payload goes over budget", async () => {
    currentFetch = () => ({ tree: bulkyTree(), source: "native-devtools" });
    await missingAssert("bulky");

    const failure = singleFailure(await run("bulky"));

    expect(failure.screen).toMatchObject({
      state: "unavailable",
      reason: "omitted-for-size",
    });
    expect(failure.overflow?.omittedBytes).toBeGreaterThan(0);
    // Without an artifact store there is nowhere to spill TO — the report says
    // the detail was dropped rather than pretending it wasn't.
    expect(failure.overflow?.artifact).toBeUndefined();
    // What makes the report actionable survives the trim.
    expect(failure.code).toBe("selector-not-found");
    expect(failure.message.length).toBeGreaterThan(0);
    expect(failure.selector?.described).toContain("Nothing Here");
    // The BUDGET, not twice it. `* 2` accepted a 47 KB payload from a 24 KB
    // cap — and this is the only assertion on the trimmed size, so it was the
    // only thing standing between the shedding loop and no bound at all.
    expect(Buffer.byteLength(JSON.stringify(failure), "utf8")).toBeLessThanOrEqual(
      FLOW_FAILURE_BYTE_LIMIT
    );
  });

  it("caps `hint`, the one scrubbed field that had no byte bound", async () => {
    // `baseFailure` capped `message`, `step.target` and `cause.message` but not
    // `hint` — and `evidence.hint` is not always a literal: it can be the tree
    // adapter's own prose, arriving over the registry. `trimToBudget` cannot
    // shed it, so an unbounded one rode every NDJSON progress event.
    // A BLIND read is the shape that carries adapter prose: an empty tree plus
    // the source's own hint, which `degraded()` copies straight onto
    // `evidence.hint`.
    const huge = "z".repeat(50_000);
    currentFetch = () => ({ tree: screen([]), source: "native-devtools", hint: huge });
    await writeFlow("huge-hint", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "exists", selector: { text: "Nothing Here" } }],
    });

    const failure = singleFailure(await run("huge-hint"));

    expect(failure.hint).toBeDefined();
    expect(Buffer.byteLength(failure.hint!, "utf8")).toBeLessThanOrEqual(
      FLOW_FAILURE_FIELD_BYTE_LIMIT
    );
    // Whatever the shape, the whole payload still fits.
    expect(Buffer.byteLength(JSON.stringify(failure), "utf8")).toBeLessThanOrEqual(
      FLOW_FAILURE_BYTE_LIMIT
    );
  }, 20_000);

  it("registers the full payload as an artifact when a store is available", async () => {
    currentFetch = () => ({ tree: bulkyTree(), source: "native-devtools" });
    await missingAssert("bulky-store");

    const failure = singleFailure(await run("bulky-store", { artifacts: new ArtifactStore() }));

    const artifact = failure.overflow?.artifact;
    expect(artifact).toBeDefined();
    expect(artifact!.mimeType).toBe("application/json");
    // Nothing is actually lost: the spilled file parses back to a full payload
    // carrying the element list the wire report dropped.
    const spilled = JSON.parse(await fs.readFile(artifact!.hostPath, "utf8")) as FlowStepFailure;
    expect(available(spilled.screen).elements).toHaveLength(FLOW_FAILURE_ELEMENT_LIMIT);
    // The handle is attached AFTER `trimToBudget` took its final measurement,
    // so the budget has to reserve room for it — otherwise the payload declared
    // to fit shipped a few hundred unmeasured bytes over the cap.
    expect(Buffer.byteLength(JSON.stringify(failure), "utf8")).toBeLessThanOrEqual(
      FLOW_FAILURE_BYTE_LIMIT
    );
  });
});

// ── UTF-8 field cap ────────────────────────────────────────────────────────

describe("truncateUtf8Field", () => {
  const MULTIBYTE = "🙂漢字ñ".repeat(2000); // ~10 KB of 2-, 3- and 4-byte codepoints

  it("never splits a codepoint, whatever the limit", () => {
    for (const limit of [1, 2, 3, 4, 5, 7, 16, 31, 64, 255, 256, 1024]) {
      const out = truncateUtf8Field(MULTIBYTE, limit);
      // A split codepoint shows up as U+FFFD on the way back through UTF-8;
      // the input has none, so any replacement char is damage we caused.
      expect(out, `limit ${limit}`).not.toContain("�");
      expect(Buffer.from(out, "utf8").toString("utf8"), `limit ${limit}`).toBe(out);
      // No lone surrogate survived the cut.
      expect(
        [...out].every((ch) => ch.codePointAt(0)! < 0xd800 || ch.codePointAt(0)! > 0xdfff),
        `limit ${limit}`
      ).toBe(true);
    }
  });

  /**
   * The regression this guards: the ellipsis is U+2026 — THREE UTF-8 bytes,
   * not one. Reserving a single byte for it overshoots `limit` by two on every
   * truncation, which is precisely what a byte-denominated budget cannot
   * afford. Checked at all three limits the call sites use, over inputs whose
   * codepoint widths land the cut in different places.
   */
  it("is byte-accurate to the documented limit", () => {
    for (const limit of [1, 2, 3, 4, 5, 7, 16, 64, FLOW_FAILURE_FIELD_BYTE_LIMIT, 512]) {
      for (const seed of ["a", "ñ", "漢", "🙂", "🙂漢字ñ", "abc🙂"]) {
        const out = truncateUtf8Field(seed.repeat(2000), limit);
        expect(
          Buffer.byteLength(out, "utf8"),
          `limit ${limit}, seed ${JSON.stringify(seed)}`
        ).toBeLessThanOrEqual(limit);
      }
    }
  });

  it("spends a marker-sized budget on content instead of the marker", () => {
    // A limit too small to hold "…" plus anything is the one case where the
    // marker cannot be afforded: emitting it would blow the budget it exists
    // to respect, so the whole budget goes to content.
    for (const limit of [1, 2, 3]) {
      const ascii = truncateUtf8Field("abcdef", limit);
      expect(ascii, `limit ${limit}`).not.toContain("…");
      expect(Buffer.byteLength(ascii, "utf8"), `limit ${limit}`).toBeLessThanOrEqual(limit);
      expect(ascii).toBe("abcdef".slice(0, limit));
      // Multi-byte content that cannot fit at all comes back empty rather than
      // as a split codepoint.
      const wide = truncateUtf8Field("🙂🙂", limit);
      expect(wide, `limit ${limit}`).toBe("");
    }
  });

  it("returns short values untouched and marks truncated ones", () => {
    expect(truncateUtf8Field("plain", 256)).toBe("plain");
    expect(truncateUtf8Field("🙂", 4)).toBe("🙂"); // exactly 4 bytes — fits
    expect(truncateUtf8Field(MULTIBYTE).endsWith("…")).toBe(true);
    expect(Buffer.byteLength(truncateUtf8Field(MULTIBYTE), "utf8")).toBeLessThanOrEqual(
      FLOW_FAILURE_FIELD_BYTE_LIMIT
    );
  });

  it("caps a screen-wide subtreeText on the wire without mangling it", async () => {
    currentFetch = () => ({
      tree: screen([
        n({
          identifier: "wall-of-text",
          subtreeText: MULTIBYTE,
          frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.4 },
        }),
      ]),
      source: "native-devtools",
    });
    await missingAssert("longtext");

    const shown = available(singleFailure(await run("longtext")).screen);
    const node = shown.elements.find((e) => e.identifier === "wall-of-text");

    expect(node?.text).toBeDefined();
    // ~10 KB in, a field-sized string out — AT the cap, not eight bytes past
    // it. The slack cited an `it.fails` that no longer exists: the ellipsis
    // accounting it excused was fixed, and byte accuracy is pinned directly by
    // "is byte-accurate to the documented limit" above.
    expect(Buffer.byteLength(node!.text!, "utf8")).toBeLessThanOrEqual(
      FLOW_FAILURE_FIELD_BYTE_LIMIT
    );
    expect(node!.text).not.toContain("�");
    expect(Buffer.from(node!.text!, "utf8").toString("utf8")).toBe(node!.text);
    expect(node!.text!.startsWith("🙂漢字ñ")).toBe(true);
  });
});

// ── Candidate cap ──────────────────────────────────────────────────────────

describe("candidate budget", () => {
  it("caps the suggestions while reporting how many there were", async () => {
    currentFetch = () => ({
      tree: screen(
        Array.from({ length: 20 }, (_, i) =>
          n({
            role: "AXButton",
            label: `Chekout ${i}`,
            frame: { x: 0.05, y: i / 40, width: 0.9, height: 0.02 },
            clickable: true,
          })
        )
      ),
      source: "native-devtools",
    });
    await writeFlow("many-candidates", {
      executionPrerequisite: "",
      // Near-misses, not substrings: a `text` selector matches by containment,
      // so "Checkout 0" would have SATISFIED the assert.
      steps: [{ kind: "assert", condition: "exists", selector: { text: "Checkout" } }],
    });

    const failure = singleFailure(await run("many-candidates"));

    expect(failure.candidates.length).toBeLessThanOrEqual(FLOW_FAILURE_CANDIDATE_LIMIT);
    expect(failure.candidates).toHaveLength(FLOW_FAILURE_CANDIDATE_LIMIT);
    expect(failure.candidateCount).toBe(20);
  });
});

// ── Reason / message parity ───────────────────────────────────────────────

describe("the message cap", () => {
  it("caps `reason` with `message`, so the two stay byte-identical", () => {
    // Both copies ship on every NDJSON progress event, so capping only one
    // bounds nothing — and the invariant every renderer relies on
    // (`failure.message` byte-identical to `reason`) then held everywhere
    // EXCEPT the one case the cap exists for.
    //
    // The vehicle is a container whose hoisted `subtreeText` is the whole
    // screen's text, which is what `assertReason` quotes.
    const huge = "the quick brown fox jumps over the lazy dog. ".repeat(6000);
    currentFetch = () => ({
      tree: screen([
        n({
          identifier: "page",
          label: "Page",
          subtreeText: huge,
          frame: { x: 0, y: 0, width: 1, height: 1 },
        }),
      ]),
      source: "native-devtools",
    });
    return (async () => {
      await writeFlow("huge-reason", {
        executionPrerequisite: "",
        steps: [
          {
            kind: "assert",
            condition: "text",
            selector: { identifier: "page" },
            expectedText: "Done",
            textMatch: "equals",
          },
        ],
      });

      const result = await run("huge-reason");
      const step = result.steps.find((s) => s.failure !== undefined)!;
      const failure = step.failure!;

      expect(Buffer.byteLength(huge, "utf8")).toBeGreaterThan(200_000);
      expect(failure.message).toBe(step.reason);
      // Both land under the cap, marker included.
      expect(Buffer.byteLength(step.reason!, "utf8")).toBeLessThanOrEqual(4 * 1024);
      expect(step.reason!.endsWith("\u2026")).toBe(true);
    })();
  });
});

// ── Secrets ────────────────────────────────────────────────────────────────

describe("secret discipline", () => {
  it("never lets a resolved secret — or a password value — reach any field", async () => {
    process.env[SECRET_ENV] = SECRET_VALUE;
    // The app echoed the typed credential back into a plain label (the case the
    // scrubber exists for), and a password field holds it as its value.
    currentFetch = () => ({
      tree: screen([
        n({
          identifier: "echoed",
          label: SECRET_VALUE,
          subtreeText: `signed in as ${SECRET_VALUE}`,
          frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 },
        }),
        n({
          identifier: "password-field",
          value: SECRET_VALUE,
          password: true,
          frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.05 },
        }),
      ]),
      source: "native-devtools",
    });
    await writeFlow("secret-screen", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "exists", selector: { identifier: "checkout-cta" } }],
    });

    const failure = singleFailure(await run("secret-screen"));

    const serialized = JSON.stringify(failure);
    expect(serialized).not.toContain(SECRET_VALUE);
    expect(serialized).toContain("«secret:TESTPW»");
    const shown = available(failure.screen);
    const echoed = shown.elements.find((e) => e.identifier === "echoed");
    expect(echoed?.label).toBe("«secret:TESTPW»");
    expect(echoed?.text).toBe("signed in as «secret:TESTPW»");
    // A password field's value is never projected at all: the scrubber only
    // knows the secrets THIS run exposed, and a user-typed credential is not
    // one of them.
    const pw = shown.elements.find((e) => e.identifier === "password-field");
    expect(pw?.value).toBe("«redacted»");
  });

  /** A step whose SELECTOR carries the secret value, so it reaches the prose. */
  async function runSecretSelectorFlow(name: string): Promise<FlowStepFailure> {
    process.env[SECRET_ENV] = SECRET_VALUE;
    currentFetch = () => ({
      tree: screen([n({ label: "Sign in", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 } })]),
      source: "native-devtools",
    });
    await writeFlow(name, {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "exists", selector: { text: SECRET_VALUE } }],
    });
    return singleFailure(await run(name));
  }

  it("scrubs the secret out of the message, the target and the selector fields", async () => {
    const failure = await runSecretSelectorFlow("secret-selector");

    expect(failure.message).toContain("«secret:TESTPW»");
    expect(failure.message).not.toContain(SECRET_VALUE);
    expect(failure.selector?.described).toContain("«secret:TESTPW»");
    expect(failure.selector?.described).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(failure.selector?.fields)).toContain("«secret:TESTPW»");
    expect(JSON.stringify(failure.selector?.fields)).not.toContain(SECRET_VALUE);
    expect(failure.step.target).not.toContain(SECRET_VALUE);
  });

  it("keeps a resolved secret out of EVERY field of the payload", async () => {
    // `selector.alternatives` is the trap here: it is the selector's own
    // fields re-spelled by the resolution expansion, so a value masked in
    // `described` and `fields` rides out beside them unless it is scrubbed
    // too. Serializing the whole object is the only assertion that cannot be
    // outrun by a new field.
    const failure = await runSecretSelectorFlow("secret-selector-all");

    expect(JSON.stringify(failure)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(failure.selector?.alternatives)).toContain("«secret:TESTPW»");
  });

  it("masks a secret that comes from a secrets FILE, not just the environment", async () => {
    // The defect this pins: the scrubber used to read `ARGENT_SECRET_*` off
    // `process.env` alone, while `{{secret:NAME}}` resolves through the whole
    // four-source chain — so the placement `secretPlacementAdvice` recommends
    // FIRST (`~/.argent/secrets.env`) was the one placement the report leaked.
    // No `ARGENT_SECRET_*` variable is set here; the value exists only on disk.
    const previousHome = process.env.HOME;
    await fs.mkdir(path.join(tmpDir, ".argent"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".argent", "secrets.env"), `TESTPW=${SECRET_VALUE}\n`);
    process.env.HOME = tmpDir;
    try {
      currentFetch = () => ({
        tree: screen([
          n({
            identifier: "echoed",
            label: `signed in as ${SECRET_VALUE}`,
            frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 },
          }),
        ]),
        source: "native-devtools",
      });
      await missingAssert("secret-from-file");

      const failure = singleFailure(await run("secret-from-file"));

      expect(JSON.stringify(failure)).not.toContain(SECRET_VALUE);
      expect(available(failure.screen).elements[0]!.label).toBe("signed in as «secret:TESTPW»");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it("declines the failure SCREENSHOT once the run has typed a secret", async () => {
    // Independent of the scrubber: pixels are never masked, so an app that
    // renders a credential back into a non-password field puts it in
    // `step-NN-screen.png` under `--output` and inlines it into the agent's
    // context — even when every string in the report came out correctly
    // masked. The MCP layer already declines this exact capture after a
    // `{{secret:…}}` tool call.
    process.env[SECRET_ENV] = SECRET_VALUE;
    currentFetch = () => ({
      tree: screen([n({ identifier: "pw", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 } })]),
      source: "native-devtools",
    });
    await writeFlow("secret-shot", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "pw" }, text: "{{secret:TESTPW}}", submit: false },
        { kind: "assert", condition: "exists", selector: { identifier: "checkout-cta" } },
      ],
    });

    const failure = singleFailure(await run("secret-shot", { artifacts: new ArtifactStore() }));

    expect(failure.screenshot).toBeUndefined();
    // Said in words rather than silently omitted — an agent that just sees a
    // missing image calls `screenshot` itself, which is the leak this prevents.
    expect(failure.data?.screenshotOmitted).toBe("secret-typed");
    // Everything the mask CAN protect is still captured.
    expect(failure.screen.state).toBe("available");
    expect(failure.tree?.mimeType).toBe("text/plain");
  });

  it("declines the screenshot for a LATER run that typed nothing, on the same device", async () => {
    // The guard's scope has to match the screen's. A credential one flow typed
    // is still rendered when the next flow runs against that device — and a
    // flow with no leading `launch:` runs against whatever is on screen by
    // design, which is exactly what a directory run does, flow after flow, on
    // one device. Scoped to a single `flow-execute` invocation, the guard
    // closed the leak only for the run that caused it: the very next run
    // captured the same screen and `--output` exported it.
    process.env[SECRET_ENV] = SECRET_VALUE;
    currentFetch = () => ({
      tree: screen([n({ identifier: "pw", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 } })]),
      source: "native-devtools",
    });
    await writeFlow("types-it", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "pw" }, text: "{{secret:TESTPW}}", submit: false },
      ],
    });
    await writeFlow("types-nothing", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "exists", selector: { identifier: "checkout-cta" } }],
    });
    // A THIRD device id, so this pair is independent of every other test here.
    const shared = "00000000-0000-0000-0000-0000000000ef";

    await run("types-it", { artifacts: new ArtifactStore() }, shared);
    const later = singleFailure(
      await run("types-nothing", { artifacts: new ArtifactStore() }, shared)
    );

    expect(later.screenshot).toBeUndefined();
    expect(later.data?.screenshotOmitted).toBe("secret-typed");
    // A DIFFERENT device is untouched by the latch — the guard is scoped to the
    // screen that carries the credential, not to the whole process.
    await writeFlow("elsewhere", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "exists", selector: { identifier: "checkout-cta" } }],
    });
    const other = singleFailure(
      await run("elsewhere", { artifacts: new ArtifactStore() }, CLEAN_DEVICE)
    );
    // The harness's registry answers `screenshot` with `{ ok: true }` and no
    // image, so the capture is ATTEMPTED and comes back empty — which is a
    // different reason from "argent declined it", and the point is that the
    // secret latch did not follow the run onto a device it never touched.
    expect(other.data?.screenshotOmitted).toBe("capture-failed");
    // Three runs, two of which spend an assert grace window.
  }, 30_000);

  it("marks the secret omission on EVERY payload, including a degraded one", async () => {
    // `data.screenshotOmitted` is the only signal a renderer has that the run
    // typed a secret — `typedSecret` is run state and never reaches the wire.
    // Setting it inside `buildFailure` left it absent from the two payloads
    // `baseFailure` produces alone (the capture-timeout fallback with nothing
    // assembled, and the assembly-threw catch), so a snapshot failure on a
    // slow screen shipped a payload that looked like an ordinary one — and the
    // MCP renderer then inlined the snapshot's own image.
    process.env[SECRET_ENV] = SECRET_VALUE;
    // Overrun the whole capture inside the FIRST phase, so no partial exists.
    currentFetch = () => new Promise<DescribeTreeData>(() => {});
    // An `echo` latches the run's secret flag without needing a device read —
    // the latch is a scan of the step itself, so any step carrying the marker
    // sets it — and a `run:` to a missing fragment then fails FAST and with no
    // tree of its own, which is what sends the assembler to the post-hoc read
    // that never returns. A directive would instead hang on that same read.
    await writeFlow("secret-degraded", {
      executionPrerequisite: "",
      steps: [
        { kind: "echo", message: "signing in with {{secret:TESTPW}}" },
        { kind: "run", flow: "not-on-disk" },
      ],
    });

    const failure = singleFailure(await run("secret-degraded", { artifacts: new ArtifactStore() }));

    expect(failure.screen.state).toBe("unavailable");
    expect(failure.data?.screenshotOmitted).toBe("secret-typed");
    expect(failure.screenshot).toBeUndefined();
  }, 20_000);

  it("keeps an over-budget payload under the cap WITH the secret marker on it", async () => {
    // Pins the ORDER, not a bug anyone has hit: the marker is ~35 bytes and the
    // shedding loop leaves a trimmed payload far below the cap, so stamping it
    // afterwards does not cross the limit today. It is set in `baseFailure`
    // anyway, before anything measures, so the invariant holds by construction
    // rather than by how much the current shedding order happens to drop.
    process.env[SECRET_ENV] = SECRET_VALUE;
    currentFetch = () => ({ tree: bulkyTree(), source: "native-devtools" });
    await writeFlow("secret-bulky", {
      executionPrerequisite: "",
      steps: [
        { kind: "echo", message: "signing in with {{secret:TESTPW}}" },
        { kind: "assert", condition: "exists", selector: { text: "Nothing Here" } },
      ],
    });

    const failure = singleFailure(await run("secret-bulky"));

    expect(failure.data?.screenshotOmitted).toBe("secret-typed");
    expect(failure.overflow?.omittedBytes).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(failure), "utf8")).toBeLessThanOrEqual(
      FLOW_FAILURE_BYTE_LIMIT
    );
  });

  it("attempts the capture on a device nothing has typed a secret onto", async () => {
    await writeFlow("no-secret-shot", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "exists", selector: { identifier: "checkout-cta" } }],
    });

    const failure = singleFailure(
      await run("no-secret-shot", { artifacts: new ArtifactStore() }, CLEAN_DEVICE)
    );

    // Attempted, not declined: the harness's `screenshot` returns `{ ok: true }`
    // with no image, so the reason is the device's, not the guard's.
    expect(failure.data?.screenshotOmitted).toBe("capture-failed");
    expect(failure.tree?.mimeType).toBe("text/plain");
  });

  it("leaves the report alone when no secret is exposed", async () => {
    currentFetch = () => ({
      tree: screen([
        n({ label: "hunter2-correct-horse", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 } }),
      ]),
      source: "native-devtools",
    });
    await missingAssert("no-secret");

    const shown = available(singleFailure(await run("no-secret")).screen);

    expect(shown.elements[0]!.label).toBe("hunter2-correct-horse");
  });
});
