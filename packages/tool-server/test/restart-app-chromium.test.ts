import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  FAILURE_CODES,
  getFailureSignal,
  Registry,
  ServiceState,
  zodObjectToJsonSchema,
} from "@argent/registry";
import { scopeTempHome } from "./helpers/temp-home";

scopeTempHome("argent-restart-app-chromium-home-");

const spawnMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: (cmd: string, args: string[], opts: unknown) => spawnMock(cmd, args, opts),
  };
});
vi.mock("../src/utils/chromium-discovery", () => ({
  trackChromiumPort: vi.fn(),
  untrackChromiumPort: vi.fn(),
}));

import {
  bootElectronApp,
  electronLaunchSpec,
  forgetElectronLaunchSpec,
} from "../src/tools/devices/boot-electron";
import { pickFreePort } from "../src/utils/free-port";
import { createRestartAppTool } from "../src/tools/restart-app";
import { createFlowAddStepTool } from "../src/tools/flows/flow-add-step";
import { flowStartRecordingTool } from "../src/tools/flows/flow-start-recording";
import { __resetRecordingsForTesting, parseFlow } from "../src/tools/flows/flow-utils";

interface FakeChild extends EventEmitter {
  pid: number;
  /** A process of the group that outlives the leader until a group SIGKILL, holding the port. */
  survivor?: boolean;
  stderr: EventEmitter;
  unref: () => void;
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

let nextPid = 5000;
let children: FakeChild[] = [];

/** A CDP endpoint on `port`, held while the process it stands for runs. */
function cdpServer(): http.Server {
  return http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/json/version") {
      res.end(JSON.stringify({ "Browser": "Chrome/Test", "Protocol-Version": "1.3" }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
}

const held = new Set<net.Server>();

async function holdPort(server: net.Server): Promise<net.Server> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  held.add(server);
  return server;
}

async function releasePort(server: net.Server | undefined): Promise<void> {
  if (!server || !held.delete(server)) return;
  if (server instanceof http.Server) server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const childServers = new Map<FakeChild, Promise<net.Server>>();

/** The child's process ends: its port is released before the exit is seen, as with a real one. */
async function exitChild(child: FakeChild, code: number | null, signal: NodeJS.Signals | null) {
  child.exitCode = code;
  child.signalCode = signal;
  await releasePort(await childServers.get(child));
  child.emit("exit", code, signal);
}

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.pid = nextPid++;
  ee.stderr = new EventEmitter();
  ee.unref = () => {};
  ee.exitCode = null;
  ee.signalCode = null;
  ee.kill = vi.fn((signal: NodeJS.Signals) => {
    if (ee.survivor) {
      // The leader (a launcher) exits; the process holding the port does not.
      ee.signalCode = signal;
      ee.emit("exit", null, signal);
    } else {
      void exitChild(ee, null, signal);
    }
    return true;
  });
  childServers.set(ee, holdPort(cdpServer()));
  return ee;
}

let appDir: string;
let port: number;

beforeAll(async () => {
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-restart-app-chromium-"));
  fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ main: "main.js" }));
  fs.mkdirSync(path.join(appDir, "node_modules", ".bin"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "node_modules", ".bin", "electron"), "", { mode: 0o755 });
  port = await pickFreePort();
});

afterAll(() => {
  fs.rmSync(appDir, { recursive: true, force: true });
});

beforeEach(() => {
  children = [];
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => {
    const child = makeFakeChild();
    children.push(child);
    return child;
  });
  // Fake pids: group signals must never reach real processes. An exited
  // child's group answers ESRCH, as the OS would.
  vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
    const child = children.find((c) => c.pid === Math.abs(pid));
    if (child?.survivor && pid < 0) {
      if (signal === "SIGKILL") {
        child.survivor = false;
        void childServers.get(child)!.then(releasePort);
      }
      return true;
    }
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    }
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  __resetRecordingsForTesting();
  await Promise.all([...held].map(releasePort));
  childServers.clear();
});

function registryWithRestartApp(): Registry {
  const registry = new Registry();
  registry.registerTool(createRestartAppTool(registry));
  return registry;
}

