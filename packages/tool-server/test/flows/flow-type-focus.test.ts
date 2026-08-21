import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// The iOS test exercises the focus-wait's source gate (a source that can't
// report focus bails out of the poll) by stubbing the tree fetch with an
// `ax-service`-tagged tree — flows no longer degrade to that source on their
// own, so the stub is the only way to present it. The Android test leaves
// `currentFetch` unset and drives the REAL fetch path: its tree comes from the
// android-devtools getHierarchy stub below.
let currentTree: () => DescribeNode;
let currentFetch: (() => DescribeTreeData) | undefined;
vi.mock("../../src/tools/flows/flow-tree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/flows/flow-tree")>();
  return {
    fetchFlowTree: vi.fn(async (...args: Parameters<typeof actual.fetchFlowTree>) =>
      currentFetch ? currentFetch() : actual.fetchFlowTree(...args)
    ),
  };
});

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

const ANDROID_DEVICE = "emulator-5554";
const IOS_DEVICE = "00000000-0000-0000-0000-0000000000ab";
let tmpDir: string;

interface Call {
  id: string;
  args: Record<string, unknown>;
  t: number;
}

const emailXml = (focused: boolean) => `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.EditText" resource-id="email" focused="${focused}" package="com.acme.app" bounds="[40,200][1040,280]" />
  </node>
</hierarchy>`;

function mockRegistry(
  calls: Call[],
  getHierarchy: () => { xml: string },
  keyboardResult?: (args: Record<string, unknown>) => Record<string, unknown>
): Registry {
  return {
    invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
      calls.push({ id, args, t: Date.now() });
      if (id === "list-devices") return { devices: [] };
      if (id === "keyboard" && keyboardResult) return keyboardResult(args);
      return { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    // The Android flow tree reads getHierarchy/getScreenSize off the resolved
    // android-devtools service; the iOS test never resolves a service (its
    // tree fetch is stubbed via `currentFetch`).
    resolveService: vi.fn(async () => ({
      getHierarchy: vi.fn(async () => getHierarchy()),
      getScreenSize: vi.fn(async () => ({ width: 1080, height: 1920 })),
    })),
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

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-type-"));
  currentFetch = undefined;
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/**
 * Slack for the two clocks these timing assertions straddle. The waits are
 * `setTimeout`, scheduled on libuv's monotonic clock and rounded to whole
 * milliseconds; the stamps above are `Date.now()`, off the wall clock. The two
 * drift, so a 500ms sleep is routinely observed as a 499ms gap — which failed
 * this suite on CI (2026-07-31) against a lower bound that assumed a timer
 * never fires early.
 *
 * Small on purpose: what these assertions pin is that the settle happened at
 * all, and skipping it leaves a gap near zero.
 */
const CLOCK_SKEW_MS = 10;

describe("type directive focus wait", () => {
  it("waits for the tapped field to report focus before typing (android)", async () => {
    // Script the hierarchy by call count: reads 1-2 are the pre-tap settle
    // (identical, unfocused), read 3 is the focus poll's first look (focus not
    // landed yet), read 4 reports it — only then may the keyboard fire.
    let hierarchyReads = 0;
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => {
      hierarchyReads++;
      return { xml: emailXml(hierarchyReads >= 4) };
    });

    await writeFlow("login", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "a@b.com" }],
    });

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "login", project_root: tmpDir, device: ANDROID_DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["type:pass"]);
    expect(hierarchyReads).toBe(4);

    const tap = calls.find((c) => c.id === "gesture-tap");
    const keys = calls.filter((c) => c.id === "keyboard");
    expect(tap).toBeDefined();
    // Text first, then the submitting Enter as a separate call.
    expect(keys.map((c) => c.args.text ?? c.args.key)).toEqual(["a@b.com", "enter"]);
    // The gap covers the fixed settle (500ms) plus at least one poll interval
    // (300ms) before read 4 confirmed focus. No upper bound (CI jitter), and
    // the lower one allows for CLOCK_SKEW_MS.
    expect(keys[0]!.t - tap!.t).toBeGreaterThanOrEqual(800 - CLOCK_SKEW_MS);
  });

  it("skips the focus poll on a source that can't report focus", async () => {
    let axReads = 0;
    currentTree = () => {
      axReads++;
      return {
        role: "AXWindow",
        frame: { x: 0, y: 0, width: 1, height: 1 },
        children: [
          {
            role: "AXTextField",
            label: "Email",
            frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.06 },
            children: [],
          },
        ],
      };
    };
    currentFetch = () => ({ tree: currentTree(), source: "ax-service" });
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: emailXml(false) }));

    await writeFlow("ax-login", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { text: "Email" }, text: "a@b.com", submit: false }],
    });

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "ax-login", project_root: tmpDir, device: IOS_DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["type:pass"]);
    // Reads 1-2: pre-tap settle. Read 3: the focus wait's single look, after
    // which the ax-service source bails out instead of polling to the timeout.
    expect(axReads).toBe(3);

    const tap = calls.find((c) => c.id === "gesture-tap");
    const keys = calls.filter((c) => c.id === "keyboard");
    // submit: false — no trailing Enter.
    expect(keys.map((c) => c.args.text)).toEqual(["a@b.com"]);
    // The fixed settle still applies even without a focus-reporting source.
    expect(keys[0]!.t - tap!.t).toBeGreaterThanOrEqual(500 - CLOCK_SKEW_MS);
  });
});

