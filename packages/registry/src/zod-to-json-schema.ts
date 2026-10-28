import { z } from "zod";

/**
 * Convert a tool's Zod input schema to the JSON Schema advertised to MCP / LLM
 * clients.
 *
 * - `io: "input"` keeps `.default()` / `.optional()` fields out of `required`.
 * - `unrepresentable: "any"` degrades an exotic field type to `{}` rather than
 *   throwing, so a tool carrying such a field still registers.
 * - `.int()` emits the safe-integer range (±9007199254740991) as `minimum` /
 *   `maximum`. It tells the model nothing and is sent with every tool, so it is
 *   dropped; a bound the tool sets itself stays.
 */
export function zodObjectToJsonSchema(schema: z.ZodObject<any>): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
    override: ({ jsonSchema: node }) => {
      if (node.minimum === Number.MIN_SAFE_INTEGER) delete node.minimum;
      if (node.maximum === Number.MAX_SAFE_INTEGER) delete node.maximum;
    },
  }) as Record<string, unknown>;
  delete jsonSchema.$schema;
  return jsonSchema;
}
