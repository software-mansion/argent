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

async function run(name: string, ctx?: Partial<ToolContext>): Promise<FlowRunResult> {
  const tool = createRunFlowTool(mockRegistry());
  const result = await tool.execute(
    {},
    { name, project_root: tmpDir, device: DEVICE },
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
    expect(Buffer.byteLength(JSON.stringify(failure), "utf8")).toBeLessThan(
      FLOW_FAILURE_BYTE_LIMIT * 2
    );
  });

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
    // ~10 KB in, a field-sized string out. (The exact bound is the subject of
    // the pinned `it.fails` above — the ellipsis costs 2 bytes more than the
    // implementation reserves.)
    expect(Buffer.byteLength(node!.text!, "utf8")).toBeLessThan(FLOW_FAILURE_FIELD_BYTE_LIMIT + 8);
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
