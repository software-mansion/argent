import { describe, expect, it } from "vitest";
import { createRegistry } from "../src/utils/setup-registry";
import {
  advertisedSchema,
  definitionsById,
  CLIENT_UNSAFE_TOP_LEVEL_KEYWORDS,
  EXPECTED_TOOL_COUNT,
} from "./helpers/catalog";

// Three tools once shipped a hand-written inputSchema that spread a top-level
// oneOf/anyOf onto the derived schema, to express a cross-field rule zod cannot
// represent in JSON Schema. The Anthropic Messages API rejects that with a 400
// that fails the whole request — every tool in it — so the tools were unusable
// through any client forwarding our schemas verbatim (issue #773). Claude Code
// happens to strip the keyword before sending, which is why our own QA never
// saw it; this test is what does see it.
//
// This is a denylist, deliberately not an allowlist of permitted top-level
// keys: `additionalProperties` legitimately appears at the top level on the
// schemas derived from `.strict()` objects (screenshot-diff,
// stop-all-simulator-servers), and `required` is absent entirely on a schema
// with no required fields.
describe("advertised tool input schemas", () => {
  const definitions = definitionsById(createRegistry());

  it("covers the whole catalog", () => {
    expect(definitions.size).toBe(EXPECTED_TOOL_COUNT);
  });

  for (const [id, definition] of definitions) {
    it(`${id}: is a plain object schema with no top-level combinator`, () => {
      const schema = advertisedSchema(definition);
      expect(schema, `${id} declares neither zodSchema nor inputSchema`).not.toBeNull();

      const offending = CLIENT_UNSAFE_TOP_LEVEL_KEYWORDS.filter((keyword) => keyword in schema!);
      expect(offending, `${id} declares top-level ${offending.join("/")}`).toEqual([]);

      expect(schema!.type, `${id}.type`).toBe("object");
      expect(typeof schema!.properties, `${id}.properties`).toBe("object");
    });
  }
});
