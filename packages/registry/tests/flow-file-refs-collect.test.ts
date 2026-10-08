import { describe, it, expect } from "vitest";
import { baselineKeyFor, collectFlowRequests, flowMemberKey } from "../src/flow-file-refs";
import {
  hasToolFileExtension,
  isClientFileArgument,
  toolStepFiles,
  type FileInputSpec,
} from "../src/file-inputs";

describe("collectFlowRequests", () => {
  it("collects the run: targets of the steps and of every when: branch, taken or not", () => {
    const doc = {
      steps: [
        { echo: "start" },
        { run: "a.yaml" },
        {
          when: { platform: "ios" },
          steps: [
            { run: "ios.yaml" },
            { when: { platform: "ios" }, steps: [{ run: "deep.yaml" }] },
          ],
        },
        { when: { platform: "android" }, steps: [{ run: "android.yaml" }] },
      ],
    };

    expect(collectFlowRequests(doc)).toEqual({
      runTargets: ["a.yaml", "ios.yaml", "deep.yaml", "android.yaml"],
      snapshots: [],
      toolSteps: [],
    });
  });

  it("completes an extension-less target as the runner does, and keeps a relative path", () => {
    const doc = { steps: [{ run: "login" }, { run: "../shared/s2b" }, { run: "lib/x.yaml" }] };

    expect(collectFlowRequests(doc).runTargets).toEqual([
      "login.yaml",
      "../shared/s2b.yaml",
      "lib/x.yaml",
    ]);
  });

  it("takes nothing from a value the runner's parse refuses", () => {
    const doc = {
      steps: [
        { run: null },
        { run: 7 },
        { run: "/abs/a.yaml" },
        { run: "C:/a.yaml" },
        { run: "C:a.yaml" },
        { run: "dir\\a.yaml" },
        { run: "login.yml" },
        { run: "Login.YAML" },
        { run: "my flow" },
        { run: "shared/" },
        { run: "" },
        { run: "ok.yaml" },
      ],
    };

    expect(collectFlowRequests(doc).runTargets).toEqual(["ok.yaml"]);
  });

  it("lists a target once however often it is named", () => {
    const doc = {
      steps: [
        { run: "a.yaml" },
        { run: "a" },
        { when: { platform: "ios" }, steps: [{ run: "a.yaml" }, { run: "b.yaml" }] },
      ],
    };

    expect(collectFlowRequests(doc).runTargets).toEqual(["a.yaml", "b.yaml"]);
  });

  it("ends on steps that alias themselves", () => {
    // A YAML alias can make a block's steps contain the block itself.
    const steps: unknown[] = [{ run: "a.yaml" }];
    steps.push({ when: { platform: "ios" }, steps });

    expect(collectFlowRequests({ steps }).runTargets).toEqual(["a.yaml"]);
  });

  it("names nothing for a document that is not a flow", () => {
    for (const doc of [null, undefined, "steps", 3, [], { steps: "run: a.yaml" }, {}]) {
      expect(collectFlowRequests(doc)).toEqual({ runTargets: [], snapshots: [], toolSteps: [] });
    }
    expect(
      collectFlowRequests({ steps: [null, "run: a", 5, { run: "b.yaml" }] }).runTargets
    ).toEqual(["b.yaml"]);
  });
});

describe("collectFlowRequests snapshots", () => {
  it("collects the snapshot names of the steps and of every when: branch, in both spellings, once each", () => {
    const doc = {
      steps: [
        { snapshot: "home" },
        { snapshot: { name: "cart", maxMismatch: 1 } },
        { when: { platform: "android" }, steps: [{ snapshot: "home" }, { snapshot: "deep" }] },
      ],
    };

    expect(collectFlowRequests(doc).snapshots).toEqual(["home", "cart", "deep"]);
  });

  it("takes no name the runner's parse refuses", () => {
    const doc = {
      steps: [
        { snapshot: "../../etc/evil" },
        { snapshot: "a b" },
        { snapshot: { name: 7 } },
        { snapshot: null },
        { snapshot: "" },
        { snapshot: "ok_name-1" },
      ],
    };

    expect(collectFlowRequests(doc).snapshots).toEqual(["ok_name-1"]);
  });
});

