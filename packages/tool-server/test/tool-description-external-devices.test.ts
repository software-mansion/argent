import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@argent/registry";
import { createRegistry } from "../src/utils/setup-registry";
import { advertisedSchema, definitionsById } from "./helpers/catalog";

/**
 * Descriptions reach every agent on connect. Almost no machine has a provider,
 * so the catalog says nothing about them and the rules travel on paths that
 * exist only when a provider does: `list-devices`' `hint` and the runtime
 * denials.
 *
 * Swept catalog-wide, not per file. The prose crept in one sentence at a time.
 */
const PROVIDER_VOCABULARY = [
  /\bexternal device/i,
  /\bdevice provider/i,
  /\bexternal provider/i,
  /'external: true'/i,
  /\bext:/,
  /\bprovider\b/i,
];

/**
 * `provider` in an unrelated sense. Listed one by one so a new use is noticed.
 */
const UNRELATED = [
  /** screenshot-diff naming its OCR engine. */
  /provider=\w+/g,
  /text_analysis/g,
];

/**
 * Only the allowed token is removed, not the line carrying it. Dropping the
 * whole line would exempt everything beside it; `provider=text_analysis; use
 * the external provider` would sweep past the check on the strength of its
 * first half.
 */
function offendingLines(text: string): string[] {
  return text.split("\n").filter((line) => {
    const remaining = UNRELATED.reduce((rest, allowed) => rest.replace(allowed, ""), line);
    return PROVIDER_VOCABULARY.some((pattern) => pattern.test(remaining));
  });
}

/** Every description a client receives, the tool's, plus each parameter's. */
function agentFacingText(def: ToolDefinition<any, any>): string[] {
  const texts: string[] = [];
  if (def.description) texts.push(def.description);

  const schema = advertisedSchema(def);
  const properties = (schema?.properties ?? {}) as Record<string, { description?: unknown }>;

  for (const [name, property] of Object.entries(properties)) {
    if (typeof property?.description === "string") texts.push(`${name}: ${property.description}`);
  }

  return texts;
}

describe("device providers stay out of the always-shipped catalog", () => {
  const definitions = definitionsById(createRegistry());

  for (const [id, definition] of definitions) {
    it(`${id}: neither its description nor its parameters mention a device provider`, () => {
      const offending = agentFacingText(definition).flatMap(offendingLines);

      expect(
        offending,
        `${id} ships provider prose to every agent. Move it behind a runtime path that ` +
          `exists only when a provider does.`
      ).toEqual([]);
    });
  }
});
