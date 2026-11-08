import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type {
  DescribeNode,
  DescribeSource,
  DescribeTreeData,
} from "../../src/tools/describe/contract";

// The iOS tests exercise the focus-wait's source gate (`ax-service` reports
// focus and is polled; a source that can't bails out of the poll) by stubbing
// the tree fetch with a tree tagged with that source. The Android test leaves
// `currentFetch` unset and drives the REAL fetch path: its tree comes from the
// android-devtools getHierarchy stub below.
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

function mockRegistry(calls: Call[], getHierarchy: () => { xml: string }): Registry {
  return {
    invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
      calls.push({ id, args, t: Date.now() });
      if (id === "list-devices") return { devices: [] };
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
    // (300ms) before read 4 confirmed focus. Lower bound only (an upper one
    // would price CI jitter), 10% under the sum because a setTimeout measured
    // on Date.now() can span a millisecond less than its delay — while losing
    // either wait costs the gap hundreds of them.
    expect(keys[0]!.t - tap!.t).toBeGreaterThanOrEqual(720);
  });

  /** An iOS screen with one email field, focused once `focusedFrom` reads have happened. */
  function stubIosTree(source: DescribeSource, focusedFrom: number): () => number {
    let reads = 0;
    currentFetch = () => {
      reads++;
      const field: DescribeNode = {
        role: "AXTextField",
        label: "Email",
        frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.06 },
        children: [],
        ...(reads >= focusedFrom ? { focused: true } : {}),
      };
      return {
        tree: { role: "AXWindow", frame: { x: 0, y: 0, width: 1, height: 1 }, children: [field] },
        source,
      };
    };
    return () => reads;
  }

  async function typeIntoEmail(): Promise<Call[]> {
    const calls: Call[] = [];
    await writeFlow("ax-login", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { text: "Email" }, text: "a@b.com", submit: false }],
    });
    const result = asRun(
      await createRunFlowTool(mockRegistry(calls, () => ({ xml: emailXml(false) }))).execute(
        {},
        { name: "ax-login", project_root: tmpDir, device: IOS_DEVICE }
      )
    );
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["type:pass"]);
    // submit: false — no trailing Enter.
    expect(calls.filter((c) => c.id === "keyboard").map((c) => c.args.text)).toEqual(["a@b.com"]);
    return calls;
  }

  /** Milliseconds from the focus tap to the first keystroke. */
  function tapToKeys(calls: Call[]): number {
    const tap = calls.find((c) => c.id === "gesture-tap")!;
    return calls.find((c) => c.id === "keyboard")!.t - tap.t;
  }

  it("polls the ax-service tree until the field reports focus (ios simulator)", async () => {
    // Reads 1-2: pre-tap settle. Read 3: the focus wait's first look (not yet
    // focused). Read 4 reports focus — only then may the keyboard fire.
    const reads = stubIosTree("ax-service", 4);

    const calls = await typeIntoEmail();

    expect(reads()).toBe(4);
    // Settle plus one poll interval; slack as in the android case.
    expect(tapToKeys(calls)).toBeGreaterThanOrEqual(720);
  });

  it("skips the focus poll on a source that can't report focus", async () => {
    // xcuitest-runner is excluded from the focus-reporting sources on purpose.
    const reads = stubIosTree("xcuitest-runner", Infinity);

    const calls = await typeIntoEmail();

    // Reads 1-2: pre-tap settle. Read 3: the focus wait's single look, after
    // which the source bails out instead of polling to the timeout.
    expect(reads()).toBe(3);
    // The fixed settle still applies even without a focus-reporting source:
    // skipping it alongside the poll leaves only the single tree read above, so
    // 10% of slack for the timer (see the case above) still pins the branch.
    expect(tapToKeys(calls)).toBeGreaterThanOrEqual(450);
  });
});
