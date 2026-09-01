import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MIN_SCRIPT_TIMEOUT_MS } from "@argent/configuration-core";
import type { Registry } from "@argent/registry";
import { SCRIPT_FILE_NAME_PATTERN } from "@argent/registry";
import {
  parseFlow,
  scriptInterpreter,
  serializeFlow,
  type FlowStep,
} from "../../../src/tools/flows/flow-utils";
import { flowStartRecordingTool } from "../../../src/tools/flows/flow-start-recording";
import { createFlowAddStepTool } from "../../../src/tools/flows/flow-add-step";
import { flowFinishRecordingTool } from "../../../src/tools/flows/flow-finish-recording";
import { summarizeStep } from "../../../src/tools/flows/flow-finish-recording";

const parse = (yaml: string): FlowStep[] => parseFlow(yaml).steps;
const step = (body: string): FlowStep[] => parse(`steps:\n  - script: ${body}\n`);

describe("script step syntax", () => {
  it("parses the canonical map form", () => {
    expect(step("{ path: scripts/seed.mjs }")).toEqual([
      { kind: "script", path: "scripts/seed.mjs" },
    ]);
  });

  it("parses a time limit beside the path", () => {
    expect(step("{ path: scripts/seed.mjs, timeout: 45000 }")).toEqual([
      { kind: "script", path: "scripts/seed.mjs", timeout: 45000 },
    ]);
  });

  it("round-trips through serialization, minimal spelling intact", () => {
    const yaml = serializeFlow({
      executionPrerequisite: "",
      steps: [{ kind: "script", path: "scripts/seed.mjs" }],
    });
    expect(yaml).toContain("path: scripts/seed.mjs");
    expect(yaml).not.toContain("timeout");
    expect(parseFlow(yaml).steps).toEqual([{ kind: "script", path: "scripts/seed.mjs" }]);
  });

  it("round-trips a time limit", () => {
    const steps: FlowStep[] = [{ kind: "script", path: "../shared/seed.mjs", timeout: 5000 }];
    expect(parseFlow(serializeFlow({ executionPrerequisite: "", steps })).steps).toEqual(steps);
  });

  it("summarizes as its own kind, with the limit that changes what runs", () => {
    expect(summarizeStep({ kind: "script", path: "scripts/seed.mjs" }, 1)).toBe(
      "1. script: scripts/seed.mjs"
    );
    expect(summarizeStep({ kind: "script", path: "scripts/seed.mjs", timeout: 5000 }, 2)).toBe(
      "2. script: scripts/seed.mjs (timeout 5000ms)"
    );
  });
});

