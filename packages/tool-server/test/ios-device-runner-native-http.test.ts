import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "darwin")(
  "checks the Swift server authorization and request parser",
  async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "argent-native-http-"));
    const exec = promisify(execFile);
    try {
      const runner = path.resolve(__dirname, "../../ios-device-runner");
      const binary = path.join(folder, "http-tests");
      await exec("xcrun", [
        "swiftc",
        "-module-cache-path",
        path.join(folder, "cache"),
        path.join(runner, "ArgentRunner/ArgentRunnerUITests/RunnerHTTPServer.swift"),
        path.join(runner, "test/main.swift"),
        "-o",
        binary,
      ]);
      const { stdout } = await exec(binary);
      expect(stdout).toContain("authorization and request framing passed");
    } finally {
      await fs.rm(folder, { recursive: true, force: true });
    }
  },
  60_000
);
