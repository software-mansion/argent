import { describe, it, expect } from "vitest";
import { collectFlowRequests, flowMemberKey } from "../src/flow-file-refs";

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
      expect(collectFlowRequests(doc)).toEqual({ runTargets: [] });
    }
    expect(
      collectFlowRequests({ steps: [null, "run: a", 5, { run: "b.yaml" }] }).runTargets
    ).toEqual(["b.yaml"]);
  });
});

describe("flowMemberKey", () => {
  it("keeps the pair apart even when the joined paths agree", () => {
    expect(flowMemberKey("/p/flows", "a.yaml")).not.toBe(flowMemberKey("/p", "flows/a.yaml"));
    expect(flowMemberKey("/p/flows", "a.yaml")).toBe("/p/flows\0a.yaml");
  });
});
