/**
 * `describe` on iOS shells out to xcrun via the ax-service blueprint factory
 * (`ensureAutomationEnabled` → `xcrun simctl spawn ...`). When xcrun is
 * missing — Linux runner, broken Xcode toolchain, etc. — the spawn rejects
 * with ENOENT and the error bubbles up to the HTTP layer as a 500 with a raw
 * "spawn xcrun ENOENT" message.
 *
 * Every other cross-platform iOS tool (`launch-app`, `restart-app`,
 * `open-url`, `reinstall-app`) declares `requires: ["xcrun"]` on its
 * `dispatchByPlatform` iOS branch, so missing-xcrun is short-circuited into
 * a `424 Failed Dependency` with the `xcode-select --install` install hint.
 *
 * This test pins that contract for `describe`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { Registry } from "@argent/registry";

const execFileMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

vi.mock("@argent/native-devtools-ios", () => ({
  bootstrapDylibPath: () => "/fake/bootstrap.dylib",
  simulatorServerBinaryPath: () => "/fake/sim-server",
  simulatorServerBinaryDir: () => "/fake",
  axServiceBinaryPath: () => "/fake/ax-service",
}));

import { createHttpApp } from "../src/http";
import { __resetDepCacheForTests } from "../src/utils/check-deps";
import { createDescribeTool } from "../src/tools/describe";
import { axServiceBlueprint } from "../src/blueprints/ax-service";
import { nativeDevtoolsBlueprint } from "../src/blueprints/native-devtools";

describe("describe → 424 when xcrun is missing", () => {
  beforeEach(() => {
    __resetDepCacheForTests();
    execFileMock.mockReset();
  });

  it("returns 424 (Failed Dependency) with the xcode-select install hint", async () => {
    // Both probes — `command -v xcrun` and a bare `xcrun ...` invocation —
    // fail. Any deeper xcrun call would also ENOENT, but the dep gate should
    // fire first.
    execFileMock.mockImplementation(
      (
        cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout?: string, stderr?: string) => void
      ) => {
        if (cmd === "/bin/sh") {
          cb(new Error("not found"));
          return;
        }
        if (cmd === "xcrun") {
          const err = new Error("spawn xcrun ENOENT") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          cb(err);
          return;
        }
        cb(null, "", "");
      }
    );

    const registry = new Registry();
    registry.registerBlueprint(axServiceBlueprint);
    registry.registerBlueprint(nativeDevtoolsBlueprint);
    registry.registerTool(createDescribeTool(registry));

    const { app } = createHttpApp(registry);
    const res = await request(app)
      .post("/tools/describe")
      .send({ udid: "11111111-1111-1111-1111-111111111111" });

    expect(res.status).toBe(424);
    expect(res.body.error).toMatch(/xcode-select --install/);
    expect(res.body.missing).toEqual(["xcrun"]);
  });
});