describe("script step rejections", () => {
  it("refuses a bare path — the value is always a map", () => {
    expect(() => step("scripts/seed.mjs")).toThrow(/takes a map, not a bare path/);
  });

  it("refuses an option written beside the directive key", () => {
    expect(() => parse("steps:\n  - script: { path: seed.mjs }\n    timeout: 30000\n")).toThrow(
      /step options go inside the `script:` value, not beside it/
    );
  });

  it("refuses an unknown key inside the map", () => {
    expect(() => step("{ path: seed.mjs, retries: 3 }")).toThrow(
      /script has unknown key `retries`.*allowed keys: path, timeout/s
    );
  });

  it("refuses `env`, whose release has not landed", () => {
    expect(() => step("{ path: seed.mjs, env: { TOKEN: abc } }")).toThrow(
      /script has unknown key `env`/
    );
  });

  it("refuses a missing, empty or non-string path", () => {
    for (const body of [
      "{ timeout: 1000 }",
      "{ path: }",
      '{ path: "" }',
      "{ path: 42 }",
      "{ path: true }",
    ]) {
      expect(() => step(body), body).toThrow(/needs a `path`/);
    }
  });

  it("refuses a non-positive or non-finite timeout", () => {
    for (const body of [
      "{ path: seed.mjs, timeout: 0 }",
      "{ path: seed.mjs, timeout: -1 }",
      "{ path: seed.mjs, timeout: .inf }",
      "{ path: seed.mjs, timeout: .nan }",
      "{ path: seed.mjs, timeout: fast }",
    ]) {
      expect(() => step(body), body).toThrow(/script.timeout needs a positive number/);
    }
  });

  it("admits a fractional time limit above the floor, unlike idle.stableFor", () => {
    expect(step("{ path: seed.mjs, timeout: 1500.5 }")).toEqual([
      { kind: "script", path: "seed.mjs", timeout: 1500.5 },
    ]);
  });

  it("refuses a time limit the step spends on its own startup", () => {
    for (const body of [
      "{ path: seed.mjs, timeout: 0.5 }",
      "{ path: seed.mjs, timeout: 1 }",
      "{ path: seed.mjs, timeout: 30 }",
      "{ path: seed.mjs, timeout: 99.9 }",
    ]) {
      expect(() => step(body), body).toThrow(
        /script.timeout is in milliseconds and needs at least 100/
      );
    }
  });

  it("admits the floor itself and the sub-second limits above it", () => {
    expect(step("{ path: seed.mjs, timeout: 100 }")).toEqual([
      { kind: "script", path: "seed.mjs", timeout: 100 },
    ]);
    expect(step("{ path: seed.mjs, timeout: 800 }")).toEqual([
      { kind: "script", path: "seed.mjs", timeout: 800 },
    ]);
  });

  // The literals above read 100 because the shared bound does. Parse and the
  // executor floor the same value from the same constant, so a change to it
  // moves both at once — pinned here so a second literal cannot reappear and
  // let the two drift apart while every fixed-number case still passes.
  it("takes its floor from the bound the executor clamps to", () => {
    const floor = MIN_SCRIPT_TIMEOUT_MS;
    expect(step(`{ path: seed.mjs, timeout: ${floor} }`)).toEqual([
      { kind: "script", path: "seed.mjs", timeout: floor },
    ]);
    expect(() => step(`{ path: seed.mjs, timeout: ${floor - 1} }`)).toThrow(
      new RegExp(`script.timeout is in milliseconds and needs at least ${floor}\\b`)
    );
  });

  it("refuses a body that is not a map", () => {
    for (const body of ["", "[seed.mjs]", "42"]) {
      expect(() => step(body), body).toThrow(/script needs \{ path, timeout\? \}|takes a map/);
    }
  });
});

describe("script path rules, shared with a run: target", () => {
  it("refuses a backslash", () => {
    expect(() => step("{ path: scripts\\\\seed.mjs }")).toThrow(/uses forward slashes/);
  });

  it("refuses an absolute path", () => {
    expect(() => step("{ path: /abs/seed.mjs }")).toThrow(/must be relative to the flow file/);
  });

  it("refuses a Windows drive-relative prefix", () => {
    // `C:foo` resolves against that drive's own current directory.
    expect(() => step("{ path: C:seed.mjs }")).toThrow(/must be relative to the flow file/);
    expect(() => step("{ path: 'C:/seed.mjs' }")).toThrow(/must be relative to the flow file/);
  });

  it("refuses an uppercase extension, saying which spelling it wants", () => {
    expect(() => step("{ path: scripts/SEED.MJS }")).toThrow(/lowercase .mjs extension/);
    expect(() => step("{ path: scripts/seed.SH }")).toThrow(/lowercase .sh extension/);
  });

  it("refuses any other extension, and never completes a bare name", () => {
    for (const body of [
      "{ path: seed }",
      "{ path: seed.js }",
      "{ path: seed.cjs }",
      // One spelling per language: `.bash` would be a second name for `.sh`,
      // as `.js` would be for `.mjs`.
      "{ path: seed.bash }",
      "{ path: seed.zsh }",
    ]) {
      expect(() => step(body), body).toThrow(/must end in .mjs or .sh/);
    }
  });

  it("refuses a basename outside the charset, before it looks at the extension", () => {
    for (const body of [
      "{ path: 'my seed.mjs' }",
      "{ path: seed.step.mjs }",
      "{ path: 'sc/.mjs' }",
      "{ path: 'my seed.sh' }",
      "{ path: seed.step.sh }",
      "{ path: 'sc/.sh' }",
    ]) {
      expect(() => step(body), body).toThrow(/filename must match/);
    }
  });

  it("admits `..`, because shared code may sit outside the flow's directory", () => {
    expect(step("{ path: ../../shared/seed.mjs }")).toEqual([
      { kind: "script", path: "../../shared/seed.mjs" },
    ]);
  });
});

