import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { BUNDLED_RUNTIME_PATHS, buildToolsServerEnv } from "../src/launcher.js";
import { readToml } from "../src/cli/utils.js";

describe("buildToolsServerEnv", () => {
  it("passes packaged runtime asset paths to the embedded tool-server", () => {
    const env = buildToolsServerEnv(43123, { TEST_VAR: "1" });

    expect(env.PORT).toBe("43123");
    expect(env.TEST_VAR).toBe("1");
    expect(env.ARGENT_SIMULATOR_SERVER_DIR).toBe(BUNDLED_RUNTIME_PATHS.simulatorServerDir);
    expect(env.ARGENT_NATIVE_DEVTOOLS_DIR).toBe(BUNDLED_RUNTIME_PATHS.nativeDevtoolsDir);
    expect(path.basename(BUNDLED_RUNTIME_PATHS.simulatorServerDir)).toBe("bin");
    expect(path.basename(BUNDLED_RUNTIME_PATHS.nativeDevtoolsDir)).toBe("dylibs");
  });
});

describe("package manifest", () => {
  it("publishes the bundled native dylibs", () => {
    const pkgPath = path.resolve(import.meta.dirname, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      files?: string[];
      scripts?: Record<string, string>;
    };

    expect(pkg.files).toContain("dist/");
    expect(pkg.files).toContain("dylibs/");
    expect(pkg.scripts?.prepack).toBe("npm run build");
    expect(pkg.scripts?.predev).toBe("npm run build:tools-bundle");
    expect(pkg.scripts?.pretest).toBe("npm run build:tools-bundle");
  });

  it("compiled Codex config code reads the packaged tool manifest", async () => {
    const pkgRoot = path.resolve(import.meta.dirname, "..");
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

    execFileSync(npmCmd, ["run", "build"], {
      cwd: pkgRoot,
      stdio: "pipe",
      env: process.env,
    });

    const manifestPath = path.join(pkgRoot, "dist", "argent-tool-names.json");
    const expectedToolIds = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as string[];
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-mcp-built-"));

    try {
      const builtModuleUrl =
        pathToFileURL(path.join(pkgRoot, "dist", "cli", "mcp-configs.js")).href +
        `?t=${Date.now()}`;
      const builtModule = (await import(builtModuleUrl)) as {
        addCodexApprovalAllowlist: (root: string, scope: "local" | "global") => Promise<void>;
      };

      await builtModule.addCodexApprovalAllowlist(tempRoot, "local");

      const config = readToml(path.join(tempRoot, ".codex", "config.toml"));
      const tools = (((config.mcp_servers as Record<string, unknown>).argent as Record<
        string,
        unknown
      >).tools ?? {}) as Record<string, unknown>;

      expect(Object.keys(tools).sort()).toEqual(expectedToolIds.sort());
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
