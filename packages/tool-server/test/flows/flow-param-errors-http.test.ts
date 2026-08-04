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
  it("returns 400 (not 500) for a name-less flow-execute, with the guidance in the body", async () => {
    // `name` is optional in the schema (to accept the `flow_name` alias), so a
    // name-less call passes zod and is rejected inside execute(). resolveFlowName
    // throws an InvalidToolInputError, which the HTTP boundary maps to 400, the
    // status the pre-alias zod rejection returned. A plain Error would be 500.
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
});
