import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  ArtifactStore,
  FAILURE_CODES,
  getFailureSignal,
  type Registry,
  type ToolContext,
} from "@argent/registry";
import { flowStartRecordingTool } from "../../../src/tools/flows/flow-start-recording";
import { flowInsertEchoTool } from "../../../src/tools/flows/flow-insert-echo";
import { flowAddScriptTool } from "../../../src/tools/flows/flow-add-script";
import { flowFinishRecordingTool } from "../../../src/tools/flows/flow-finish-recording";
import { createFlowAddStepTool } from "../../../src/tools/flows/flow-add-step";
import {
  __resetRecordingsForTesting,
  getRecordingSession,
  holdsOutputReference,
  parseFlow,
  type FlowStep,
} from "../../../src/tools/flows/flow-utils";

/** Real child processes, so the budgets are generous. */
vi.setConfig({ testTimeout: 30_000 });

let root: string;

async function write(relative: string, contents: string): Promise<string> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents, "utf8");
  return file;
}

function deepFindMarker(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = deepFindMarker(item);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (key.startsWith("__argent")) return key;
      const hit = deepFindMarker(nested);
      if (hit) return hit;
    }
  }
  return null;
}

function flowPath(name: string, projectRoot = root): string {
  return path.join(projectRoot, ".argent", "flows", `${name}.yaml`);
}

async function steps(name: string, projectRoot = root): Promise<FlowStep[]> {
  return parseFlow(await fs.readFile(flowPath(name, projectRoot), "utf8")).steps;
}

async function start(name: string, projectRoot = root, ctx?: ToolContext) {
  return flowStartRecordingTool.execute({}, { name, project_root: projectRoot }, ctx);
}

async function addScript(
  name: string,
  scriptPath: string,
  extra: { timeout?: number; project_root?: string } = {},
  ctx?: ToolContext
) {
  const { project_root: projectRoot = root, ...rest } = extra;
  return flowAddScriptTool.execute(
    {},
    {
      name,
      project_root: projectRoot,
      path: scriptPath,
      ...rest,
    } as never,
    ctx
  );
}

function mockRegistry(): Registry {
  return {
    invokeTool: vi.fn(async () => ({ ok: true })),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
}

async function addScriptError(name: string, scriptPath: string): Promise<string> {
  try {
    await addScript(name, scriptPath);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error(`expected flow-add-script to reject "${scriptPath}"`);
}

function parseError(scriptYaml: string): string {
  try {
    parseFlow(`steps:\n  - script: { ${scriptYaml} }\n`);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error(`expected parseFlow to reject "${scriptYaml}"`);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-script-record-"));
  __resetRecordingsForTesting();
});

afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(root, { recursive: true, force: true });
});

