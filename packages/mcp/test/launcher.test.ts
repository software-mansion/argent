import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLED_RUNTIME_PATHS, buildToolsServerEnv } from "../src/launcher.js";

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
  });
});
