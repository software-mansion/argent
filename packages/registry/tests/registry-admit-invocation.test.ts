/**
 * `admitInvocation` is the operator server policy's seam: like the feature-flag
 * gate it runs inside `invokeTool`, so a flow or run-sequence cannot reach a
 * tool the HTTP edge would refuse. It sees the validated params, and a refusal
 * stops the call before `execute` runs.
 */
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { Registry } from "../src/registry";

function registerDeviceTool(registry: Registry, execute = vi.fn(async () => ({ ran: true }))) {
  registry.registerTool({
    id: "screenshot",
    zodSchema: z.object({ udid: z.string().trim() }),
    services: () => ({}),
    execute,
  });
  return execute;
}

describe("Registry -- invokeTool admitInvocation", () => {
  it("refuses before execute when admitInvocation throws", async () => {
    const refusal = new Error("denied by policy");
    const registry = new Registry({
      admitInvocation: () => {
        throw refusal;
      },
    });
    const execute = registerDeviceTool(registry);

    await expect(registry.invokeTool("screenshot", { udid: "sim-1" })).rejects.toMatchObject({
      cause: refusal,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("passes the tool definition and the validated params", async () => {
    const admitInvocation = vi.fn();
    const registry = new Registry({ admitInvocation });
    registerDeviceTool(registry);

    await registry.invokeTool("screenshot", { udid: "  sim-1  " });

    expect(admitInvocation).toHaveBeenCalledWith(expect.objectContaining({ id: "screenshot" }), {
      udid: "sim-1",
    });
  });
});