describe("collectFlowRequests tool steps", () => {
  it("collects every tool: step with its args, in every when: branch, args or not", () => {
    const doc = {
      steps: [
        { tool: "screenshot-diff", args: { baselinePath: "/p/a.png", currentPath: "/p/b.png" } },
        { tool: "keyboard", args: { text: "/p/a.png" } },
        { when: { platform: "ios" }, steps: [{ tool: "describe" }] },
        { tool: 7, args: {} },
        { tool: "tap", args: "x" },
      ],
    };

    expect(collectFlowRequests(doc).toolSteps).toEqual([
      { tool: "screenshot-diff", args: { baselinePath: "/p/a.png", currentPath: "/p/b.png" } },
      { tool: "keyboard", args: { text: "/p/a.png" } },
      { tool: "describe", args: {} },
      { tool: "tap", args: {} },
    ]);
  });
});

describe("toolStepFiles and isClientFileArgument", () => {
  const diffSpecs: FileInputSpec[] = [
    { target: "baselinePath", path: "${baselinePath}", kind: "file", optional: true },
    { target: "currentPath", path: "${currentPath}", kind: "file", optional: true },
    { target: "outputDir", path: "${outputDir}", kind: "probe", optional: true },
  ];
  const prereqSpecs: FileInputSpec[] = [
    { target: "flow_path", path: "${flow_path}", kind: "file", unwrapWhenSet: "name" },
    {
      target: "flow_file",
      path: "${project_root}/.argent/flows/${name}.yaml",
      kind: "file",
      skipWhenSet: "flow_path",
    },
  ];

  it("fills the specs a step's args apply to", () => {
    expect(
      toolStepFiles(diffSpecs, { baselinePath: "/p/a.png", currentPath: "", outputDir: "/p/o" })
    ).toEqual([
      { spec: diffSpecs[0], path: "/p/a.png" },
      { spec: diffSpecs[2], path: "/p/o" },
    ]);
    expect(
      toolStepFiles(prereqSpecs, { flow_path: "/p/x.yaml", name: "x", project_root: "/p" })
    ).toEqual([{ spec: prereqSpecs[0], path: "/p/x.yaml" }]);
    expect(toolStepFiles(undefined, { baselinePath: "/p/a.png" })).toEqual([]);
  });

  it("takes only an absolute .png or .yaml file argument, in any case, as one the client sends", () => {
    const of = (specs: FileInputSpec[], args: Record<string, unknown>) =>
      toolStepFiles(specs, args).map(isClientFileArgument);

    expect(of(diffSpecs, { baselinePath: "/p/a.png", currentPath: "/p/B.PNG" })).toEqual([
      true,
      true,
    ]);
    expect(of(prereqSpecs, { flow_path: "/p/x.yaml" })).toEqual([true]);
    expect(of(diffSpecs, { baselinePath: "p/a.png", currentPath: "/p/a.webp" })).toEqual([
      false,
      false,
    ]);
    expect(of(diffSpecs, { outputDir: "/p/out.png" })).toEqual([false]);
    // Built from two arguments: not one argument as written.
    expect(of(prereqSpecs, { name: "x", project_root: "/p" })).toEqual([false]);
    expect(hasToolFileExtension("/p/a.YAML")).toBe(true);
    expect(hasToolFileExtension("/p/a.yml")).toBe(false);
  });
});

describe("baselineKeyFor", () => {
  it("keys by the canonical file's stem, and falls back to the flow name for an unsafe one", () => {
    expect(baselineKeyFor("/p/vault/b-smoke.yaml", "smoke")).toBe("b-smoke");
    expect(baselineKeyFor("/p/vault/...yaml", "smoke")).toBe("smoke");
    expect(baselineKeyFor("/p/vault/.yaml", "smoke")).toBe("smoke");
    expect(baselineKeyFor("/p/vault/my flow.yaml", "smoke")).toBe("smoke");
  });
});

describe("flowMemberKey", () => {
  it("keeps the pair apart even when the joined paths agree", () => {
    expect(flowMemberKey("/p/flows", "a.yaml")).not.toBe(flowMemberKey("/p", "flows/a.yaml"));
    expect(flowMemberKey("/p/flows", "a.yaml")).toBe("/p/flows\0a.yaml");
  });
});