describe("the second language reads exactly like the first", () => {
  it("parses a .sh path, with and without a time limit", () => {
    expect(step("{ path: scripts/seed.sh }")).toEqual([
      { kind: "script", path: "scripts/seed.sh" },
    ]);
    expect(step("{ path: ../../scripts/seed-order.sh, timeout: 45000 }")).toEqual([
      { kind: "script", path: "../../scripts/seed-order.sh", timeout: 45000 },
    ]);
  });

  it("round-trips a .sh step and summarizes it the same way", () => {
    const steps: FlowStep[] = [{ kind: "script", path: "scripts/seed.sh", timeout: 5000 }];
    expect(parseFlow(serializeFlow({ executionPrerequisite: "", steps })).steps).toEqual(steps);
    expect(summarizeStep(steps[0]!, 1)).toBe("1. script: scripts/seed.sh (timeout 5000ms)");
  });

  // The pattern is what every route enforces and the function is what picks the
  // interpreter, so widening one without the other has to fail here rather than
  // reach a flow as "bash ran my .mjs".
  it("maps every basename the pattern accepts to an interpreter", () => {
    const cases: Array<[string, "node" | "bash"]> = [
      ["seed.mjs", "node"],
      ["seed-order_2.mjs", "node"],
      ["seed.sh", "bash"],
      ["seed-order_2.sh", "bash"],
    ];
    for (const [name, interpreter] of cases) {
      expect(SCRIPT_FILE_NAME_PATTERN.test(name), name).toBe(true);
      expect(scriptInterpreter(`scripts/${name}`), name).toBe(interpreter);
    }
    // Nothing else the pattern would accept, asked of the extensions rather
    // than of the source: an alternation added OUTSIDE the group would leave
    // the source reading `(mjs|sh)` while handing a `.bash` file to node.
    for (const extension of [
      "mjs",
      "sh",
      "js",
      "cjs",
      "mts",
      "bash",
      "zsh",
      "ksh",
      "fish",
      "py",
      "SH",
      "MJS",
      "Sh",
    ]) {
      const name = `seed.${extension}`;
      const accepted = SCRIPT_FILE_NAME_PATTERN.test(name);
      expect(accepted, name).toBe(extension === "mjs" || extension === "sh");
      if (accepted) {
        expect(scriptInterpreter(name), name).toBe(extension === "sh" ? "bash" : "node");
      }
    }
  });

  it("reads the interpreter off the path, not off the file", () => {
    expect(scriptInterpreter("a/b/seed.sh")).toBe("bash");
    expect(scriptInterpreter("a/b/seed.mjs")).toBe("node");
  });
});

let root: string;

const registry = {
  invokeTool: vi.fn(async () => ({ ok: true })),
  getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
} as unknown as Registry;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-script-parse-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("a hand-written script step under the recorder", () => {
  it("survives a flow-add-step append and the finish that re-reads the file", async () => {
    const flowFile = path.join(root, ".argent", "flows", "seeded.yaml");
    await flowStartRecordingTool.execute({}, { name: "seeded", project_root: root });
    await fs.writeFile(
      flowFile,
      "steps:\n  - script: { path: scripts/seed.mjs, timeout: 5000 }\n",
      "utf8"
    );

    await createFlowAddStepTool(registry).execute(
      {},
      {
        name: "seeded",
        project_root: root,
        command: "keyboard",
        args: JSON.stringify({ text: "after" }),
      }
    );

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "seeded", project_root: root }
    );
    expect(parseFlow(finished.flowFile).steps).toEqual([
      { kind: "script", path: "scripts/seed.mjs", timeout: 5000 },
      { kind: "tool", name: "keyboard", args: { text: "after" } },
    ]);
    expect(finished.summary[0]).toBe("1. script: scripts/seed.mjs (timeout 5000ms)");
  });
});
