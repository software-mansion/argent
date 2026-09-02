import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

// The android-devtools helper stops at a node count or a tree depth and says so.
// A capture it stopped short of reads as an ordinary one — a full tree of text
// with content missing off the end of the walk — so `assert { hidden }`, the one
// directive that concludes something is NOT there, must not resolve on it. This
// drives the real flow tree: only `getHierarchy` is stubbed.

const ANDROID_DEVICE = "emulator-5554";
let tmpDir: string;

// The row the assert looks for is absent from every capture below; only the
// `truncated` flag separates "it left the screen" from "the walk stopped".
const PARTIAL_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.TextView" package="com.acme.app" text="Header" bounds="[0,0][1080,120]" />
  </node>
</hierarchy>`;

function mockRegistry(truncated: boolean): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "list-devices") return { devices: [] };
      return { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    resolveService: vi.fn(async () => ({
      getHierarchy: vi.fn(async () => ({ xml: PARTIAL_XML, truncated })),
      getScreenSize: vi.fn(async () => ({ width: 1080, height: 1920 })),
    })),
  } as unknown as Registry;
}

async function writeHiddenAssert(): Promise<void> {
  await writeAssert({
    kind: "assert",
    condition: "hidden",
    selector: { identifier: "cart-badge" },
  });
}

async function writeAssert(step: Record<string, unknown>): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "gone.yaml"),
    serializeFlow({
      executionPrerequisite: "",
      steps: [step as never],
    }),
    "utf8"
  );
}

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-partial-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("a partial Android capture in a flow", () => {
  it("does not let `assert { hidden }` pass on it", async () => {
    await writeHiddenAssert();
    const result = asRun(
      await createRunFlowTool(mockRegistry(true)).execute(
        {},
        { name: "gone", project_root: tmpDir, device: ANDROID_DEVICE }
      )
    );
    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
  });

  it("still lets `assert { visible }` pass on it", async () => {
    // The other side of the same flag: the walk can only have dropped content,
    // so an element the capture DOES list is on screen. Refusing the match made
    // one truncated read end the whole run.
    await writeAssert({ kind: "assert", condition: "visible", selector: { text: "Header" } });
    const result = asRun(
      await createRunFlowTool(mockRegistry(true)).execute(
        {},
        { name: "gone", project_root: tmpDir, device: ANDROID_DEVICE }
      )
    );
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
  });

  it("still lets it pass on a complete capture", async () => {
    // The control: the same tree, the same missing element, no flag.
    await writeHiddenAssert();
    const result = asRun(
      await createRunFlowTool(mockRegistry(false)).execute(
        {},
        { name: "gone", project_root: tmpDir, device: ANDROID_DEVICE }
      )
    );
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
  });
});
