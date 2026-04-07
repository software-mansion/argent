import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gatherWorkspaceDataTool } from "../src/tools/workspace/gather-workspace-data";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "gather-tool-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("gather-workspace-data tool", () => {
  it("has correct id", () => {
    expect(gatherWorkspaceDataTool.id).toBe("gather-workspace-data");
  });

  it("has a description", () => {
    expect(gatherWorkspaceDataTool.description).toBeTruthy();
  });

  it("declares no service dependencies", () => {
    expect(gatherWorkspaceDataTool.services({ workspacePath: "/tmp" })).toEqual({});
  });

  it("zodSchema requires workspacePath string", () => {
    const result = gatherWorkspaceDataTool.zodSchema!.safeParse({});
    expect(result.success).toBe(false);

    const valid = gatherWorkspaceDataTool.zodSchema!.safeParse({
      workspacePath: "/some/path",
    });
    expect(valid.success).toBe(true);
  });

  it("returns a valid snapshot for a mock RN project", async () => {
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "ToolTestApp",
        dependencies: { "react-native": "0.74.0" },
        scripts: { start: "react-native start" },
      })
    );
    await writeFile(
      join(tempDir, "metro.config.js"),
      `module.exports = { server: { port: 8082 } };`
    );
    await mkdir(join(tempDir, "ios"), { recursive: true });
    await mkdir(join(tempDir, "android"), { recursive: true });

    const result = await gatherWorkspaceDataTool.execute({}, { workspacePath: tempDir });

    expect(result.workspace_path).toBe(tempDir);
    expect(result.package_json).toMatchObject({ name: "ToolTestApp" });
    expect(result.metro_port).toBe(8082);
    expect(result.has_ios_dir).toBe(true);
    expect(result.has_android_dir).toBe(true);
  });

  it("handles nonexistent path gracefully for file reads", async () => {
    const fakePath = join(tempDir, "nonexistent-subdir");
    const result = await gatherWorkspaceDataTool.execute({}, { workspacePath: fakePath });

    expect(result.package_json).toBeNull();
    expect(result.has_ios_dir).toBe(false);
    expect(result.has_android_dir).toBe(false);
    expect(result.env_files).toEqual([]);
  });
});
