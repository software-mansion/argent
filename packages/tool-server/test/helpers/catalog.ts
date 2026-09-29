import { zodObjectToJsonSchema, type Registry, type ToolDefinition } from "@argent/registry";
import { createProposeVariantTool } from "../../src/tools/variants/propose-variant";
import { awaitUserSelectionTool } from "../../src/tools/variants/await-user-selection";

/** Every tool argent can serve. Bump deliberately when a tool is added or removed. */
export const EXPECTED_TOOL_COUNT = 80;

/**
 * The full catalog, keyed by id. The Lens tools never reach
 * `registry.registerTool` off macOS, so they are added by hand and CI covers
 * one catalog everywhere.
 */
export function definitionsById(registry: Registry): Map<string, ToolDefinition<any, any>> {
  const definitions = new Map<string, ToolDefinition<any, any>>();
  for (const id of registry.getSnapshot().tools) {
    definitions.set(id, registry.getTool(id)!);
  }

  definitions.set("propose_variant", createProposeVariantTool(registry));
  definitions.set("await_user_selection", awaitUserSelectionTool);
  return definitions;
}

/**
 * The schema a client actually receives: the explicit one if a definition
 * carries it, else the one `Registry.registerTool` derives. Null when a
 * definition declares neither, so the caller can report that as its own
 * failure rather than dereferencing undefined.
 */
export function advertisedSchema(def: ToolDefinition<any, any>): Record<string, unknown> | null {
  if (def.inputSchema) return def.inputSchema;
  return def.zodSchema ? zodObjectToJsonSchema(def.zodSchema) : null;
}

/**
 * JSON Schema keywords that must never appear at the TOP LEVEL of a tool's
 * input_schema.
 *
 * Rejected outright by the Anthropic Messages API — "input_schema does not
 * support oneOf, allOf, or anyOf at the top level", HTTP 400. The 400 fails the
 * WHOLE request, every tool in it, so a single offending schema bricks any
 * client that forwards ours verbatim (issue #773):
 *   oneOf, allOf, anyOf
 *
 * Blocked pre-emptively, not rejected by the API — they are the natural way to
 * re-encode a rejected combinator, and no model reads them anyway:
 *   not, if, then, else, $ref, $schema
 *
 * TOP LEVEL ONLY. A combinator nested inside `properties` is legal and in use:
 * tv-remote's `button` is a z.union.
 */
export const CLIENT_UNSAFE_TOP_LEVEL_KEYWORDS = [
  "oneOf",
  "allOf",
  "anyOf",
  "not",
  "if",
  "then",
  "else",
  "$ref",
  "$schema",
] as const;
