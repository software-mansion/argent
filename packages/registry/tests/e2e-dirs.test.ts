import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  E2E_DIR,
  E2E_DIRS,
  LEGACY_E2E_DIRS,
  e2eDirFor,
  e2eDirProject,
  e2eDirsFor,
  e2eFileCandidates,
  e2eRunFallbackDirs,
  e2eShadowWarning,
  nestedFlowTarget,
  resolveE2eFile,
} from "../src/index";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "registry-e2e-dirs-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(rel: string): Promise<string> {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "steps: []\n");
  return file;
}

describe("the e2e test directories", () => {
  it("write to .argent/e2e and read .argent/flows after it", () => {
    expect(E2E_DIR).toBe(path.join(".argent", "e2e"));
    expect(LEGACY_E2E_DIRS).toEqual([path.join(".argent", "flows")]);
    expect(E2E_DIRS).toEqual([E2E_DIR, ...LEGACY_E2E_DIRS]);
    expect(e2eDirFor("/p")).toBe(path.join("/p", ".argent", "e2e"));
    expect(e2eDirsFor("/p")).toEqual([
      path.join("/p", ".argent", "e2e"),
      path.join("/p", ".argent", "flows"),
    ]);
    expect(e2eFileCandidates("/p", "login")).toEqual([
      path.join("/p", ".argent", "e2e", "login.yaml"),
      path.join("/p", ".argent", "flows", "login.yaml"),
    ]);
  });
});

describe("resolveE2eFile", () => {
  it("names the .argent/e2e path when no directory has the test", async () => {
    await expect(resolveE2eFile(root, "login")).resolves.toEqual({
      path: path.join(root, ".argent", "e2e", "login.yaml"),
      exists: false,
      legacy: false,
    });
  });

  it("finds a test saved only in .argent/flows", async () => {
    const file = await write(".argent/flows/login.yaml");
    await expect(resolveE2eFile(root, "login")).resolves.toEqual({
      path: file,
      exists: true,
      legacy: true,
    });
  });

  it("takes .argent/e2e first and names the legacy test it hides", async () => {
    const used = await write(".argent/e2e/login.yaml");
    const shadowed = await write(".argent/flows/login.yaml");
    await expect(resolveE2eFile(root, "login")).resolves.toEqual({
      path: used,
      exists: true,
      legacy: false,
      shadowed,
    });
    expect(e2eShadowWarning(used, shadowed)).toBe(
      `${shadowed} is not used: ${used} has the same name and is read first.`
    );
  });
});

describe("e2eDirProject", () => {
  it.each([
    ["/p/.argent/e2e", "/p"],
    ["/p/.argent/flows", "/p"],
    ["/p/.argent/flows/", "/p"],
    ["/.argent/e2e", "/"],
    ["/p/.argent/other", null],
    ["/p/argent/e2e", null],
    ["/p/.argent/e2e/sub", null],
  ])("%s -> %s", (dir, project) => {
    expect(e2eDirProject(dir)).toBe(project);
  });
});

describe("e2eRunFallbackDirs", () => {
  it("looks in the project's other e2e test directories for a bare file name", () => {
    expect(e2eRunFallbackDirs("/p/.argent/e2e", "login.yaml")).toEqual([
      path.join("/p", ".argent", "flows"),
    ]);
    expect(e2eRunFallbackDirs("/p/.argent/flows", "login.yaml")).toEqual([
      path.join("/p", ".argent", "e2e"),
    ]);
  });

  it("does not look elsewhere for a target with a directory, or from another directory", () => {
    expect(e2eRunFallbackDirs("/p/.argent/e2e", "sub/login.yaml")).toEqual([]);
    expect(e2eRunFallbackDirs("/p/.argent/e2e", "../flows/login.yaml")).toEqual([]);
    expect(e2eRunFallbackDirs("/p/tests", "login.yaml")).toEqual([]);
  });
});

describe("nestedFlowTarget", () => {
  it("lists both directories for a name, .argent/e2e first", () => {
    expect(nestedFlowTarget({ name: "login", project_root: "/p" })).toEqual({
      kind: "name",
      projectRoot: "/p",
      name: "login",
      path: path.join("/p", ".argent", "e2e", "login.yaml"),
      paths: [
        path.join("/p", ".argent", "e2e", "login.yaml"),
        path.join("/p", ".argent", "flows", "login.yaml"),
      ],
    });
  });
});
