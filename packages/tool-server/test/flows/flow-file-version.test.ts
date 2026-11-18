import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore, CLIENT_FILE_MARKER, type ToolContext } from "@argent/registry";
import type { DescribeNode } from "../../src/tools/describe/contract";
import {
  __resetRecordingsForTesting,
  parseFlow,
  serializeFlow,
  usesViewHierarchy,
  type FlowFile,
} from "../../src/tools/flows/flow-utils";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { flowInsertEchoTool } from "../../src/tools/flows/flow-insert-echo";
import { flowFinishRecordingTool } from "../../src/tools/flows/flow-finish-recording";
import { evaluateCondition } from "../../src/utils/ui-tree-match";

// The top-level `version` key: absent or 1 runs an iOS simulator test on the
// view hierarchy as before version 2, 2 on the tree `describe` shows. This file
// covers what the version picks and the recorder; flow-utils.test.ts covers
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

describe("a recording is a version 2 file", () => {
  let root: string;
  beforeEach(async () => {
    __resetRecordingsForTesting();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-file-version-"));
  });
  afterEach(async () => {
    __resetRecordingsForTesting();
    await fs.rm(root, { recursive: true, force: true });
  });

  const firstLine = (yaml: string): string => yaml.split("\n")[0]!;

  it("starts the file with `version: 2` and keeps it through appends and the finish", async () => {
    const started = await flowStartRecordingTool.execute({}, { name: "rec", project_root: root });
    expect(firstLine(started.flowFile)).toBe("version: 2");
    const filePath = started.savedTo as string;
    expect(firstLine(await fs.readFile(filePath, "utf8"))).toBe("version: 2");

    await flowInsertEchoTool.execute({}, { name: "rec", project_root: root, message: "one" });
    await flowInsertEchoTool.execute({}, { name: "rec", project_root: root, message: "two" });
    const onDisk = parseFlow(await fs.readFile(filePath, "utf8"));
    expect(usesViewHierarchy(onDisk)).toBe(false);
    expect(onDisk.steps).toHaveLength(2);

    const finished = await flowFinishRecordingTool.execute({}, { name: "rec", project_root: root });
    expect(firstLine(finished.flowFile)).toBe("version: 2");
    expect(parseFlow(finished.flowFile).steps).toHaveLength(2);
  });

  it("keeps `version: 2` in client mode, where the in-memory copy is the take", async () => {
    // The project is not on this host, so every tool hands the YAML back.
    const clientRoot = path.join(root, "not-on-this-host");
    const ctx: ToolContext = {
      artifacts: new ArtifactStore(),
      fileInputs: {
        project_root: { clientPath: clientRoot, presentOnHost: false, viaUpload: false },
      },
    };
    const directive = (savedTo: unknown): string => {
      expect(savedTo).toMatchObject({ [CLIENT_FILE_MARKER]: true });
      return (savedTo as { content: string }).content;
    };

    const started = await flowStartRecordingTool.execute(
      {},
      { name: "rec", project_root: clientRoot },
      ctx
    );
    expect(firstLine(directive(started.savedTo))).toBe("version: 2");

    const echoed = await flowInsertEchoTool.execute(
      {},
      { name: "rec", project_root: clientRoot, message: "one" }
    );
    expect(firstLine(directive(echoed.savedTo))).toBe("version: 2");

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "rec", project_root: clientRoot }
    );
    expect(firstLine(directive(finished.savedTo))).toBe("version: 2");
    expect(parseFlow(finished.flowFile).steps).toEqual([{ kind: "echo", message: "one" }]);
    await expect(fs.stat(clientRoot)).rejects.toThrow();
  });
});

describe("an empty text field in a `matches` check", () => {
  // The view hierarchy carries no typed text, so before version 2 a text field
  // never read as empty; the accessibility tree carries it, so it can.
  const field = (partial: Partial<DescribeNode> = {}): DescribeNode => ({
    role: "AXTextField",
    identifier: "email",
    frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 },
    children: [],
    ...partial,
  });
  const emptyCheck = (node: DescribeNode, viewHierarchy: boolean): boolean =>
    evaluateCondition("text", "^$", [node], "matches", { viewHierarchy });

  it("reads an empty field as empty on the accessibility tree", () => {
    expect(emptyCheck(field(), false)).toBe(true);
  });

  it("never reads a field as empty on the view hierarchy", () => {
    expect(emptyCheck(field(), true)).toBe(false);
  });

  it("reads other empty elements as empty on either tree", () => {
    const view = field({ role: "AXGroup" });
    expect(emptyCheck(view, true)).toBe(true);
    expect(emptyCheck(view, false)).toBe(true);
  });
});
