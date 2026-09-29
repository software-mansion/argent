import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Registry, FILE_INPUT_MARKER } from "@argent/registry";
import { createHttpApp } from "../../src/http";
import { createRunFlowTool } from "../../src/tools/flows/flow-run";

describe("flow param errors over HTTP", () => {
  let tmpDir: string;
  let flowFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-http-params-"));
    flowFile = path.join(tmpDir, ".argent", "flows", "demo.yaml");
    await fs.mkdir(path.dirname(flowFile), { recursive: true });
    await fs.writeFile(flowFile, "steps:\n  - echo: hi\n", "utf8");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns 400 for a source-less flow-execute, with the guidance in the body", async () => {
    const registry = new Registry();
    registry.registerTool(createRunFlowTool(registry) as never);
    const { app } = createHttpApp(registry);

    const res = await request(app)
      .post("/tools/flow-execute")
      .send({ project_root: "/tmp/does-not-matter", prerequisiteAcknowledged: true });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("needs the flow's name in `name`");
    expect(res.body.message).toContain(".argent/flows/<name>.yaml");
    expect(res.body.error).toContain("needs the flow's name in `name`");
  });

  it("returns 400 for a run-time env carrying __proto__ in the raw JSON body", async () => {
    // The only channel where `__proto__` arrives as an OWN property: the body is
    // parsed with `JSON.parse`, which puts it there without invoking the
    // accessor. `z.record` then REBUILDS the map without it, so the run would
    // answer 200 with that one value silently gone — which is why the refusal
    // lives in the parameter's `z.preprocess`, before the record is built. The
    // two tool tests for this name call `execute` directly and never run the
    // schema, so what they observe is the `describeScriptEnvProblem` backstop,
    // and the backstop cannot see a name the rebuild already dropped.
    //
    // A body LITERAL, not an object: a `__proto__` key written in JS source is
    // the accessor, not an entry.
    const registry = new Registry();
    registry.registerTool(createRunFlowTool(registry) as never);
    const { app } = createHttpApp(registry);

    const res = await request(app)
      .post("/tools/flow-execute")
      .set("Content-Type", "application/json")
      .send(
        `{"project_root":${JSON.stringify(tmpDir)},"name":"demo","env":{"__proto__":"x","A":"y"}}`
      );

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("`env`");
    expect(res.body.message).toContain("holds __proto__");
  });

  it("renders the 400 body as prose that names the caller's own keys, not raw Zod JSON", async () => {
    const registry = new Registry();
    registry.registerTool({
      id: "validated-thing",
      zodSchema: z.object({ count: z.number() }),
      services: () => ({}),
      async execute() {
        throw new Error("execute should have been skipped");
      },
    } as never);
    const { app } = createHttpApp(registry);

    const res = await request(app).post("/tools/validated-thing").send({ countt: 5 });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("`count` is required");
    expect(res.body.message).toContain("You sent: `countt`");
    expect(res.body.message).not.toContain('"code"');
  });

  it("keeps `error` parseable for a CLI released before `issues`", async () => {
    const registry = new Registry();
    registry.registerTool({
      id: "validated-thing",
      zodSchema: z.object({ count: z.number() }),
      services: () => ({}),
      async execute() {
        throw new Error("execute should have been skipped");
      },
    } as never);
    const { app } = createHttpApp(registry);

    const res = await request(app).post("/tools/validated-thing").send({ countt: 5 });

    expect(res.status).toBe(400);
    expect(() => JSON.parse(res.body.error)).not.toThrow();
    expect(JSON.parse(res.body.error)).toMatchObject([{ code: "invalid_type", path: ["count"] }]);
  });

  it("carries the machine-readable issue list beside the prose", async () => {
    const registry = new Registry();
    registry.registerTool({
      id: "validated-thing",
      zodSchema: z.object({ count: z.number() }),
      services: () => ({}),
      async execute() {
        throw new Error("execute should have been skipped");
      },
    } as never);
    const { app } = createHttpApp(registry);

    const res = await request(app).post("/tools/validated-thing").send({ count: "x" });

    expect(res.status).toBe(400);
    expect(Array.isArray(res.body.issues)).toBe(true);
    expect(res.body.issues[0]).toMatchObject({ code: "invalid_type", path: ["count"] });
    expect(typeof res.body.issues[0].message).toBe("string");
  });

  it("leaves the client-DERIVED flow_file out of the keys it reads back", async () => {
    const registry = new Registry();
    registry.registerTool(createRunFlowTool(registry) as never);
    const { app } = createHttpApp(registry);

    const res = await request(app)
      .post("/tools/flow-execute")
      .send({
        name: "demo",
        project_root: tmpDir,
        platform: "iOS",
        flow_file: { [FILE_INPUT_MARKER]: true, path: flowFile },
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("`platform`");
    expect(res.body.message).toContain("You sent: `name`, `project_root`, `platform`.");
    expect(res.body.message).not.toContain("`flow_file`");
  });

  it("still names a file-input the CALLER authored", async () => {
    const registry = new Registry();
    registry.registerTool(createRunFlowTool(registry) as never);
    const { app } = createHttpApp(registry);

    const res = await request(app)
      .post("/tools/flow-execute")
      .send({
        project_root: tmpDir,
        device: 5,
        flow_path: { [FILE_INPUT_MARKER]: true, path: flowFile },
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("`device`");
    expect(res.body.message).toContain("`flow_path`");
  });

  it("answers a NESTED tool's schema miss with 400, matching the direct call", async () => {
    const registry = new Registry();
    registry.registerTool({
      id: "inner",
      zodSchema: z.object({ count: z.number() }),
      services: () => ({}),
      async execute() {
        return { ok: true };
      },
    } as never);
    registry.registerTool({
      id: "outer",
      zodSchema: z.object({ pass: z.unknown() }),
      services: () => ({}),
      async execute(_s: unknown, params: { pass: unknown }) {
        return registry.invokeTool("inner", params.pass);
      },
    } as never);
    const { app } = createHttpApp(registry);

    const res = await request(app)
      .post("/tools/outer")
      .send({ pass: { countt: 5 } });

    expect(res.status).toBe(400);
    expect(res.body.error_kind).toBe("validation");
    expect(res.body.error).toContain("`count` is required");
    expect(res.body.error).toContain("You sent: `countt`");
  });
});
