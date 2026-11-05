import { describe, it, expect } from "vitest";
import { toMcpTool, toMcpToolList } from "../src/tool-mapping.js";

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

  it("forwards readOnly as annotations.readOnlyHint", () => {
    const result = toMcpTool({ ...base, readOnly: true });
    expect(result.annotations).toEqual({ readOnlyHint: true });
  });

  it("omits annotations when readOnly is unset or false", () => {
    expect(toMcpTool(base)).not.toHaveProperty("annotations");
    expect(toMcpTool({ ...base, readOnly: false })).not.toHaveProperty("annotations");
  });

  it("leaves retired params (untyped `not: {}`) out of the advertised schema", () => {
    const result = toMcpTool({
      ...base,
      inputSchema: {
        properties: { foo: { type: "string" }, settle: { description: "Retired", not: {} } },
        additionalProperties: false,
      },
    });
    expect(result.inputSchema).toEqual({
      type: "object",
      properties: { foo: { type: "string" } },
      additionalProperties: false,
    });
  });

  it("keeps a param whose `not` is a real constraint", () => {
    const schema = { properties: { foo: { type: "string", not: { const: "" } } } };
    expect(toMcpTool({ ...base, inputSchema: schema }).inputSchema).toEqual({
      type: "object",
      ...schema,
    });
  });

  it("always forces inputSchema.type to 'object' and preserves other keys", () => {
    const result = toMcpTool(base);
    expect(result.inputSchema).toEqual({
      type: "object",
      properties: { foo: { type: "string" } },
    });
  });
});

describe("toMcpToolList", () => {
  it("drops tools marked hideFromMcp and maps the rest", () => {
    const schema = { properties: {} };
    const list = toMcpToolList([
      { name: "shown", description: "", inputSchema: schema },
      { name: "sdk-only", description: "", inputSchema: schema, hideFromMcp: true },
      { name: "also-shown", description: "", inputSchema: schema, hideFromMcp: false },
    ]);
    expect(list.map((t) => t.name)).toEqual(["shown", "also-shown"]);
    expect(list[0]).toEqual(toMcpTool({ name: "shown", description: "", inputSchema: schema }));
  });
});