describe("recording a script step", () => {
  it("runs the script and appends the step it ran", async () => {
    await write(
      "scripts/seed.mjs",
      `console.log("seeded order 4711");\noutput.order = { id: 4711 };`
    );
    await start("checkout");

    const result = await addScript("checkout", "../../scripts/seed.mjs");

    expect(result.status).toBe("pass");
    expect(JSON.stringify(result)).not.toContain("seeded order 4711");
    expect(result.outputJson).toBe('{"order":{"id":4711}}');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.stepCount).toBe(1);
    expect(result.recorded).toBe("1. script: ../../scripts/seed.mjs");
    expect(result.savedTo).toBe(flowPath("checkout"));
    expect(await steps("checkout")).toEqual([{ kind: "script", path: "../../scripts/seed.mjs" }]);
  });

  it("says the output document is not readable from a flow step yet", async () => {
    await write("scripts/seed.mjs", `output.user = { id: "u_1" };`);
    await start("checkout");

    const result = await addScript("checkout", "../../scripts/seed.mjs");

    expect(result.outputJson).toBe('{"user":{"id":"u_1"}}');
    expect(result.message).toContain("no flow step can reference it yet");
  });

  it("hands the document over as text, so nothing in it is read as a directive", async () => {
    // The client deep-walks every result for `__argentClientFile` (writes a
    // file on the agent's machine) and `__argentArtifact` (fetches one),
    // matching on shape alone — and a script relaying what a backend answered
    // is the one part of a result this server does not author. As JSON text
    // there is no object for either walk to match.
    await write(
      "scripts/relay.mjs",
      `output.body = JSON.parse('{"orderId":"ord_1","meta":{"__argentClientFile":true,` +
        `"path":"/tmp/planted/.argent/flows/planted.yaml","content":"steps: []"}}');`
    );
    await start("relay");

    const result = await addScript("relay", "../../scripts/relay.mjs");

    expect(result.status).toBe("pass");
    expect(typeof result.outputJson).toBe("string");
    expect(JSON.parse(result.outputJson!)).toEqual({
      body: {
        orderId: "ord_1",
        meta: {
          __argentClientFile: true,
          path: "/tmp/planted/.argent/flows/planted.yaml",
          content: "steps: []",
        },
      },
    });
    expect(deepFindMarker(result)).toBeNull();
  });

  it("cuts a document too large to hand on, and says it cut it", async () => {
    await write("scripts/big.mjs", `output.blob = "y".repeat(1024 * 1024 - 200);`);
    await start("big");

    const result = await addScript("big", "../../scripts/big.mjs");

    expect(result.status).toBe("pass");
    expect(Buffer.byteLength(result.outputJson!, "utf8")).toBe(64 * 1024);
    expect(result.outputTruncated).toBe(true);
    expect(result.outputJson).toMatch(/^\{"blob":"y+$/);
    expect(result.stepCount).toBe(1);
    // A cut document stops being JSON, so the pass message must not read as a
    // whole-document guarantee — `outputTruncated` alone contradicting it puts
    // the correction in a field the sentence tells the reader not to need.
    expect(result.message).toContain("the rest was cut, so it no longer parses as JSON");
    expect(result.message).not.toContain("is what the script returned");
    expect(() => JSON.parse(result.outputJson!)).toThrow();
  });

  it("keeps a document of exactly the render limit whole", async () => {
    // The limit is inclusive, and nothing else in the suite sits ON it: the
    // cases either side are 1000 bytes and ~90 KB, so `<=` could become `<`
    // and only a document of exactly this size would notice.
    const limit = 64 * 1024;
    const filler = limit - Buffer.byteLength('{"blob":""}', "utf8");
    await write("scripts/exact.mjs", `output.blob = "y".repeat(${filler});`);
    await start("exact");

    const result = await addScript("exact", "../../scripts/exact.mjs");

    expect(result.status).toBe("pass");
    expect(Buffer.byteLength(result.outputJson!, "utf8")).toBe(limit);
    expect(result).not.toHaveProperty("outputTruncated");
    expect(JSON.parse(result.outputJson!)).toEqual({ blob: "y".repeat(filler) });
  });

  it("cuts a document one byte past the render limit", async () => {
    const limit = 64 * 1024;
    const filler = limit - Buffer.byteLength('{"blob":""}', "utf8") + 1;
    await write("scripts/over.mjs", `output.blob = "y".repeat(${filler});`);
    await start("over");

    const result = await addScript("over", "../../scripts/over.mjs");

    expect(result.status).toBe("pass");
    expect(result.outputTruncated).toBe(true);
    expect(Buffer.byteLength(result.outputJson!, "utf8")).toBe(limit);
  });

  it("records the timeout the caller asked for, even when the run clamped it", async () => {
    // Above the executor's absolute ceiling (Node's largest timer), so the
    // clamp holds whatever `scripts.maxTimeoutMs` the host running this
    // configures. The recorder writes what was asked for either way: the YAML
    // is the request, and the clamp is the host's answer to it.
    const asked = 2_147_483_648;
    await write("scripts/quick.mjs", `output.ok = true;`);
    await start("clamped");

    const result = await addScript("clamped", "../../scripts/quick.mjs", { timeout: asked });

    expect(result.status).toBe("pass");
    expect(result.reason).toContain("above this host's maximum");
    expect(await steps("clamped")).toEqual([
      { kind: "script", path: "../../scripts/quick.mjs", timeout: asked },
    ]);
  });

  it("stops the script when the caller cancels the call", async () => {
    const started = path.join(root, "started.txt");
    await write(
      "scripts/slow.mjs",
      `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(started)}, "x");\n` +
        `await new Promise((r) => setTimeout(r, 20000));\n`
    );
    await start("cancelled");
    const controller = new AbortController();

    const call = addScript("cancelled", "../../scripts/slow.mjs", {}, {
      signal: controller.signal,
    } as unknown as ToolContext);
    // Cancel only once the child is provably running, so the case is a stopped
    // script rather than one that never left the queue.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (
        await fs.access(started).then(
          () => true,
          () => false
        )
      )
        break;
      await new Promise((r) => setTimeout(r, 25));
    }
    controller.abort();
    const result = await call;

    expect(result.status).toBe("error");
    expect(result.reason).toMatch(/cancelled/i);
    expect(result.durationMs).toBeLessThan(15_000);
    expect(result.message).toContain("nothing was rolled back");
    expect(await steps("cancelled")).toEqual([]);
  });

  it("says the script ran when a write failure stops it being recorded", async () => {
    await write("scripts/seed.mjs", `output.ok = true;`);
    await start("readonly");
    const flowsDir = path.dirname(flowPath("readonly"));
    await fs.chmod(flowsDir, 0o500);
    try {
      const err = await addScript("readonly", "../../scripts/seed.mjs").catch(
        (e: unknown) => e as Error
      );

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/ran and passed in \d+ms/);
      expect((err as Error).message).toContain("nothing it did was rolled back");
      expect(getFailureSignal(err as Error)?.failure_stage).toBe("flow_file_write");
    } finally {
      await fs.chmod(flowsDir, 0o700);
    }
  });

  it("classifies a bare append failure the way every other write failure is classified", async () => {
    await start("vanished");
    await write(
      "scripts/vanish.mjs",
      `import * as fs from "node:fs";\n` +
        `fs.unlinkSync(${JSON.stringify(flowPath("vanished"))});\n` +
        `output.ok = true;`
    );

    const err = await addScript("vanished", "../../scripts/vanish.mjs").catch(
      (e: unknown) => e as Error
    );

    expect(err).toBeInstanceOf(Error);
    const signal = getFailureSignal(err as Error);
    expect(signal?.failure_stage).toBe("flow_add_script_append");
    expect(signal?.error_code).toBe(FAILURE_CODES.FLOW_FILE_WRITE_FAILED);
    expect(signal?.error_kind).toBe("unknown");
    expect((err as Error).message).toContain("nothing it did was rolled back");
  });

  it("blames the hand-edited step, not the script, when the re-parse refuses an earlier one", async () => {
    // The append re-parses the whole file, so an output reference a mid-recording
    // hand edit put in an EARLIER step refuses this write. The script itself ran
    // and passed; wording it as "recording it failed" would send the author back
    // over the one call that did nothing wrong.
    await write("scripts/seed.mjs", `output.ok = true;`);
    await start("handedited");
    await fs.writeFile(
      flowPath("handedited"),
      `steps:\n  - echo: "created {{output:user.id}}"\n`,
      "utf8"
    );

    const err = (await addScript("handedited", "../../scripts/seed.mjs").catch(
      (e: unknown) => e
    )) as Error;

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/ran and passed in \d+ms/);
    expect(err.message).toContain("a step ALREADY in the flow file spells an output reference");
    expect(err.message).toContain("not this script");
    expect(err.message).toContain(flowPath("handedited"));
    expect(err.message).toContain("Step 1 (`echo`)");
    // The refusal keeps its own signal; only the framing around it changed.
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_ENTRY_UNRECOGNIZED);
  });

  it("is never itself the step an output-reference refusal names", async () => {
    // What lets the message above say "not this script" without asking: the scan
    // reads no field a `script:` step has, so a refusal on the append path can
    // only be about a step that was already in the file.
    expect(
      holdsOutputReference({ kind: "script", path: "../../scripts/{{output:user.id}}.mjs" })
    ).toBe(false);
  });

  it("leaves a document inside the limit whole and unflagged", async () => {
    await write("scripts/seed.mjs", `output.blob = "y".repeat(1000);`);
    await start("small");

    const result = await addScript("small", "../../scripts/seed.mjs");

    expect(result.outputJson).toBe(JSON.stringify({ blob: "y".repeat(1000) }));
    expect(result).not.toHaveProperty("outputTruncated");
    expect(result.message).toContain("`outputJson` is what the script returned");
  });

  it("never cuts a multi-byte character in half", async () => {
    // The cut lands on the encoded bytes, so a 3-byte character straddling the
    // ceiling has to be dropped whole — otherwise the field carries a lone
    // replacement character the script never wrote. 30000 of them encode to
    // 90 KB: over this ceiling, under the executor's own.
    await write("scripts/wide.mjs", `output.blob = "\u3042".repeat(30000);`);
    await start("wide");

    const result = await addScript("wide", "../../scripts/wide.mjs");

    expect(result.outputTruncated).toBe(true);
    expect(result.outputJson).not.toContain("\uFFFD");
    expect(Buffer.byteLength(result.outputJson!, "utf8")).toBe(64 * 1024 - 1);
    expect(result.outputJson).toMatch(/^\{"blob":"\u3042+$/);
  });

  it("records the timeout when one is given, and nothing when it is not", async () => {
    await write("scripts/seed.mjs", `output.ok = true;`);

    await start("timed");
    await addScript("timed", "../../scripts/seed.mjs", { timeout: 45_000 });
    expect(await steps("timed")).toEqual([
      { kind: "script", path: "../../scripts/seed.mjs", timeout: 45000 },
    ]);

    await start("untimed");
    await addScript("untimed", "../../scripts/seed.mjs");
    expect(await steps("untimed")).toEqual([{ kind: "script", path: "../../scripts/seed.mjs" }]);
  });

  it("appends after the steps already recorded, and survives the ones after it", async () => {
    await write("scripts/seed.mjs", `output.ok = true;`);
    await start("mixed");
    await flowInsertEchoTool.execute({}, { name: "mixed", project_root: root, message: "seeding" });

    const script = await addScript("mixed", "../../scripts/seed.mjs", { timeout: 30_000 });
    expect(script.stepCount).toBe(2);

    await createFlowAddStepTool(mockRegistry()).execute(
      {},
      {
        name: "mixed",
        project_root: root,
        command: "restart-app",
        args: JSON.stringify({ udid: "device-1", bundleId: "com.acme.notes" }),
      }
    );
    const finished = await flowFinishRecordingTool.execute({}, {
      name: "mixed",
      project_root: root,
    } as never);

    expect(finished.summary).toEqual([
      "1. echo: seeding",
      "2. script: ../../scripts/seed.mjs (timeout 30000ms)",
      "3. launch: com.acme.notes",
    ]);
    expect(await steps("mixed")).toEqual([
      { kind: "echo", message: "seeding" },
      { kind: "script", path: "../../scripts/seed.mjs", timeout: 30000 },
      { kind: "launch", app: "com.acme.notes" },
    ]);
  });

  it("needs no device of any kind", async () => {
    expect(Object.keys(flowAddScriptTool.zodSchema!.shape).sort()).toEqual([
      "name",
      "path",
      "project_root",
      "timeout",
    ]);

    await write("scripts/seed.mjs", `output.ok = true;`);
    await start("deviceless");
    expect((await addScript("deviceless", "../../scripts/seed.mjs")).status).toBe("pass");
  });

  it("is declared longRunning, because a script may outlive the MCP fetch budget", async () => {
    expect(flowAddScriptTool.longRunning).toBe(true);
  });

  it("runs in the working directory replay gives it", async () => {
    await write("fixtures/order.json", `{ "item": "espresso machine" }`);
    await write(
      "scripts/read-fixture.mjs",
      `import { readFileSync } from "node:fs";
       output.item = JSON.parse(readFileSync("./fixtures/order.json", "utf8")).item;`
    );
    await start("cwd");

    const result = await addScript("cwd", "../../scripts/read-fixture.mjs");

    expect(result.status).toBe("pass");
    expect(result.outputJson).toBe('{"item":"espresso machine"}');
  });

  it("resolves a path against the flow file, reaching a directory beside the project", async () => {
    const sibling = path.join(path.dirname(root), `${path.basename(root)}-shared`);
    await fs.mkdir(sibling, { recursive: true });
    await fs.writeFile(path.join(sibling, "shared.mjs"), `output.shared = true;`, "utf8");
    try {
      await start("outside");
      const relative = `../../../${path.basename(sibling)}/shared.mjs`;

      const result = await addScript("outside", relative);

      expect(result.status).toBe("pass");
      expect(result.outputJson).toBe('{"shared":true}');
      expect(await steps("outside")).toEqual([{ kind: "script", path: relative }]);
    } finally {
      await fs.rm(sibling, { recursive: true, force: true });
    }
  });

  it("returns nothing a chatty script printed, and still records the step", async () => {
    await write(
      "scripts/chatty.mjs",
      `console.log("psql://user:hunter2@db/prod ".repeat(200_000));\n` +
        `console.error("and a warning");\n` +
        `output.ok = true;`
    );
    await start("chatty");

    const result = await addScript("chatty", "../../scripts/chatty.mjs");

    expect(result.status).toBe("pass");
    const whole = JSON.stringify(result);
    expect(whole).not.toContain("hunter2");
    expect(whole).not.toContain("and a warning");
    expect(result).not.toHaveProperty("log");
    expect(result).not.toHaveProperty("logTruncated");
    expect(await steps("chatty")).toHaveLength(1);
  });
});

