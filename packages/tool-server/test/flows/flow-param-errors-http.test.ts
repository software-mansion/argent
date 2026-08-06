import { describe, it, expect } from "vitest";
import request from "supertest";
import { z } from "zod";
import { Registry } from "@argent/registry";
import { createHttpApp } from "../../src/http";
import { createRunFlowTool } from "../../src/tools/flows/flow-run";

// The MCP-facing surface for a bad tool call is the HTTP 400 body, so the
// friendly prose (and the status code the fix restores) are pinned here rather
// than only through `registry.invokeTool`.

describe("flow param errors over HTTP", () => {
  it("returns 400 for a source-less flow-execute, with the guidance in the body", async () => {
    // Answered by the SCHEMA: with neither `name` nor `flow_path`, the
    // exactly-one-source rule fires and `execute` is never entered. Its message
    // was deliberately given the same wording as resolveFlowName's, so the
    // caller reads one answer whichever check catches them — which is also why
    // this case cannot stand in for the resolveFlowName mapping below.
    const registry = new Registry();
    registry.registerTool(createRunFlowTool(registry) as never);
    const { app } = createHttpApp(registry);

    const res = await request(app)
      .post("/tools/flow-execute")
      .send({ project_root: "/tmp/does-not-matter", prerequisiteAcknowledged: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("needs the flow's name in `name`");
    expect(res.body.error).toContain("`flow_name` is accepted as an alias");
  });

  it("returns 400 (not 500) when resolveFlowName itself rejects the call", async () => {
    // The input that actually REACHES the throw: an empty `name` is a named
    // source as far as the schema's exactly-one rule is concerned, so zod
    // passes and `execute` runs. `name` is optional (to accept the alias), so
    // this check no longer lives in zod and has to carry its own
    // classification: InvalidToolInputError maps to 400, the status the
    // pre-alias zod rejection returned, where a plain Error would be 500.
    const registry = new Registry();
    registry.registerTool(createRunFlowTool(registry) as never);
    const { app } = createHttpApp(registry);

    for (const body of [{ name: "" }, { flow_name: "" }]) {
      const res = await request(app)
        .post("/tools/flow-execute")
        .send({ ...body, project_root: "/tmp/does-not-matter", prerequisiteAcknowledged: true });

      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toContain("needs the flow's name in `name`");
      expect(res.body.error_kind).toBe("validation");
    }
  });

  it("renders the 400 body as prose that names the caller's own keys, not raw Zod JSON", async () => {
    // A misspelled required key: zod strips the unknown `countt` and reports
    // `count` missing. The body must say `count` is required AND echo the key the
    // caller actually sent, so the misspelling is self-evident: the whole point
    // of describeParamIssues, and the surface (bodyArgs, not the raw issues) that
    // a regression here would silently break.
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
    expect(res.body.error).toContain("`count` is required");
    expect(res.body.error).toContain("You sent: `countt`");
    expect(res.body.error).not.toContain('"code"');
  });

  it("carries the machine-readable issue list beside the prose", async () => {
    // Prose is for the agent reading the message; `argent run` needs the PATHS,
    // to name the flag its own user typed (`--count`, not `count`), print the
    // tool's help block and exit 2. It used to read the issue list out of the
    // message; moving the message to prose without this field takes that away
    // and every server-side rejection falls through to a bare error dump.
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

  it("answers a NESTED tool's schema miss with 400, matching the direct call", async () => {
    // The registry validates every dispatch path, so a mistyped argument to a
    // sub-tool (a flow-add-step command, a run-sequence step) is caught there
    // rather than by the HTTP layer's own copy — where the outer call's params
    // parsed fine. It carries `error_kind: "validation"`, so answering 500 had
    // the body contradicting its own status, and the same mistake reading as a
    // client error directly and an internal fault one level in.
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
