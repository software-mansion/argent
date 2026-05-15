import { describe, it, expect } from "vitest";
import { toMcpTool } from "../src/tool-mapping.js";

describe("toMcpTool — MCP _meta forwarding", () => {
  const base = {
    name: "example",
    description: "desc",
    inputSchema: { properties: { foo: { type: "string" } } },
  };

  it("forwards alwaysLoad as _meta['anthropic/alwaysLoad']", () => {
    const result = toMcpTool({ ...base, alwaysLoad: true });
    expect(result._meta).toEqual({ "anthropic/alwaysLoad": true });
  });

  it("forwards searchHint as _meta['anthropic/searchHint']", () => {
    const result = toMcpTool({ ...base, searchHint: "tap press touch" });
    expect(result._meta).toEqual({ "anthropic/searchHint": "tap press touch" });
  });

  it("forwards both when set", () => {
    const result = toMcpTool({
      ...base,
      alwaysLoad: true,
      searchHint: "discovery",
    });
    expect(result._meta).toEqual({
      "anthropic/alwaysLoad": true,
      "anthropic/searchHint": "discovery",
    });
  });

  it("omits _meta entirely when neither field is set", () => {
    const result = toMcpTool(base);
    expect(result).not.toHaveProperty("_meta");
  });

  it("omits _meta when alwaysLoad is false and searchHint is undefined", () => {
    const result = toMcpTool({ ...base, alwaysLoad: false });
    expect(result).not.toHaveProperty("_meta");
  });

  it("drops empty-string searchHint rather than forwarding it", () => {
    const result = toMcpTool({ ...base, searchHint: "" });
    expect(result).not.toHaveProperty("_meta");
  });

  it("always forces inputSchema.type to 'object' and preserves other keys", () => {
    const result = toMcpTool(base);
    expect(result.inputSchema).toEqual({
      type: "object",
      properties: { foo: { type: "string" } },
    });
  });
});
