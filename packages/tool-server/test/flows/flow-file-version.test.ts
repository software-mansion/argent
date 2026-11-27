import { describe, expect, it } from "vitest";
import {
  flowFormatVersion,
  parseFlow,
  serializeFlow,
  isVersion1,
  type FlowFile,
} from "../../src/tools/flows/flow-utils";

// The top-level `version` key: a file without it is version 1. This file covers
// which files are version 1 and writing the key; flow-utils.test.ts covers
// parsing it, and flow-file-version-run.test.ts runs files of each version.

describe("which files are version 1", () => {
  it("reads a file without the key as version 1", () => {
    const flow = parseFlow("steps:\n  - echo: hi\n");
    expect(flowFormatVersion(flow)).toBe(1);
    expect(isVersion1(flow)).toBe(true);
  });

  it("reads version 1 as written", () => {
    const flow = parseFlow("version: 1\nsteps:\n  - echo: hi\n");
    expect(flowFormatVersion(flow)).toBe(1);
    expect(isVersion1(flow)).toBe(true);
  });

  it("reads version 2 as the current version", () => {
    const flow = parseFlow("version: 2\nsteps:\n  - echo: hi\n");
    expect(flowFormatVersion(flow)).toBe(2);
    expect(isVersion1(flow)).toBe(false);
  });

  it("treats a flow built without a version as current, like a recording", () => {
    expect(isVersion1({ executionPrerequisite: "", steps: [] })).toBe(false);
  });
});

describe("serializing `version`", () => {
  const steps: FlowFile["steps"] = [{ kind: "echo", message: "hi" }];

  it("writes version 2 for a new file", () => {
    const yaml = serializeFlow({ executionPrerequisite: "", steps });
    expect(yaml.startsWith("version: 2\n")).toBe(true);
    expect(isVersion1(parseFlow(yaml))).toBe(false);
  });

  // The version lives beside the parsed flow, not in it (flowFormatVersion):
  // only the runner reads it. No path writes a parsed version 1 file back; a
  // recording starts a new file.
  it.each([
    ["steps:\n  - echo: hi\n"],
    ["version: 1\nsteps:\n  - echo: hi\n"],
    ["version: 2\nsteps:\n  - echo: hi\n"],
  ])("writes version 2 for any parsed file", (content) => {
    const yaml = serializeFlow(parseFlow(content));
    expect(yaml.startsWith("version: 2\n")).toBe(true);
    expect(isVersion1(parseFlow(yaml))).toBe(false);
  });
});
