import { z } from "zod";

/**
 * Convert a tool's Zod input schema to the JSON Schema advertised to MCP / LLM
 * clients. Delegates to Zod 4's native `z.toJSONSchema` instead of a hand-rolled
 * type walk: the previous converter silently dropped every `.describe()` text
 * and `.min/.max/.int/.regex` constraint and emitted a match-anything `{}` for
 * unions/literals — so the schema the model saw for each tool was lossy.
 *
 * - `io: "input"` so a field with `.default()` / `.optional()` is not marked
 *   `required` (the caller need not supply it) — matching the old behavior.
 * - `unrepresentable: "any"` degrades an exotic field type to `{}` rather than
 *   throwing, so a tool carrying such a field still registers.
 * - The `$schema` dialect tag is stripped; it is noise in the per-tool payload.
 */
export function zodObjectToJsonSchema(schema: z.ZodObject<any>): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  delete jsonSchema.$schema;
  return jsonSchema;
}
