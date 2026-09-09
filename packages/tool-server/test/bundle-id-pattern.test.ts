import { describe, expect, it } from "vitest";
import type { ZodObject, ZodTypeAny } from "zod";
import { createRegistry } from "../src/utils/setup-registry";
import { advertisedSchema, definitionsById } from "./helpers/catalog";

// Asserted over the whole catalog rather than per tool, so a fifth bundleId
// constraint has to satisfy the same rules instead of drifting (issue #1024).
describe("advertised bundleId pattern", () => {
  const constrained = [...definitionsById(createRegistry())]
    .map(([id, definition]) => {
      const properties = advertisedSchema(definition)?.properties as
        | Record<string, { pattern?: string } | undefined>
        | undefined;
      const shape = (definition.zodSchema as ZodObject<Record<string, ZodTypeAny>> | undefined)
        ?.shape;
      return { id, pattern: properties?.bundleId?.pattern, field: shape?.bundleId };
    })
    .filter((entry) => typeof entry.pattern === "string");

  it("is advertised by exactly the tools that take an app identifier", () => {
    expect(constrained.map(({ id }) => id).sort()).toEqual([
      "launch-app",
      "reinstall-app",
      "restart-app",
      "settings-permissions",
    ]);
  });

  for (const { id, pattern, field } of constrained) {
    it(`${id}: admits a digit-leading bundle id and still refuses a flag`, () => {
      const re = new RegExp(pattern!);
      // An iOS CFBundleIdentifier may begin with a digit; `9gag.app` ships.
      expect(re.test("9gag.app")).toBe(true);
      expect(re.test("3d.tools.app")).toBe(true);
      expect(re.test("com.example.app")).toBe(true);
      // The head keeps out anything argv could read as a flag or a dotfile.
      expect(re.test("--user")).toBe(false);
      expect(re.test("-user")).toBe(false);
      expect(re.test(".hidden")).toBe(false);
    });

    it(`${id}: names the head rule when it rejects one`, () => {
      const rejected = field!.safeParse("--user");
      expect(rejected.success).toBe(false);
      expect(rejected.error!.issues[0]!.message).toContain("may not start with '-' or '.'");
    });
  }
});
