import { describe, expect, it } from "vitest";
import {
  parseFlow,
  serializeFlow,
  usesViewHierarchy,
  type FlowFile,
} from "../../src/tools/flows/flow-utils";

// The top-level `version` key: absent or 1 runs an iOS simulator test on the
// view hierarchy as before version 2, 2 on the tree `describe` shows. This file
// covers what the version picks and writing it back; flow-utils.test.ts covers
// parsing the key, and flow-file-version-run.test.ts runs files of each version.

describe("the tree a file's version picks", () => {
  it("reads a file without the key as version 1, which reads the view hierarchy", () => {
    const flow = parseFlow("steps:\n  - echo: hi\n");
    expect(flow.version).toBe(1);
    expect(usesViewHierarchy(flow)).toBe(true);
  });

  it("reads version 1 as written, which reads the view hierarchy", () => {
    const flow = parseFlow("version: 1\nsteps:\n  - echo: hi\n");
    expect(flow.version).toBe(1);
    expect(usesViewHierarchy(flow)).toBe(true);
  });

  it("reads version 2 as the current version, which reads the describe tree", () => {
    const flow = parseFlow("version: 2\nsteps:\n  - echo: hi\n");
    expect("version" in flow).toBe(false);
    expect(usesViewHierarchy(flow)).toBe(false);
  });

  it("treats a flow built without a version as current, like a recording", () => {
    expect(usesViewHierarchy({})).toBe(false);
  });
});

describe("serializing `version`", () => {
  const steps: FlowFile["steps"] = [{ kind: "echo", message: "hi" }];

  it("writes version 2 for a new file", () => {
    const yaml = serializeFlow({ executionPrerequisite: "", steps });
    expect(yaml.startsWith("version: 2\n")).toBe(true);
    expect(usesViewHierarchy(parseFlow(yaml))).toBe(false);
  });

  it.each([
    ["steps:\n  - echo: hi\n", 1],
    ["version: 1\nsteps:\n  - echo: hi\n", 1],
    ["version: 2\nsteps:\n  - echo: hi\n", 2],
  ])("keeps the version of a parsed file when it writes it back", (content, version) => {
    const yaml = serializeFlow(parseFlow(content));
    expect(yaml.startsWith(`version: ${version}\n`)).toBe(true);
    expect(usesViewHierarchy(parseFlow(yaml))).toBe(version === 1);
  });
});
