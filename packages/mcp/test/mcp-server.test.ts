import { describe, it, expect } from "vitest";

describe("mcp-server module", () => {
  it("exports startMcpServer as an async function", async () => {
    const mod = await import("../src/mcp-server.js");
    expect(typeof mod.startMcpServer).toBe("function");
  });
});
