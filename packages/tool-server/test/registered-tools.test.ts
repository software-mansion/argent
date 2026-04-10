import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { getRegisteredToolIds } from "../src/utils/registered-tools";

describe("getRegisteredToolIds", () => {
  it("matches the generated Codex tool approval manifest", () => {
    const generatedManifestPath = path.resolve(
      import.meta.dirname,
      "../../mcp/src/generated/argent-tool-names.json"
    );
    const generatedToolIds = JSON.parse(fs.readFileSync(generatedManifestPath, "utf8")) as string[];

    expect([...getRegisteredToolIds()].sort()).toEqual(generatedToolIds);
  });
});
