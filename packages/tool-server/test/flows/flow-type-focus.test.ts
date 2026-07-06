import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// The iOS test drives the type step against the trimmed AX tree (a source that
// can't report focus) by mocking the one platform adapter, exactly like
// flow-scroll.test.ts. The Android test never reaches this mock — its tree
// comes from the android-devtools getHierarchy stub below.
let currentTree: () => DescribeNode;
vi.mock("../../src/tools/describe/platforms/ios", () => ({
  describeIos: vi.fn(
    async (): Promise<DescribeTreeData> => ({
      tree: currentTree(),
      source: "ax-service",
    })
  ),
}));

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
    // One service object serves both platforms' resolveService calls: the
    // Android flow tree reads getHierarchy/getScreenSize; the iOS run reads
    // the native-devtools connection state (none, so it falls back to the
    // mocked AX tree above).
    resolveService: vi.fn(async () => ({
      getHierarchy: vi.fn(async () => getHierarchy()),
      getScreenSize: vi.fn(async () => ({ width: 1080, height: 1920 })),
      isConnected: () => true,
      listConnectedBundleIds: () => [],
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
    // (300ms) before read 4 confirmed focus. setTimeout never fires early, so
    // the lower bound is safe to assert; no upper bound (CI jitter).
    expect(keys[0]!.t - tap!.t).toBeGreaterThanOrEqual(800);
  });

  it("skips the focus poll on a source that can't report focus (iOS AX tree)", async () => {
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
    expect(keys[0]!.t - tap!.t).toBeGreaterThanOrEqual(500);
  });
});
