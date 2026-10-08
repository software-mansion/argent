import * as path from "node:path";
import { describe, it, expect } from "vitest";
import { nestedFlowTarget } from "../src/flow-file-refs";
import { LINKED_CALL_HEADER, nestedFlowTarget as exported } from "../src/index";

// The one form decision both sides of a link share: the client sends the flow
// of a `name` step with the call, and the tool-server runs a nested step over
// a link only in that form, so every accepted shape and every refusal is
// pinned here.
describe("nestedFlowTarget", () => {
  it("accepts a flow name with an absolute project_root, whatever else the args carry", () => {
    expect(nestedFlowTarget({ name: "login", project_root: "/client/proj" })).toEqual({
      kind: "name",
      projectRoot: "/client/proj",
      name: "login",
      path: "/client/proj/.argent/flows/login.yaml",
    });
    // Every character class of a flow name, the device and run keys beside it,
    // and a flow_path key that is present but undefined (no flow_path).
    expect(
      nestedFlowTarget({
        name: "Login_2-x",
        project_root: "/client/proj",
        udid: "sim-1",
        updateBaselines: true,
        flow_path: undefined,
      })
    ).toEqual({
      kind: "name",
      projectRoot: "/client/proj",
      name: "Login_2-x",
      path: "/client/proj/.argent/flows/Login_2-x.yaml",
    });
  });

  it("builds the saved flow's path with path.join and keeps project_root as given", () => {
    const roots: Array<[string, string]> = [
      ["/client/proj/", "/client/proj/.argent/flows/login.yaml"],
      ["/client//proj", "/client/proj/.argent/flows/login.yaml"],
      ["/client/./proj", "/client/proj/.argent/flows/login.yaml"],
      ["/", "/.argent/flows/login.yaml"],
      // Only a whole `..` segment is refused; a name that starts with two dots is not one.
      ["/client/..proj", "/client/..proj/.argent/flows/login.yaml"],
    ];
    for (const [root, expected] of roots) {
      const target = nestedFlowTarget({ name: "login", project_root: root });
      expect(target, root).toEqual({
        kind: "name",
        projectRoot: root,
        name: "login",
        path: expected,
      });
      expect(target?.path, root).toBe(path.join(root, ".argent", "flows", "login.yaml"));
    }
  });

  it("accepts an absolute flow_path to a <flow-name>.yaml file without name, kept as given", () => {
    expect(nestedFlowTarget({ flow_path: "/client/proj/.argent/flows/login.yaml" })).toEqual({
      kind: "flow_path",
      path: "/client/proj/.argent/flows/login.yaml",
    });
    // project_root is not judged for a flow_path, and the path is not normalized.
    expect(
      nestedFlowTarget({
        flow_path: "/client//proj/./Login_2-x.yaml",
        project_root: "/client/proj",
        name: undefined,
        udid: "sim-1",
      })
    ).toEqual({ kind: "flow_path", path: "/client//proj/./Login_2-x.yaml" });
  });

  it("refuses args that are not a plain object", () => {
    for (const args of [undefined, null, "login", 42, true]) {
      expect(nestedFlowTarget(args), String(args)).toBeUndefined();
    }
    expect(nestedFlowTarget([])).toBeUndefined();
    expect(nestedFlowTarget([{ name: "login", project_root: "/client/proj" }])).toBeUndefined();
  });

  it("refuses a missing name, or a name that is not a flow name", () => {
    expect(nestedFlowTarget({})).toBeUndefined();
    expect(nestedFlowTarget({ project_root: "/client/proj" })).toBeUndefined();
    for (const name of [42, null, "", "../login", "login.yaml", "a/b", "a b", "login\n", "naïve"]) {
      expect(nestedFlowTarget({ name, project_root: "/client/proj" }), JSON.stringify(name)).toBe(
        undefined
      );
    }
  });

  it("refuses a project_root that is missing, not a string, or relative", () => {
    expect(nestedFlowTarget({ name: "login" })).toBeUndefined();
    for (const root of [42, null, "", "proj", "./proj", "~/proj", "../proj"]) {
      expect(nestedFlowTarget({ name: "login", project_root: root }), String(root)).toBeUndefined();
    }
  });

  it("refuses a project_root with a `..` segment, with either separator", () => {
    for (const root of [
      "/client/../proj",
      "/client/proj/..",
      "/client/proj/../",
      "/..",
      "/client\\..\\proj",
    ]) {
      expect(nestedFlowTarget({ name: "login", project_root: root }), root).toBeUndefined();
    }
  });

  it("refuses name and flow_path together, whatever the name holds", () => {
    const flowPath = "/client/proj/.argent/flows/login.yaml";
    expect(
      nestedFlowTarget({ name: "login", project_root: "/client/proj", flow_path: flowPath })
    ).toBeUndefined();
    expect(nestedFlowTarget({ name: 42, flow_path: flowPath })).toBeUndefined();
    expect(nestedFlowTarget({ name: null, flow_path: flowPath })).toBeUndefined();
  });

  it("refuses a flow_path that is not an absolute path", () => {
    for (const flowPath of [
      "login.yaml",
      "flows/login.yaml",
      "./login.yaml",
      "~/login.yaml",
      "",
      42,
      null,
    ]) {
      expect(nestedFlowTarget({ flow_path: flowPath }), String(flowPath)).toBeUndefined();
    }
  });

  it("refuses a flow_path with a `..` segment, with either separator", () => {
    for (const flowPath of [
      "/client/proj/../login.yaml",
      "/client/../proj/.argent/flows/login.yaml",
      "/client\\..\\login.yaml",
    ]) {
      expect(nestedFlowTarget({ flow_path: flowPath }), flowPath).toBeUndefined();
    }
  });

  it("refuses a flow_path whose basename is not <flow-name>.yaml", () => {
    for (const flowPath of [
      "/client/login.yml",
      "/client/login.YAML",
      "/client/login",
      "/client/login.yaml.bak",
      "/client/a.b.yaml",
      "/client/my flow.yaml",
      "/client/.yaml",
      "/client/flows/",
      "/",
    ]) {
      expect(nestedFlowTarget({ flow_path: flowPath }), flowPath).toBeUndefined();
    }
  });
});

describe("the registry entry point", () => {
  it("exports nestedFlowTarget and the header a call over a link carries", () => {
    expect(exported).toBe(nestedFlowTarget);
    expect(LINKED_CALL_HEADER).toBe("x-argent-linked");
  });
});
