import { describe, expect, it } from "vitest";
import { AUTH_TOKEN_ENV, buildToolsServerEnv } from "../src/launcher.js";

describe("buildToolsServerEnv", () => {
  const paths = {
    bundlePath: "/pkg/dist/tool-server.cjs",
    simulatorServerDir: "/pkg/bin",
    nativeDevtoolsDir: "/pkg/dylibs",
  };

  it("passes packaged runtime asset paths and the auth token into the spawned tool-server's env", () => {
    const env = buildToolsServerEnv(paths, 43123, "fake-token", { TEST_VAR: "1" });

    expect(env.PORT).toBe("43123");
    expect(env.TEST_VAR).toBe("1");
    expect(env[AUTH_TOKEN_ENV]).toBe("fake-token");
    expect(env.ARGENT_SIMULATOR_SERVER_DIR).toBe(paths.simulatorServerDir);
    expect(env.ARGENT_NATIVE_DEVTOOLS_DIR).toBe(paths.nativeDevtoolsDir);
  });
});