describe("a script that did not pass records nothing", () => {
  it("returns the failure and leaves the recording untouched", async () => {
    await write(
      "scripts/half.mjs",
      `console.log("created 2 of 3 records");\nthrow new Error("the backend refused the third");`
    );
    await start("failing");
    await flowInsertEchoTool.execute(
      {},
      { name: "failing", project_root: root, message: "before" }
    );

    const result = await addScript("failing", "../../scripts/half.mjs");

    expect(result.status).toBe("fail");
    expect(result.reason).toContain("the backend refused the third");
    expect(JSON.stringify(result)).not.toContain("created 2 of 3 records");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.stepCount).toBe(1);
    expect(result).not.toHaveProperty("recorded");
    expect(result).not.toHaveProperty("savedTo");
    expect(result).not.toHaveProperty("outputJson");
    expect(await steps("failing")).toEqual([{ kind: "echo", message: "before" }]);
  });

  it("names the flow and the outcome in its completed line", async () => {
    const completedMsg = flowAddScriptTool.interaction!.completedMsg!;
    const params = { name: "checkout", project_root: root, path: "../../scripts/seed.mjs" };
    const base = { message: "", stepCount: 1 } as const;

    expect(completedMsg({ params, result: { ...base, status: "pass" } })).toBe(
      "Added script step to flow checkout"
    );
    expect(completedMsg({ params, result: { ...base, status: "fail" } })).toBe(
      "Script for flow checkout failed; nothing recorded"
    );
  });

  it("says nothing was recorded, and that the side effects were not rolled back", async () => {
    await write("scripts/half.mjs", `throw new Error("boom");`);
    await start("failing");

    const result = await addScript("failing", "../../scripts/half.mjs");

    expect(result.message).toContain("nothing was recorded");
    expect(result.message).toContain("nothing was rolled back");
  });

  it("counts the steps the flow FILE holds, as the success path does", async () => {
    await start("counted");
    await flowInsertEchoTool.execute(
      {},
      { name: "counted", project_root: root, message: "recorded" }
    );
    await fs.appendFile(flowPath("counted"), "  - echo: hand-added\n", "utf8");

    const failed = await addScript("counted", "../../scripts/gone.mjs");
    expect(failed.status).toBe("fail");
    expect(failed.stepCount).toBe(2);

    await write("scripts/seed.mjs", `output.ok = true;`);
    const passed = await addScript("counted", "../../scripts/seed.mjs");
    expect(passed.stepCount).toBe(3);
  });

  // With the file unreadable the only count left is the session's, which is the
  // steps as of the last append - a third number again. An author comparing it
  // with what the next append renumbers to has to know which one they are
  // holding, so it is qualified here as the sibling recorder qualifies it.
  it("says when the step count could not come off the file", async () => {
    await start("counted");
    await flowInsertEchoTool.execute(
      {},
      { name: "counted", project_root: root, message: "recorded" }
    );
    await fs.appendFile(flowPath("counted"), "  - echo: hand-added\n  - bogus: [\n", "utf8");

    const failed = await addScript("counted", "../../scripts/gone.mjs");

    expect(failed.status).toBe("fail");
    // The in-memory snapshot, while the file itself holds two steps.
    expect(failed.stepCount).toBe(1);
    expect(failed.message).toContain("could not be read and parsed");
    expect(failed.message).toContain("last valid in-memory snapshot");
  });

  it("leaves the count unqualified while the file still parses", async () => {
    await start("counted");
    await flowInsertEchoTool.execute(
      {},
      { name: "counted", project_root: root, message: "recorded" }
    );

    const failed = await addScript("counted", "../../scripts/gone.mjs");

    expect(failed.stepCount).toBe(1);
    expect(failed.message).not.toContain("in-memory snapshot");
  });

  it("does not send an author cleaning up after a script that never ran", async () => {
    await start("gone");

    const result = await addScript("gone", "../../scripts/gone.mjs");

    expect(result.message).toContain("Nothing ran, so there is nothing to clean up");
    expect(result.message).not.toContain("rolled back");
  });

  // A cancellation reaches this tool from both sides of the fork under one
  // failure kind, so the kind alone cannot answer it. Driven through the real
  // executor: the file the script would have written is the proof that the
  // answer matches what happened, not what the kind suggests.
  it("does not send an author cleaning up after a cancellation that never forked", async () => {
    const marker = path.join(root, "seeded.txt");
    await write(
      "scripts/seed.mjs",
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");`
    );
    await start("cancelled");
    const controller = new AbortController();
    controller.abort();

    const result = await addScript("cancelled", "../../scripts/seed.mjs", {}, {
      signal: controller.signal,
    } as unknown as ToolContext);

    expect(result.status).toBe("error");
    expect(result.reason).toContain("before the script started");
    expect(result.message).toContain("Nothing ran, so there is nothing to clean up");
    expect(result.message).not.toContain("is still done");
    await expect(fs.access(marker)).rejects.toThrow();
    expect(await steps("cancelled")).toEqual([]);
  });

  it("refuses a missing file before any fork, naming what it looked for", async () => {
    await start("gone");

    const result = await addScript("gone", "../../scripts/gone.mjs");

    expect(result.status).toBe("fail");
    expect(result.reason).toContain('script "../../scripts/gone.mjs" does not exist');
    // Anchored at the flow file that named the step, with its `..` segments
    // intact: only the kernel may collapse one, since a lexical collapse past a
    // symlinked component names another file.
    const flowsDir = path.dirname(await fs.realpath(flowPath("gone")));
    expect(result.reason).toContain(`resolved to ${flowsDir}${path.sep}../../scripts/gone.mjs`);
    expect(result).not.toHaveProperty("durationMs");
    expect(result).not.toHaveProperty("log");
    expect(await steps("gone")).toEqual([]);
  });

  it("refuses a directory that happens to be named like a script", async () => {
    await fs.mkdir(path.join(root, "scripts", "seed.mjs"), { recursive: true });
    await start("dir");

    const result = await addScript("dir", "../../scripts/seed.mjs");

    expect(result.status).toBe("fail");
    expect(result.reason).toContain("is not a file");
    expect(result).not.toHaveProperty("durationMs");
    expect(await steps("dir")).toEqual([]);
  });

  it("refuses a mis-cased path, quoting the spelling on disk", async () => {
    // The one authoring error a local run cannot find: a mis-cased path
    // recorded here is committed and replayed on a case-sensitive checkout,
    // where it fails with ENOENT.
    //
    // Ungated, because the verdict is not the filesystem's: classifyOnDiskSpelling
    // compares the supplied basename against readdir's own entries, lowercased.
    await write("scripts/createUser.mjs", `output.ok = true;`);
    await start("cased");

    const result = await addScript("cased", "../../scripts/CreateUser.mjs");

    expect(result.status).toBe("error");
    expect(result.reason).toContain('mis-cased script path "../../scripts/CreateUser.mjs"');
    expect(result.reason).toContain('write it as "../../scripts/createUser.mjs"');
    expect(await steps("cased")).toEqual([]);
  });
});

