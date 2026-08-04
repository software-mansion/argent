import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";

// An agent passed `flow_name` instead of `name` and got back
//   [{"expected":"string","code":"invalid_type","path":["name"]}]
// which names the parameter the tool wanted and never the one that was sent —
// so the mistake is invisible, and finding it costs a whole turn.

let tmpDir: string;

function registry(): Registry {
  const r = new Registry();
  r.registerTool(createRunFlowTool(r) as never);
  return r;
}

async function writeFlow(name: string): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${name}.yaml`),
    `executionPrerequisite: "anywhere"\nsteps:\n  - echo: hello\n`,
    "utf8"
  );
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-params-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("flow-execute parameter handling", () => {
  it("accepts `flow_name` as an alias for `name`", async () => {
    await writeFlow("aliased");

    const result = await registry().invokeTool<FlowRunResult>("flow-execute", {
      flow_name: "aliased",
      project_root: tmpDir,
      device: "00000000-0000-0000-0000-0000000000ab",
      prerequisiteAcknowledged: true,
    });

    expect(result.flow).toBe("aliased");
    expect(result.ok).toBe(true);
  });

  it("does not let an EMPTY name mask a valid alias", async () => {
    // `??` would keep `""` and reject the call while pointing at the very
    // field it ignored — the exact confusion the alias exists to prevent.
    await writeFlow("aliased");

    const result = await registry().invokeTool<FlowRunResult>("flow-execute", {
      name: "",
      flow_name: "aliased",
      project_root: tmpDir,
      device: "00000000-0000-0000-0000-0000000000ab",
      prerequisiteAcknowledged: true,
    });

    expect(result.flow).toBe("aliased");
    expect(result.ok).toBe(true);
  });

  it("names a missing NESTED parameter as missing, not as a type error", async () => {
    let message = "";
    try {
      await registry().invokeTool("flow-execute", {
        project_root: tmpDir,
        name: "x",
        platform: "not-a-platform",
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("`platform`");
    expect(message).not.toContain('"code"');
  });

  it("says which parameter it needs when neither spelling is present", async () => {
    await expect(
      registry().invokeTool("flow-execute", {
        project_root: tmpDir,
        prerequisiteAcknowledged: true,
      })
    ).rejects.toThrow(/needs the flow's name in `name`.*`flow_name` is accepted as an alias/s);
  });

  it("renders a schema failure as a sentence naming what was sent", async () => {
    let message = "";
    try {
      await registry().invokeTool("flow-execute", { name: "x" }); // project_root missing
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain("`project_root` is required");
    // The other half of the fix: name the keys the caller actually sent, so a
    // misspelling is self-evident instead of merely absent.
    expect(message).toContain("You sent: `name`");
    // And not the raw issue JSON.
    expect(message).not.toContain('"code":"invalid_type"');
  });
});
