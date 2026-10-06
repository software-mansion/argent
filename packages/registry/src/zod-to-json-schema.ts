import { z } from "zod";

/**
 * Convert a tool's Zod input schema to the JSON Schema advertised to MCP / LLM
 * clients.
 *
 * - `io: "input"` keeps `.default()` / `.optional()` fields out of `required`.
 * - `unrepresentable: "any"` degrades an exotic field type to `{}` rather than
 *   throwing, so a tool carrying such a field still registers.
 */
export function zodObjectToJsonSchema(schema: z.ZodObject<any>): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  delete jsonSchema.$schema;
  return jsonSchema;
}
