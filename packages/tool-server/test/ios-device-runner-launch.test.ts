import { once } from "node:events";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRunner, waitForRunnerListeningPort } from "../src/utils/ios-device/runner-launch";

let tmpRoot: string;
beforeAll(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "argent-runner-launch-"));
});
afterAll(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

/**
 * Run launchRunner with PATH replaced by `pathDir` (so "xcodebuild" resolves
 * to a stub, or to nothing) and HOME moved under tmpRoot (so the launch log
 * lands in the fixture tree, not the real ~/.argent).
 */
async function launchWithPath(pathDir: string): Promise<Awaited<ReturnType<typeof launchRunner>>> {
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
  process.env.PATH = pathDir;
  process.env.HOME = tmpRoot;
  try {
    return await launchRunner({
      udid: "00008120-000000000000001E",
      xctestrunPath: path.join(tmpRoot, "fake.xctestrun"),
      derivedDataPath: path.join(tmpRoot, "derived"),
    });
  } finally {
    process.env.PATH = saved.PATH;
    process.env.HOME = saved.HOME;
  }
}

describe("launchRunner", () => {
  it("rejects with the wrapped spawn failure instead of crashing the process", async () => {
    const emptyBin = path.join(tmpRoot, "empty-bin");
    await fsp.mkdir(emptyBin, { recursive: true });

    // Before the spawn/error race, the ENOENT arrived as an unhandled async
    // "error" event; this test completing green is the no-crash proof.
    const error = await launchWithPath(emptyBin).catch((caught: unknown) => caught);

    expect((error as Error).name).toBe("FailureError");
    expect((error as Error).message).toBe(
      "xcodebuild could not be started. Check that Xcode is installed and on PATH."
    );
    expect(((error as Error).cause as NodeJS.ErrnoException).code).toBe("ENOENT");
  });

  it("resolves with the launched child and per-device log and bundle paths", async () => {
    const stubBin = path.join(tmpRoot, "stub-bin");
    await fsp.mkdir(stubBin, { recursive: true });
    // The stub echoes the port variable and its argv so the log pins that no
    // port is forced on the runner through TEST_RUNNER_<VAR> (the device picks
    // it) and that the crash bundle path is pinned on the command line.
    await fsp.writeFile(
      path.join(stubBin, "xcodebuild"),
      '#!/bin/sh\necho "PORT=${TEST_RUNNER_ARGENT_RUNNER_PORT-unset} ARGS=$@"\nexit 0\n',
      { mode: 0o755 }
    );

    const launched = await launchWithPath(stubBin);

    expect(launched.child.pid).toBeGreaterThan(0);
    expect(path.dirname(launched.logPath)).toBe(
      path.join(tmpRoot, ".argent", "ios-device-runner", "logs")
    );
    // Fixed per-device names: the whole retention policy is overwrite-on-launch.
    expect(path.basename(launched.logPath)).toBe("runner-00008120.log");
    expect(launched.resultBundlePath).toBe(
      path.join(tmpRoot, ".argent", "ios-device-runner", "results", "argent-00008120.xcresult")
    );
    await once(launched.child, "exit");
    const log = await fsp.readFile(launched.logPath, "utf8");
    expect(log).toContain("PORT=unset");
    expect(log).toContain("-resultBundlePath");
    // The swallow listener that keeps a late "error" from becoming uncaught.
    expect(launched.child.listenerCount("error")).toBe(1);

    // A second launch truncates the log rather than appending to it.
    const second = await launchWithPath(stubBin);
    await once(second.child, "exit");
    const secondLog = await fsp.readFile(second.logPath, "utf8");
    expect(secondLog.match(/PORT=/g)).toHaveLength(1);
  });
});

/** The head of a launch log as xcodebuild relays the runner's NSLog lines. */
const RUNNER_LOG_HEAD = [
  "2026-09-02 10:26:59.148045+0200 ArgentRunnerUITests-Runner[3799:1856769] ARGENT_RUNNER_STARTING requestedPort=0",
  "2026-09-02 10:26:59.148464+0200 ArgentRunnerUITests-Runner[3799:1856769] ARGENT_RUNNER_SERVING",
  "",
].join("\n");
const LISTENING_LINE =
  "2026-09-02 10:26:59.148786+0200 ArgentRunnerUITests-Runner[3799:1856792] ARGENT_RUNNER_LISTENING port=49923\n";

describe("waitForRunnerListeningPort", () => {
  it("resolves with the bound port once the runner's LISTENING line lands", async () => {
    const logPath = path.join(tmpRoot, "listening-late.log");
    await fsp.writeFile(logPath, RUNNER_LOG_HEAD);

    const pending = waitForRunnerListeningPort(logPath, { timeoutMs: 5_000 });
    // requestedPort is what the environment asked for, not what was bound, so
    // the poller keeps waiting until the LISTENING line is appended.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fsp.appendFile(logPath, LISTENING_LINE);

    await expect(pending).resolves.toBe(49923);
  });

  it("reads the port from the first poll when the log already has the line", async () => {
    const logPath = path.join(tmpRoot, "listening-early.log");
    await fsp.writeFile(logPath, RUNNER_LOG_HEAD + LISTENING_LINE);

    // A zero budget: the first read has to be enough.
    await expect(waitForRunnerListeningPort(logPath, { timeoutMs: 0 })).resolves.toBe(49923);
  });

  it("rejects once the budget runs out without a usable port, port=0 included", async () => {
    const logPath = path.join(tmpRoot, "listening-zero.log");
    await fsp.writeFile(logPath, RUNNER_LOG_HEAD + LISTENING_LINE.replace("port=49923", "port=0"));

    await expect(waitForRunnerListeningPort(logPath, { timeoutMs: 0 })).rejects.toThrow(
      "the runner did not log a listening port within 0ms"
    );
    // A log xcodebuild has not created yet reads as empty, not as a failure.
    await expect(
      waitForRunnerListeningPort(path.join(tmpRoot, "missing.log"), { timeoutMs: 0 })
    ).rejects.toThrow("did not log a listening port");
  });
});
