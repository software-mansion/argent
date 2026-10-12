/**
 * Regression test for the stdio boot-electron gives its child. The Electron app
 * is spawned with ELECTRON_ENABLE_LOGGING=1 and outlives the boot call, but
 * nothing in the tool-server ever reads its stdout. Piping stdout therefore
 * buffers it in the kernel and blocks the app's next write once that buffer
 * fills, wedging CDP; only stderr, which has a forwarding listener, may be a
 * pipe.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { StdioOptions } from "node:child_process";
import { scopeTempHome } from "./helpers/temp-home";

scopeTempHome("argent-boot-electron-stdio-home-");

const spawnMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: (cmd: string, args: string[], opts: unknown) => spawnMock(cmd, args, opts),
  };
});
// Keep the booted port out of the real on-disk state file.
vi.mock("../src/utils/chromium-discovery", () => ({
  trackChromiumPort: vi.fn(),
  untrackChromiumPort: vi.fn(),
}));

import { bootElectronApp } from "../src/tools/devices/boot-electron";

interface FakeChild extends EventEmitter {
  pid: number | undefined;
  stderr: EventEmitter;
  unref: () => void;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.pid = 4242;
  ee.stderr = new EventEmitter();
  ee.unref = () => {};
  ee.kill = vi.fn(() => true);
  return ee;
}

let appDir: string;
beforeAll(() => {
  // resolveLauncher() fs-checks the app path before spawn; the spawn itself is
  // mocked, so only the path's existence matters.
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-boot-electron-stdio-test-"));
  fs.writeFileSync(
    path.join(appDir, "package.json"),
    JSON.stringify({ name: "fake-electron-app", main: "main.js" })
  );
  fs.writeFileSync(path.join(appDir, "main.js"), "// fake\n");
});
afterAll(() => {
  if (appDir) fs.rmSync(appDir, { recursive: true, force: true });
});

vi.spyOn(process, "kill").mockImplementation(() => true);

beforeEach(() => {
  spawnMock.mockReset();
});

/** Minimal CDP stub: only /json/version, which is all waitForCdpReady probes. */
async function startCdpStub(): Promise<{ port: number; close: () => void }> {
  const srv = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/json/version") {
      res.end(JSON.stringify({ "Browser": "Chrome/Test", "Protocol-Version": "1.3" }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address() as { port: number };
  return { port, close: () => srv.close() };
}

/** Boot once against a stub CDP endpoint and return the stdio it spawned with. */
async function bootAndCaptureStdio(): Promise<StdioOptions> {
  spawnMock.mockReturnValue(makeFakeChild());
  const { port, close } = await startCdpStub();
  try {
    await bootElectronApp({ appPath: appDir, port, readyTimeoutMs: 5000 });
  } finally {
    close();
  }
  const opts = spawnMock.mock.calls[0]![2] as { stdio: StdioOptions };
  return opts.stdio;
}

describe("bootElectronApp child stdio", () => {
  it("leaves stdout unpiped and keeps stderr piped for the forwarding listener", async () => {
    expect(await bootAndCaptureStdio()).toEqual(["ignore", "ignore", "pipe"]);
  });

  it("lets a child that floods stdout run to completion under those exact options", async () => {
    const stdio = await bootAndCaptureStdio();
    // The module-level spawn is mocked for the capture above; this case needs a
    // real process.
    const { spawn: realSpawn } =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    // 2 MiB dwarfs every OS pipe buffer (64 KiB on Linux, 16-64 KiB on macOS),
    // so under a piped, unread stdout this child blocks mid-write and never
    // exits - the wedge a logging Electron renderer hits.
    const chatty = realSpawn(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"],
      { stdio }
    );
    let timer: NodeJS.Timeout | undefined;
    try {
      const exited = await Promise.race([
        new Promise<boolean>((resolve) => chatty.once("exit", () => resolve(true))),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 3_000);
        }),
      ]);
      expect(exited).toBe(true);
    } finally {
      clearTimeout(timer);
      chatty.kill("SIGKILL");
    }
  }, 10_000);
});
