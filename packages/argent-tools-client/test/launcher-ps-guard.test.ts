import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// The reader pins `ps` to /bin or /usr/bin when either holds one. Hiding both
// drops it to a bare `"ps"` resolved off PATH, which is what lets these tests
// stand a stub in for `ps` and produce failures a real one will not produce on
// demand — a rejected flag, and an argv too large for the host to ever exec.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const existsSync = (p: Parameters<typeof actual.existsSync>[0]): boolean =>
    p === "/bin/ps" || p === "/usr/bin/ps" ? false : actual.existsSync(p);
  return { ...actual, existsSync };
});

// 2 MiB of argv: past Node's 1 MiB execFileSync default, under the reader's
// ceiling. Built by doubling in the shell because PATH is trimmed to the stub
// and node, leaving no external command to generate it with.
const PAD_BYTES = 16 * 2 ** 17;
const HUGE_PREFIX = "node /stub/bundle start ";

const PS_STUB = `#!/bin/sh
case "$ARGENT_PS_STUB" in
  reject) echo "ps: invalid option -- 'w'" >&2; exit 1 ;;
  huge)
    s=xxxxxxxxxxxxxxxx
    i=0
    while [ "$i" -lt 17 ]; do s="$s$s"; i=$((i + 1)); done
    printf '${HUGE_PREFIX}%s\\n' "$s"
    ;;
esac
`;

const FIXTURE_BUNDLE = resolve(__dirname, "fixtures/fake-tool-server.cjs");

let launcher: typeof import("../src/launcher.js");
let stubDir: string;
let bundlePath: string;
let ambientPath: string | undefined;

beforeAll(async () => {
  stubDir = mkdtempSync(join(tmpdir(), "argent-ps-stub-"));
  writeFileSync(join(stubDir, "ps"), PS_STUB, "utf8");
  chmodSync(join(stubDir, "ps"), 0o755);
  bundlePath = join(stubDir, "tool-server.cjs");
  copyFileSync(FIXTURE_BUNDLE, bundlePath);
  process.env.HOME = stubDir;
  ambientPath = process.env.PATH;
  // The stub dir first so `ps` resolves to it; node's own dir because
  // spawnToolsServer launches `node` off PATH. Neither holds a real `ps`.
  process.env.PATH = `${stubDir}:${dirname(process.execPath)}`;
  vi.resetModules();
  launcher = await import("../src/launcher.js");
});

const spawnedPids: number[] = [];
afterEach(() => {
  delete process.env.ARGENT_PS_STUB;
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }
});

afterAll(() => {
  if (ambientPath === undefined) delete process.env.PATH;
  else process.env.PATH = ambientPath;
  rmSync(stubDir, { recursive: true, force: true });
});

describe("readProcessCommandLine", () => {
  it("carries ps's own complaint into the error it throws", () => {
    // A `ps` that rejects the width flags is exactly what the guard's
    // diagnostic exists to name; without the child's stderr it can only say
    // `Command failed: ps -ww …`.
    process.env.ARGENT_PS_STUB = "reject";
    let thrown: unknown;
    try {
      launcher.readProcessCommandLine(process.pid);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toContain("ps: invalid option -- 'w'");
  });

  it("reads a command line larger than Node's 1 MiB exec-output default", () => {
    // A recycled pid can sit on a process with a multi-megabyte argv. Under the
    // default the read comes back ENOBUFS, which the guard can only treat as
    // "unidentifiable" — and a live server never gets retired.
    expect(PAD_BYTES).toBeGreaterThan(1024 * 1024);
    process.env.ARGENT_PS_STUB = "huge";
    const cmd = launcher.readProcessCommandLine(process.pid);
    expect(cmd.startsWith(HUGE_PREFIX)).toBe(true);
    expect(cmd.length).toBe(HUGE_PREFIX.length + PAD_BYTES);
  });
});

describe("ensureToolsServer — identity guard on a host with no `ps`", () => {
  it(
    "retires a wedged auto-spawned server on Windows, where nothing can read a command line",
    { timeout: 30_000 },
    async () => {
      // Windows has no `ps`, so the guard can never confirm the recorded pid is
      // ours. Vetoing the kill there would leave every wedged auto-spawned
      // server running on a leaked port while the MCP health monitor retries
      // the same replacement every 30s. The stub `ps` answers with nothing —
      // the same "unidentifiable" verdict a missing binary produces — so only
      // the platform decides the outcome.
      const paths: import("../src/launcher.js").ToolsServerPaths = {
        bundlePath,
        simulatorServerDir: "/unused/sim",
        nativeDevtoolsDir: "/unused/dylibs",
      };
      process.env.FAKE_MODE = "unhealthy";
      let wedged: { port: number; pid: number };
      try {
        wedged = await launcher.spawnToolsServer(paths, await launcher.findFreePort(), {
          token: "guard-token",
        });
      } finally {
        delete process.env.FAKE_MODE;
      }
      spawnedPids.push(wedged.pid);
      await launcher.writeToolsServerState({
        port: wedged.port,
        pid: wedged.pid,
        startedAt: new Date().toISOString(),
        bundlePath,
        host: "127.0.0.1",
        token: "guard-token",
        managed: "autospawn",
      });
      expect(launcher.isToolsServerProcessAlive(wedged.pid)).toBe(true);

      const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      try {
        await launcher.ensureToolsServer(paths);
      } finally {
        Object.defineProperty(process, "platform", realPlatform);
      }

      const replacement = await launcher.readToolsServerState(bundlePath);
      spawnedPids.push(replacement!.pid);
      expect(launcher.isToolsServerProcessAlive(wedged.pid)).toBe(false);
      expect(replacement!.pid).not.toBe(wedged.pid);
    }
  );
});
