import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  ArtifactStore,
  CLIENT_FILE_MARKER,
  FAILURE_CODES,
  getFailureSignal,
  type ToolContext,
} from "@argent/registry";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { flowAddScriptTool } from "../../src/tools/flows/flow-add-script";
import {
  __resetRecordingsForTesting,
  getRecordingSession,
  parseFlow,
} from "../../src/tools/flows/flow-utils";

/**
 * Where a recording persists when the caller's project root also exists on
 * this host: a call over a link (`linked`, from the `x-argent-linked` header)
 * keeps the flow on the client, because a replay over that link reads the
 * client copy. Without the header the boundary probe decides.
 */

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-remote-persist-rule-"));
  __resetRecordingsForTesting();
});

afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(root, { recursive: true, force: true });
});

/** The probe the file-input boundary reports for a project root that this host has too. */
function presentProbe(): NonNullable<ToolContext["fileInputs"]> {
  return { project_root: { clientPath: root, presentOnHost: true, viaUpload: false } };
}

function flowPath(name: string): string {
  return path.join(root, ".argent", "flows", `${name}.yaml`);
}

describe("flow-start-recording persistence with a project root on this host", () => {
  it("persists on the client when the call is linked even though the path exists on the host", async () => {
    const result = await flowStartRecordingTool.execute(
      {},
      { name: "linked", project_root: root, executionPrerequisite: "Home" },
      { artifacts: new ArtifactStore(), linked: true, fileInputs: presentProbe() }
    );

    expect(result.savedTo).toMatchObject({ [CLIENT_FILE_MARKER]: true, path: flowPath("linked") });
    const directive = result.savedTo as { content: string };
    expect(parseFlow(directive.content)).toEqual({ executionPrerequisite: "Home", steps: [] });
    expect((await getRecordingSession(root, "linked"))?.persist).toBe("client");
    // This host has the project, and the recorder still wrote nothing into it.
    await expect(fs.stat(flowPath("linked"))).rejects.toThrow();
    await expect(fs.stat(path.join(root, ".argent"))).rejects.toThrow();
  });

  it("persists on the host without the header when the path exists", async () => {
    const result = await flowStartRecordingTool.execute(
      {},
      { name: "local", project_root: root, executionPrerequisite: "Home" },
      { artifacts: new ArtifactStore(), fileInputs: presentProbe() }
    );

    expect(result.savedTo).toBe(flowPath("local"));
    expect((await getRecordingSession(root, "local"))?.persist).toBe("host");
    expect(parseFlow(await fs.readFile(flowPath("local"), "utf8"))).toEqual({
      executionPrerequisite: "Home",
      steps: [],
    });
  });

  it("refuses flow-add-script in a take that a linked start persisted on the client, with the project on this host", async () => {
    // The script exists on this host and would leave a marker if it ran. The
    // add call itself carries no header: the take is over a link, so a replay
    // over that link refuses the script step either way.
    const marker = path.join(root, "ran.txt");
    const script = path.join(root, "scripts", "seed.mjs");
    await fs.mkdir(path.dirname(script), { recursive: true });
    await fs.writeFile(
      script,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n`
    );
    await flowStartRecordingTool.execute(
      {},
      { name: "linked", project_root: root },
      { artifacts: new ArtifactStore(), linked: true, fileInputs: presentProbe() }
    );

    let caught: unknown;
    try {
      await flowAddScriptTool.execute(
        {},
        { name: "linked", project_root: root, path: "../../scripts/seed.mjs" } as never,
        undefined
      );
    } catch (err) {
      caught = err;
    }

    const signal = getFailureSignal(caught);
    expect(signal?.error_code).toBe(FAILURE_CODES.FLOW_FILE_INVALID);
    expect(signal?.failure_stage).toBe("flow_add_script_client_mode");
    expect((caught as Error).message).toContain(
      'Cannot add a script step to flow "linked": the recording is over a link'
    );
    await expect(fs.stat(marker)).rejects.toThrow();
    expect((await getRecordingSession(root, "linked"))?.flow.steps).toEqual([]);
    await expect(fs.stat(flowPath("linked"))).rejects.toThrow();
  });
});
