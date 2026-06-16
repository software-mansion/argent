/**
 * The feature-flag gate must be enforced inside `invokeTool` — the single choke
 * point every dispatch path (HTTP, flow-execute, flow-add-step, run-sequence)
 * funnels through — not only at the HTTP edge. The earlier implementation gated
 * solely in `http.ts`, so a flow YAML could dispatch a flag-gated tool through
 * `registry.invokeTool` even when the flag was OFF. These tests pin the fix: a
 * disabled flag-gated tool is reported as `ToolNotFoundError` (mirroring the
 * HTTP 404) from `invokeTool` directly, and an enabled one dispatches normally.
 */
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { Registry } from "../src/registry";
import { ToolNotFoundError } from "../src/errors";

function registerGatedTool(registry: Registry, execute = vi.fn(async () => ({ ran: true }))) {
  registry.registerTool({
    id: "propose_variant",
    featureFlag: "variant-selection",
    zodSchema: z.object({}),
    services: () => ({}),
    execute,
  });
  return execute;
}

describe("Registry -- invokeTool feature-flag gate", () => {
  it("throws ToolNotFoundError for a flag-gated tool when its flag is disabled", async () => {
    const registry = new Registry({ isFlagEnabled: () => false });
    const execute = registerGatedTool(registry);

    await expect(registry.invokeTool("propose_variant", {})).rejects.toThrow(ToolNotFoundError);
    // The gate fires BEFORE execute — the body must not run.
    expect(execute).not.toHaveBeenCalled();
  });

  it("dispatches a flag-gated tool when its flag is enabled", async () => {
    const registry = new Registry({ isFlagEnabled: () => true });
    const execute = registerGatedTool(registry);

    const result = await registry.invokeTool("propose_variant", {});
    expect(result).toEqual({ ran: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("consults isFlagEnabled with the tool's own flag name", async () => {
    const isFlagEnabled = vi.fn(() => true);
    const registry = new Registry({ isFlagEnabled });
    registerGatedTool(registry);

    await registry.invokeTool("propose_variant", {});
    expect(isFlagEnabled).toHaveBeenCalledWith("variant-selection");
  });

  it("never gates a tool that declares no featureFlag, even with isFlagEnabled=false", async () => {
    const isFlagEnabled = vi.fn(() => false);
    const registry = new Registry({ isFlagEnabled });
    const execute = vi.fn(async () => ({ ran: true }));
    registry.registerTool({
      id: "ungated_tool",
      zodSchema: z.object({}),
      services: () => ({}),
      execute,
    });

    const result = await registry.invokeTool("ungated_tool", {});
    expect(result).toEqual({ ran: true });
    expect(execute).toHaveBeenCalledTimes(1);
    // No flag → no flag read at all.
    expect(isFlagEnabled).not.toHaveBeenCalled();
  });

  it("defaults to enabled (no injected predicate) so existing call sites are unaffected", async () => {
    const registry = new Registry();
    const execute = registerGatedTool(registry);

    const result = await registry.invokeTool("propose_variant", {});
    expect(result).toEqual({ ran: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