describe("type directive — the keyboard tool's read-back verdict", () => {
  // `keyboard` on an Android phone reads the field back and reports
  // `verified: false` when the text demonstrably did not land. A flow step that
  // ignored that would green a `type` for text that typed something else — the
  // same silent success the read-back exists to end, one layer up.
  const focusedEmail = () => ({ xml: emailXml(true) });

  it("fails the step when the keyboard reports the text did not land", async () => {
    const calls: Call[] = [];
    const registry = mockRegistry(calls, focusedEmail, (args) =>
      args.text === undefined
        ? { typed: "enter", keys: 1 }
        : {
            typed: String(args.text),
            keys: 7,
            verified: false,
            note: "it holds 3 characters where 7 were expected",
          }
    );

    await writeFlow("bad-type", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "a@b.com" }],
    });

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "bad-type", project_root: tmpDir, device: ANDROID_DEVICE }
      )
    );

    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["type:fail"]);
    // The tool's own note becomes the step's reason, so the report says what the
    // field actually held instead of a generic "type failed".
    expect(result.steps[0]!.reason).toContain("it holds 3 characters where 7 were expected");
    // And the submitting Enter must NOT fire: submitting a field holding the
    // wrong value is worse than not submitting at all.
    expect(calls.filter((c) => c.id === "keyboard").map((c) => c.args.key ?? c.args.text)).toEqual([
      "a@b.com",
    ]);
  });

  it("passes the step when `verified` is absent — not checked is not failed", async () => {
    // Every non-Android backend, and any Android call whose read-back could not
    // conclude, returns no `verified`. Treating that as failure would break iOS,
    // Chromium, Vega and every device without the android-devtools helper.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, focusedEmail, (args) => ({
      typed: String(args.text ?? args.key),
      keys: 7,
      note: "The typed text was not verified against the screen: ...",
    }));

    await writeFlow("unverified-type", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "a@b.com" }],
    });

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "unverified-type", project_root: tmpDir, device: ANDROID_DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["type:pass"]);
    expect(calls.filter((c) => c.id === "keyboard").map((c) => c.args.key ?? c.args.text)).toEqual([
      "a@b.com",
      "enter",
    ]);
  });

  it("passes the step when the keyboard verifies the text", async () => {
    const calls: Call[] = [];
    const registry = mockRegistry(calls, focusedEmail, (args) => ({
      typed: String(args.text ?? args.key),
      keys: 7,
      verified: true,
    }));

    await writeFlow("good-type", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "a@b.com", submit: false }],
    });

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "good-type", project_root: tmpDir, device: ANDROID_DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["type:pass"]);
  });
});