describe("restart-app on Chromium", () => {
  it("kills the booted Electron app and relaunches it with the same port and args", async () => {
    await bootElectronApp({ appPath: appDir, port, extraArgs: ["--feature-x"] });
    const registry = registryWithRestartApp();

    const result = await registry.invokeTool("restart-app", {
      udid: `chromium-cdp-${port}`,
      bundleId: "tag",
    });

    expect(result).toEqual({ restarted: true, bundleId: "tag" });
    expect(children).toHaveLength(2);
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    expect(children[1]!.kill).not.toHaveBeenCalled();
    const [first, second] = spawnMock.mock.calls;
    expect(second![0]).toBe(first![0]);
    expect(second![1]).toEqual(first![1]);
    expect(second![1]).toContain(`--remote-debugging-port=${port}`);
    expect(second![1]).toContain("--feature-x");
  });

  it("relaunches an app that already exited", async () => {
    await bootElectronApp({ appPath: appDir, port });
    await exitChild(children[0]!, 1, null);
    const registry = registryWithRestartApp();

    await registry.invokeTool("restart-app", { udid: `chromium-cdp-${port}`, bundleId: "tag" });

    expect(children).toHaveLength(2);
    // The dead leader's pid may be recycled, so its group is never signalled.
    expect(process.kill).not.toHaveBeenCalledWith(-children[0]!.pid, expect.anything());
  });

  it.each([
    ["answers CDP", () => cdpServer()],
    // Accepts the connection and never replies, so a CDP probe only times out.
    ["accepts connections but never answers", () => net.createServer(() => {})],
  ])("refuses to relaunch while another process that %s holds the freed port", async (_n, make) => {
    await bootElectronApp({ appPath: appDir, port });
    await exitChild(children[0]!, 1, null);
    const foreign = await holdPort(make());
    const registry = registryWithRestartApp();
    const udid = `chromium-cdp-${port}`;

    const started = Date.now();
    const err = await registry.invokeTool("restart-app", { udid, bundleId: "tag" }).then(
      () => undefined,
      (e: unknown) => e
    );

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.CHROMIUM_RESTART_PORT_IN_USE);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(children).toHaveLength(1);

    await releasePort(foreign);
    await registry.invokeTool("restart-app", { udid, bundleId: "tag" });
    expect(children).toHaveLength(2);
  });

  it("runs overlapping restarts of one port one after the other", async () => {
    await bootElectronApp({ appPath: appDir, port });
    const registry = registryWithRestartApp();
    const udid = `chromium-cdp-${port}`;

    await Promise.all([
      registry.invokeTool("restart-app", { udid, bundleId: "tag" }),
      registry.invokeTool("restart-app", { udid, bundleId: "tag" }),
    ]);

    // Each restart replaced the instance before it: one survivor, not two.
    expect(children).toHaveLength(3);
    expect(children[0]!.kill).toHaveBeenCalledTimes(1);
    expect(children[1]!.kill).toHaveBeenCalledTimes(1);
    expect(children[2]!.kill).not.toHaveBeenCalled();
  });

  it("waits for a process that outlives the launcher before checking the port", async () => {
    await bootElectronApp({ appPath: appDir, port });
    children[0]!.survivor = true;
    const registry = registryWithRestartApp();

    const result = await registry.invokeTool("restart-app", {
      udid: `chromium-cdp-${port}`,
      bundleId: "tag",
    });

    expect(result).toEqual({ restarted: true, bundleId: "tag" });
    expect(process.kill).toHaveBeenCalledWith(-children[0]!.pid, "SIGKILL");
    expect(children).toHaveLength(2);
  });

  it("chains a restart issued while a queued one runs behind that one", async () => {
    await bootElectronApp({ appPath: appDir, port });
    const registry = registryWithRestartApp();
    const udid = `chromium-cdp-${port}`;
    let third: Promise<unknown> | undefined;

    const first = registry.invokeTool("restart-app", { udid, bundleId: "tag" }).then(() => {
      third = registry.invokeTool("restart-app", { udid, bundleId: "tag" });
    });
    const second = registry.invokeTool("restart-app", { udid, bundleId: "tag" });
    await Promise.all([first, second]);
    await third;

    expect(children).toHaveLength(4);
    for (const child of children.slice(0, 3)) expect(child.kill).toHaveBeenCalledTimes(1);
    expect(children[3]!.kill).not.toHaveBeenCalled();
  });

  it("runs a restart queued behind a failed one", async () => {
    await bootElectronApp({ appPath: appDir, port });
    const registry = registryWithRestartApp();
    const udid = `chromium-cdp-${port}`;
    spawnMock.mockImplementationOnce(() => {
      throw new Error("spawn EAGAIN");
    });

    const [first, second] = await Promise.allSettled([
      registry.invokeTool("restart-app", { udid, bundleId: "tag" }),
      registry.invokeTool("restart-app", { udid, bundleId: "tag" }),
    ]);

    expect(first.status).toBe("rejected");
    const reason = (first as PromiseRejectedResult).reason as Error;
    expect(getFailureSignal(reason)?.error_code).toBe(FAILURE_CODES.CHROMIUM_ELECTRON_SPAWN_FAILED);
    expect(reason.message).toContain("stopped the app but could not relaunch it");
    expect(second).toEqual({ status: "fulfilled", value: { restarted: true, bundleId: "tag" } });
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(children).toHaveLength(2);
    expect(children[1]!.kill).not.toHaveBeenCalled();
  });

  it("keeps the running app when a project directory has no electron to launch", async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "argent-restart-app-chromium-bare-"));
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "argent-restart-app-chromium-path-"));
    try {
      fs.writeFileSync(path.join(bare, "package.json"), JSON.stringify({ main: "main.js" }));
      await bootElectronApp({ appPath: bare, port });
      const registry = registryWithRestartApp();
      const udid = `chromium-cdp-${port}`;

      vi.stubEnv("PATH", emptyBin);
      const err = await registry.invokeTool("restart-app", { udid, bundleId: "tag" }).then(
        () => undefined,
        (e: unknown) => e
      );

      expect(getFailureSignal(err)?.error_code).toBe(
        FAILURE_CODES.CHROMIUM_ELECTRON_APP_PATH_INVALID
      );
      expect((err as Error).message).toContain("no 'electron' is on PATH");
      expect((err as Error).message).toContain("did not stop the app, which keeps running");
      expect(children[0]!.kill).not.toHaveBeenCalled();

      // Neither a non-executable file nor a directory named electron is a launcher.
      fs.writeFileSync(path.join(emptyBin, "electron"), "", { mode: 0o644 });
      const otherBin = fs.mkdtempSync(path.join(os.tmpdir(), "argent-restart-app-chromium-dir-"));
      fs.mkdirSync(path.join(otherBin, "electron"), { mode: 0o755 });
      vi.stubEnv("PATH", [emptyBin, otherBin].join(path.delimiter));
      const again = await registry.invokeTool("restart-app", { udid, bundleId: "tag" }).then(
        () => undefined,
        (e: unknown) => e
      );
      fs.rmSync(otherBin, { recursive: true, force: true });
      expect(getFailureSignal(again)?.error_code).toBe(
        FAILURE_CODES.CHROMIUM_ELECTRON_APP_PATH_INVALID
      );
      expect(children[0]!.kill).not.toHaveBeenCalled();

      vi.stubEnv("PATH", emptyBin);
      fs.chmodSync(path.join(emptyBin, "electron"), 0o755);
      await registry.invokeTool("restart-app", { udid, bundleId: "tag" });
      expect(children).toHaveLength(2);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
      fs.rmSync(emptyBin, { recursive: true, force: true });
    }
  });

  it("keeps the running app when its launcher file is no longer executable", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-restart-app-chromium-exe-"));
    const exe = path.join(dir, "MyApp");
    try {
      fs.writeFileSync(exe, "", { mode: 0o755 });
      await bootElectronApp({ appPath: exe, port });
      fs.chmodSync(exe, 0o644);
      const registry = registryWithRestartApp();

      const err = await registry
        .invokeTool("restart-app", { udid: `chromium-cdp-${port}`, bundleId: "tag" })
        .then(
          () => undefined,
          (e: unknown) => e
        );

      expect(getFailureSignal(err)?.error_code).toBe(
        FAILURE_CODES.CHROMIUM_ELECTRON_APP_PATH_INVALID
      );
      expect((err as Error).message).toContain("is not an executable file");
      expect(children[0]!.kill).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is what flow-start-recording tells a chromium recording to start with", () => {
    const schema = zodObjectToJsonSchema(flowStartRecordingTool.zodSchema!) as {
      properties: { executionPrerequisite: { description: string } };
    };
    const description = schema.properties.executionPrerequisite.description;
    expect(description).toContain("`launch: { chromium: <app path> }`");
    expect(description).not.toContain("no chromium support");
  });

  it("disposes the CDP service after the kill", async () => {
    await bootElectronApp({ appPath: appDir, port });
    const registry = registryWithRestartApp();
    const urn = `ChromiumCdp:chromium-cdp-${port}`;
    vi.spyOn(registry, "getSnapshot").mockReturnValue({
      services: new Map([[urn, { state: ServiceState.RUNNING, dependents: [] }]]),
    } as unknown as ReturnType<Registry["getSnapshot"]>);
    const dispose = vi.spyOn(registry, "disposeService").mockResolvedValue();

    await registry.invokeTool("restart-app", { udid: `chromium-cdp-${port}`, bundleId: "tag" });

    expect(dispose).toHaveBeenCalledWith(urn);
    expect(children[0]!.kill.mock.invocationCallOrder[0]).toBeLessThan(
      dispose.mock.invocationCallOrder[0]!
    );
  });

  it("keeps the running app when its path can no longer be launched", async () => {
    const gone = fs.mkdtempSync(path.join(os.tmpdir(), "argent-restart-app-chromium-gone-"));
    fs.writeFileSync(path.join(gone, "package.json"), JSON.stringify({ main: "main.js" }));
    await bootElectronApp({ appPath: gone, port });
    fs.rmSync(gone, { recursive: true, force: true });
    const registry = registryWithRestartApp();

    const err = await registry
      .invokeTool("restart-app", { udid: `chromium-cdp-${port}`, bundleId: "tag" })
      .then(
        () => undefined,
        (e: unknown) => e
      );

    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.CHROMIUM_ELECTRON_APP_PATH_INVALID
    );
    expect(children[0]!.kill).not.toHaveBeenCalled();
    expect(children).toHaveLength(1);
  });

  it("refuses a port whose launch spec was forgotten", async () => {
    await bootElectronApp({ appPath: appDir, port });
    forgetElectronLaunchSpec(port);
    const registry = registryWithRestartApp();

    await expect(
      registry.invokeTool("restart-app", { udid: `chromium-cdp-${port}`, bundleId: "tag" })
    ).rejects.toThrow(/can only relaunch/);
    expect(children).toHaveLength(1);
  });

  it("refuses a Chromium runtime this tool-server did not boot", async () => {
    const registry = registryWithRestartApp();

    const err = await registry
      .invokeTool("restart-app", { udid: "chromium-cdp-1", bundleId: "tag" })
      .then(
        () => undefined,
        (e: unknown) => e
      );

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.CHROMIUM_RESTART_NOT_BOOTED);
    expect((err as Error).message).toContain("--remote-debugging-port");
    expect((err as Error).message).toContain("tool-server restarted since the boot");
    expect((err as Error).message).toContain("an e2e run booted it and stopped it");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each(["chromium-cdp-92222", "chromium-cdp-abc"])(
    "rejects the malformed id %s as such",
    async (udid) => {
      const registry = registryWithRestartApp();

      const err = await registry.invokeTool("restart-app", { udid, bundleId: "tag" }).then(
        () => undefined,
        (e: unknown) => e
      );

      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.CHROMIUM_DEVICE_ID_INVALID);
      expect((err as Error).message).not.toContain("--remote-debugging-port");
    }
  );

  it.each([
    ["path and args", ["--feature-x"], {}, false, () => ({ path: appDir, args: ["--feature-x"] })],
    ["bare path", [], {}, false, () => appDir],
    ["absolute path when booted by a relative one", [], {}, true, () => appDir],
    [
      "path, not the ignored launchArgs",
      [],
      { launchArgs: ["-x"], activity: ".Main" },
      false,
      () => appDir,
    ],
  ])(
    "is recorded as a chromium launch of the app's %s",
    async (_name, extraArgs, extraRestartArgs, relative, expected) => {
      await bootElectronApp({
        appPath: relative ? path.relative(process.cwd(), appDir) : appDir,
        port,
        extraArgs,
      });
      expect(electronLaunchSpec(port)?.appPath).toBe(appDir);
      const registry = registryWithRestartApp();
      const projectRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "argent-restart-app-chromium-flow-")
      );
      try {
        await flowStartRecordingTool.execute(
          {},
          { name: "chromium-launch", project_root: projectRoot }
        );
        await createFlowAddStepTool(registry).execute(
          {},
          {
            name: "chromium-launch",
            project_root: projectRoot,
            command: "restart-app",
            args: JSON.stringify({
              udid: `chromium-cdp-${port}`,
              bundleId: "tag",
              ...extraRestartArgs,
            }),
          }
        );

        const yaml = fs.readFileSync(
          path.join(projectRoot, ".argent", "e2e", "chromium-launch.yaml"),
          "utf8"
        );
        expect(parseFlow(yaml).steps).toEqual([{ kind: "launch", app: { chromium: expected() } }]);
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    }
  );

  it("records only the first restart of a recording as the launch", async () => {
    await bootElectronApp({ appPath: appDir, port });
    const registry = registryWithRestartApp();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-restart-app-chromium-flow-"));
    try {
      await flowStartRecordingTool.execute({}, { name: "two-restarts", project_root: projectRoot });
      for (let i = 0; i < 2; i++) {
        await createFlowAddStepTool(registry).execute(
          {},
          {
            name: "two-restarts",
            project_root: projectRoot,
            command: "restart-app",
            args: JSON.stringify({ udid: `chromium-cdp-${port}`, bundleId: "tag" }),
          }
        );
      }

      const yaml = fs.readFileSync(
        path.join(projectRoot, ".argent", "e2e", "two-restarts.yaml"),
        "utf8"
      );
      expect(parseFlow(yaml).steps).toEqual([
        { kind: "launch", app: { chromium: appDir } },
        { kind: "tool", name: "restart-app", args: { bundleId: "tag" } },
      ]);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
