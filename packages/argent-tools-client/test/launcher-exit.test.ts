import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ChildProcess } from "node:child_process";

// Regression guard for "argent run <tool> never exits when it has to spawn the
// tool-server". `child.unref()` detaches the process handle, but the piped
// `child.stdout` is a SEPARATE ref'd handle — left ref'd it keeps a short-lived
// caller's event loop alive forever after it has printed its result. The reuse
// path never opens that pipe, so the hang was spawn-only. spawnToolsServer must
// unref the stdout socket once it has read the ready banner.
//
// We wrap the real `spawn` (via vi.mock passthrough) so the fake tool-server
// still runs for real, capture the returned child, and assert its stdout pipe
// was unref'd.
let lastChild: ChildProcess | null = null;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      // Pipe stdio makes stdout a net.Socket (has unref); the type widens it to
      // Readable, so narrow before spying.
      const stdout = child.stdout as unknown as { unref: () => void } | null;
      if (stdout) vi.spyOn(stdout, "unref");
      lastChild = child;
      return child;
    },
  };
});

let launcher: typeof import("../src/launcher.js");
let TEST_HOME: string;

const FAKE_BUNDLE = resolve(__dirname, "fixtures/fake-tool-server.cjs");

const fakePaths = (): import("../src/launcher.js").ToolsServerPaths => ({
  bundlePath: FAKE_BUNDLE,
  simulatorServerDir: "/unused/sim",
  nativeDevtoolsDir: "/unused/dylibs",
});

beforeAll(async () => {
  TEST_HOME = mkdtempSync(join(tmpdir(), "argent-exit-test-"));
  process.env.HOME = TEST_HOME;
  vi.resetModules();
  launcher = await import("../src/launcher.js");
  expect(existsSync(FAKE_BUNDLE)).toBe(true);
});

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const spawnedPids: number[] = [];
afterEach(async () => {
  lastChild = null;
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }
  await launcher.clearToolsServerState();
});

describe("spawnToolsServer — process-exit hygiene", () => {
  it("unrefs the child's stdout pipe so a short-lived caller can exit", async () => {
    const port = await launcher.findFreePort();
    const { pid } = await launcher.spawnToolsServer(fakePaths(), port);
    spawnedPids.push(pid);

    expect(lastChild).not.toBeNull();
    const stdout = lastChild!.stdout as unknown as { unref: () => void } | null;
    expect(stdout).toBeTruthy();
    // The socket that used to strand `argent run` on the event loop.
    expect(stdout!.unref).toHaveBeenCalled();
  });
});
