import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/utils/setup-registry";
import { toolStepUploadIssue } from "../../src/tools/flows/flow-tool-inputs";

describe("toolStepUploadIssue", () => {
  it("runs an e2e-read-prerequisite step whose flow_path the client sends, beside a project_root", () => {
    const issue = toolStepUploadIssue(
      createRegistry(),
      "e2e-read-prerequisite",
      { flow_path: "/p/.argent/e2e/x.yaml", project_root: "/p" },
      true
    );

    expect(issue).toBeUndefined();
  });

  it("lists only the derived test file of a refused e2e-read-prerequisite step, not its project_root", () => {
    const issue = toolStepUploadIssue(
      createRegistry(),
      "e2e-read-prerequisite",
      { name: "x", project_root: "/p" },
      true
    );

    expect(issue).toEqual({
      kind: "toolFile",
      line: "tool: e2e-read-prerequisite (/p/.argent/flows/x.yaml)",
      fixes: [],
    });
  });

  it("still refuses screenshot-diff's outputDir probe", () => {
    const issue = toolStepUploadIssue(
      createRegistry(),
      "screenshot-diff",
      { baselinePath: "/p/a.png", currentPath: "/p/b.png", outputDir: "/p/out" },
      true
    );

    expect(issue?.line).toBe("tool: screenshot-diff (/p/out)");
  });
});