describe("the paths flow-add-script accepts", () => {
  const REJECTED: [label: string, supplied: string, yaml: string][] = [
    ["a backslash", "scripts\\seed.mjs", 'path: "scripts\\\\seed.mjs"'],
    ["an absolute path", "/tmp/seed.mjs", 'path: "/tmp/seed.mjs"'],
    ["a drive-relative prefix", "C:seed.mjs", 'path: "C:seed.mjs"'],
    ["an uppercase extension", "scripts/SEED.MJS", 'path: "scripts/SEED.MJS"'],
    ["a wrong extension", "scripts/seed.js", 'path: "scripts/seed.js"'],
    ["a basename outside the charset", "scripts/seed order.mjs", 'path: "scripts/seed order.mjs"'],
    ["an empty path", "", 'path: ""'],
  ];

  it.each(REJECTED)(
    "rejects %s exactly as the YAML parser does",
    async (_label, supplied, yaml) => {
      await start("paths");
      expect(await addScriptError("paths", supplied)).toBe(parseError(yaml));
      expect(await steps("paths")).toEqual([]);
    }
  );

  it("rejects a missing path exactly as the YAML parser does", async () => {
    await start("paths");
    let message = "";
    try {
      await flowAddScriptTool.execute({}, { name: "paths", project_root: root } as never);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toBe(parseError(""));
  });

  it("rejects a non-positive timeout exactly as the YAML parser does", async () => {
    await write("scripts/seed.mjs", `output.ok = true;`);
    await start("paths");
    let message = "";
    try {
      await addScript("paths", "../../scripts/seed.mjs", { timeout: 0 });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toBe(parseError('path: "../../scripts/seed.mjs", timeout: 0'));
    expect(await steps("paths")).toEqual([]);
  });

  // The floor is the parser's second timeout rejection, and it admits values
  // the non-positive check lets through — so parity has to be pinned on one of
  // those too, or the recorder could keep running a limit `parseFlow` refuses.
  it("rejects a timeout under the floor exactly as the YAML parser does", async () => {
    const ran = path.join(root, "ran.txt");
    await write(
      "scripts/seed.mjs",
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(ran)}, "1");\n`
    );
    await start("paths");
    let message = "";
    try {
      await addScript("paths", "../../scripts/seed.mjs", { timeout: 50 });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toBe(parseError('path: "../../scripts/seed.mjs", timeout: 50'));
    expect(message).toMatch(/script.timeout is in milliseconds and needs at least 100/);
    expect(await steps("paths")).toEqual([]);
    // Refused at parse, so the run never started — the recorder must not have
    // spent the script's side effects on a step it then refuses to record.
    await expect(fs.access(ran)).rejects.toThrow();
  });
});

describe("a recording this server cannot reach", () => {
  const CLIENT_ROOT = path.join(os.tmpdir(), "definitely-not-on-this-host", "agent-project");

  function remoteCtx(): ToolContext {
    return {
      artifacts: new ArtifactStore(),
      fileInputs: {
        project_root: { clientPath: CLIENT_ROOT, presentOnHost: false, viaUpload: false },
      },
    };
  }

  it("refuses a client-mode recording without running anything", async () => {
    const marker = path.join(root, "ran.txt");
    await write(
      "scripts/seed.mjs",
      `import { writeFileSync } from "node:fs";
       writeFileSync(${JSON.stringify(marker)}, "ran");`
    );
    await start("remote", CLIENT_ROOT, remoteCtx());

    let signal;
    let message = "";
    try {
      await addScript("remote", "../../scripts/seed.mjs", { project_root: CLIENT_ROOT });
    } catch (err) {
      signal = getFailureSignal(err);
      message = err instanceof Error ? err.message : String(err);
    }

    expect(signal?.error_code).toBe(FAILURE_CODES.FLOW_FILE_INVALID);
    expect(signal?.failure_stage).toBe("flow_add_script_client_mode");
    expect(message).toContain("not on the tool server's filesystem");
    expect(message).toContain("add the `script:` step to the YAML by hand");
    await expect(fs.stat(marker)).rejects.toThrow();
    await expect(fs.stat(CLIENT_ROOT)).rejects.toThrow();
    expect((await getRecordingSession(CLIENT_ROOT, "remote"))?.flow.steps).toEqual([]);
  });
});

describe("a recording that is not live", () => {
  it("fails the way every recording tool does", async () => {
    await write("scripts/seed.mjs", `output.ok = true;`);

    let signal;
    try {
      await addScript("never-started", "../../scripts/seed.mjs");
    } catch (err) {
      signal = getFailureSignal(err);
    }

    expect(signal?.error_code).toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);
  });

  it("refuses a relative project root before it resolves anything", async () => {
    let signal;
    try {
      await addScript("anything", "../../scripts/seed.mjs", { project_root: "relative/path" });
    } catch (err) {
      signal = getFailureSignal(err);
    }

    expect(signal?.error_code).toBe(FAILURE_CODES.FLOW_PROJECT_ROOT_INVALID);
  });
});
