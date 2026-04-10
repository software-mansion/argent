import { describe, expect, it } from "vitest";
import { createRegistry } from "../src/utils/setup-registry";
import { getRegisteredToolIds } from "../src/utils/registered-tools";

describe("getRegisteredToolIds", () => {
  it("matches the live registry snapshot", () => {
    const registry = createRegistry();

    expect([...getRegisteredToolIds()].sort()).toEqual([...registry.getSnapshot().tools].sort());
  });
});
