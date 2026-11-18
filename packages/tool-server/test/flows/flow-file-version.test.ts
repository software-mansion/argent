import { describe, expect, it } from "vitest";
import {
  parseFlow,
  serializeFlow,
  isVersion1,
  type FlowFile,
} from "../../src/tools/flows/flow-utils";

// The top-level `version` key: a file without it is version 1. This file covers
// which files are version 1 and writing the key back; flow-utils.test.ts covers
// parsing it, and flow-file-version-run.test.ts runs files of each version.

describe("which files are version 1", () => {
  it("reads a file without the key as version 1", () => {
    const flow = parseFlow("steps:\n  - echo: hi\n");
    expect(flow.version).toBe(1);
    expect(isVersion1(flow)).toBe(true);
  });

  it("reads version 1 as written", () => {
    const flow = parseFlow("version: 1\nsteps:\n  - echo: hi\n");
    expect(flow.version).toBe(1);
    expect(isVersion1(flow)).toBe(true);
  });

  it("reads version 2 as the current version", () => {
    const flow = parseFlow("version: 2\nsteps:\n  - echo: hi\n");
    expect("version" in flow).toBe(false);
    expect(isVersion1(flow)).toBe(false);
  });

  it("treats a flow built without a version as current, like a recording", () => {
    expect(isVersion1({})).toBe(false);
  });
});

describe("serializing `version`", () => {
  const steps: FlowFile["steps"] = [{ kind: "echo", message: "hi" }];

  it("writes version 2 for a new file", () => {
    const yaml = serializeFlow({ executionPrerequisite: "", steps });
    expect(yaml.startsWith("version: 2\n")).toBe(true);
    expect(isVersion1(parseFlow(yaml))).toBe(false);
  });

  it.each([
    ["steps:\n  - echo: hi\n", 1],
    ["version: 1\nsteps:\n  - echo: hi\n", 1],
    ["version: 2\nsteps:\n  - echo: hi\n", 2],
  ])("keeps the version of a parsed file when it writes it back", (content, version) => {
    const yaml = serializeFlow(parseFlow(content));
    expect(yaml.startsWith(`version: ${version}\n`)).toBe(true);
    expect(isVersion1(parseFlow(yaml))).toBe(version === 1);
  });
});
