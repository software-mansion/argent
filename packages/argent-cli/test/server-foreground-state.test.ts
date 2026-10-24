import { afterAll, afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// The state dir is resolved from HOME when @argent/tools-client loads, so the
// sandbox must exist before any import below.
const { home, originalHome, originalUserProfile } = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-fg-home-")));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return { home, originalHome, originalUserProfile };
});

const { server } = await import("../src/server.js");
const { stateFileForBundle } = await import("@argent/tools-client");

const stateDir = path.join(home, ".argent");

afterEach(() => {
  vi.restoreAllMocks();
  // Here rather than in the test, which skips its `finally` when it times out.
  if (fs.existsSync(stateDir)) fs.chmodSync(stateDir, 0o755);
});

afterAll(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(home, { recursive: true, force: true });
});

/**
 * Runs foreground `server start` on a bundle with `source`, calls `whileRunning`
 * once the state file exists, and resolves with the exit code plus the state
 * file's contents (null when gone) captured inside process.exit: anything still
 * pending at that point never runs.
 */
async function runForeground(
  name: string,
  source: string,
  whileRunning: (stateFile: string) => void = () => {}
): Promise<{ code: number | undefined; stateFile: string | null }> {
  const bundlePath = path.join(home, `${name}.cjs`);
  fs.writeFileSync(bundlePath, source);
  const stateFile = stateFileForBundle(bundlePath);
  vi.spyOn(console, "log").mockImplementation(() => {});

  const exited = new Promise<{ code: number | undefined; stateFile: string | null }>((resolve) => {
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      resolve({
        code,
        stateFile: fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : null,
      });
    }) as typeof process.exit);
  });

  void server(["start", "--port", "0", "--no-auth"], {
    paths: { bundlePath, simulatorServerDir: home, nativeDevtoolsDir: home },
  });
  await vi.waitFor(() => expect(fs.existsSync(stateFile)).toBe(true), { timeout: 2000 });
  whileRunning(stateFile);
  return exited;
}

it("removes the foreground state file before mirroring the child's exit code", async () => {
  const result = await runForeground("exits", "setTimeout(() => process.exit(3), 500);\n");
  expect(result).toEqual({ code: 3, stateFile: null });
});

it("keeps a state file that another server wrote over ours", async () => {
  const theirs = JSON.stringify({ pid: process.pid, port: 1, bundlePath: "x" });
  const result = await runForeground(
    "replaced",
    "setTimeout(() => process.exit(3), 500);\n",
    (stateFile) => fs.writeFileSync(stateFile, theirs)
  );
  expect(result).toEqual({ code: 3, stateFile: theirs });
});

it("stops the child with SIGTERM on SIGHUP and removes the state file", async () => {
  const result = await runForeground("hup", "setTimeout(() => process.exit(0), 3000);\n", () => {
    process.emit("SIGHUP", "SIGHUP");
  });
  expect(result).toEqual({ code: 143, stateFile: null });
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "mirrors the child's exit code when the state file cannot be removed",
  async () => {
    const result = await runForeground(
      "readonly",
      "setTimeout(() => process.exit(3), 500);\n",
      () => fs.chmodSync(stateDir, 0o555)
    );
    expect(result.code).toBe(3);
    expect(result.stateFile).not.toBeNull();
  }
);
