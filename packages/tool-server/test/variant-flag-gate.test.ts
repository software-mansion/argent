/**
 * Regression test for the argent-lens feature-flag gate.
 *
 * The gate lives at the HTTP exposure layer (http.ts), keyed off each tool's
 * `featureFlag` field, and is re-evaluated on EVERY request. The earlier
 * implementation sampled the flag ONCE at registry construction (tool-server
 * startup), so `argent enable argent-lens` against an already-running
 * server had no effect until a restart — these tests pin the fixed behavior:
 * the SAME running app reflects the flag the instant it flips, with no restart.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { Registry } from "@argent/registry";
import { z } from "zod";

vi.mock("@argent/configuration-core", () => ({ isFlagEnabled: vi.fn() }));
import { isFlagEnabled } from "@argent/configuration-core";
import { createHttpApp } from "../src/http";
import { createProposeVariantTool } from "../src/tools/variants/propose-variant";
import { awaitUserSelectionTool } from "../src/tools/variants/await-user-selection";

const mockFlag = vi.mocked(isFlagEnabled);

function buildApp() {
  const registry = new Registry();
  registry.registerTool({
    id: "gated_tool",
    featureFlag: "argent-lens",
    zodSchema: z.object({}),
    services: () => ({}),
    async execute() {
      return { ran: true };
    },
  });
  registry.registerTool({
    id: "ungated_tool",
    zodSchema: z.object({}),
    services: () => ({}),
    async execute() {
      return { ran: true };
    },
  });
  return createHttpApp(registry).app;
}

async function toolNames(app: ReturnType<typeof buildApp>): Promise<string[]> {
  const res = await request(app).get("/tools");
  return res.body.tools.map((t: { name: string }) => t.name);
}

describe("argent-lens feature-flag gate (dynamic, HTTP layer)", () => {
  // Built ONCE: the gate must be dynamic per-request, not sampled at startup.
  const app = buildApp();
  beforeEach(() => mockFlag.mockReset());

  it("the real variant tools declare the argent-lens flag", () => {
    expect(createProposeVariantTool(new Registry()).featureFlag).toBe("argent-lens");
    expect(awaitUserSelectionTool.featureFlag).toBe("argent-lens");
  });

  it("hides a feature-flagged tool from /tools when the flag is off", async () => {
    mockFlag.mockReturnValue(false);
    const names = await toolNames(app);
    expect(names).toContain("ungated_tool");
    expect(names).not.toContain("gated_tool");
    expect(mockFlag).toHaveBeenCalledWith("argent-lens");
  });

  it("shows it on the SAME running app once the flag flips on — no restart", async () => {
    mockFlag.mockReturnValue(true);
    const names = await toolNames(app);
    expect(names).toContain("gated_tool");
    expect(names).toContain("ungated_tool");
  });

  it("rejects invoking a gated tool with 404 when the flag is off", async () => {
    mockFlag.mockReturnValue(false);
    const res = await request(app).post("/tools/gated_tool").send({});
    expect(res.status).toBe(404);
  });

  it("allows invoking the gated tool when the flag is on", async () => {
    mockFlag.mockReturnValue(true);
    const res = await request(app).post("/tools/gated_tool").send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ran: true });
  });

  it("never gates a tool that has no featureFlag", async () => {
    mockFlag.mockReturnValue(false);
    const res = await request(app).post("/tools/ungated_tool").send({});
    expect(res.status).toBe(200);
  });
});
