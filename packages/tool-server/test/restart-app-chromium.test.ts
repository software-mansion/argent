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
import { createBootDeviceTool } from "../src/tools/devices/boot-device";
import { createFlowAddStepTool } from "../src/tools/flows/flow-add-step";
import { flowStartRecordingTool } from "../src/tools/flows/flow-start-recording";
import { flowInsertEchoTool } from "../src/tools/flows/flow-insert-echo";
import { flowAddScriptTool } from "../src/tools/flows/flow-add-script";
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
/** Ids the kernel handed to an unrelated process group: their probe answers. */
let recycledGroups: Set<number>;

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

async function holdPort(
  server: net.Server,
  host = "127.0.0.1",
  ipv6Only = false
): Promise<net.Server> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port, host, ipv6Only }, () => resolve());
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

function makeFakeChild(holdsPort = true): FakeChild {
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
  if (holdsPort) childServers.set(ee, holdPort(cdpServer()));
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
  recycledGroups = new Set();
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => {
    const child = makeFakeChild();
    children.push(child);
    return child;
  });
  // Fake pids: group signals must never reach real processes. An exited
  // child's group answers ESRCH, as the OS would.
  vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
    if (pid < 0 && recycledGroups.has(-pid)) return true;
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

/** What restart-app returns for the app booted from `appDir` with `args`. */
function restarted(args: string[] = []) {
  return { restarted: true, bundleId: "tag", appPath: appDir, args };
}

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

    expect(result).toEqual(restarted(["--feature-x"]));
    expect(children).toHaveLength(2);
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    expect(children[1]!.kill).not.toHaveBeenCalled();
    const [first, second] = spawnMock.mock.calls;
    expect(second![0]).toBe(first![0]);
    expect(second![1]).toEqual(first![1]);
    expect(second![1]).toContain(`--remote-debugging-port=${port}`);
    expect(second![1]).toContain("--feature-x");
  });

  it("relaunches an app that already exited, sparing a group that took its id", async () => {
    await bootElectronApp({ appPath: appDir, port });
    await exitChild(children[0]!, 1, null);
    recycledGroups.add(children[0]!.pid);
    const registry = registryWithRestartApp();

    await registry.invokeTool("restart-app", { udid: `chromium-cdp-${port}`, bundleId: "tag" });

    expect(children).toHaveLength(2);
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      expect(process.kill).not.toHaveBeenCalledWith(-children[0]!.pid, signal);
    }
  });

  it("stops the rest of the app's group when only its launcher exited, then relaunches", async () => {
    await bootElectronApp({ appPath: appDir, port });
    const leader = children[0]!;
    // The launcher exits on its own; the browser process lives on and holds the port.
    leader.survivor = true;
    leader.exitCode = 0;
    leader.emit("exit", 0, null);
    const registry = registryWithRestartApp();

    const result = await registry.invokeTool("restart-app", {
      udid: `chromium-cdp-${port}`,
      bundleId: "tag",
    });

    expect(result).toEqual(restarted());
    expect(process.kill).toHaveBeenCalledWith(-leader.pid, "SIGTERM");
    expect(children).toHaveLength(2);
    expect(electronLaunchSpec(port)).toMatchObject({ pgid: children[1]!.pid });
  });

  it.each([
    ["answers CDP", () => cdpServer(), "127.0.0.1"],
    // Accepts the connection and never replies, so a CDP probe only times out.
    ["accepts connections but never answers", () => net.createServer(() => {}), "127.0.0.1"],
    // Linux refuses the loopback bind beside it; for macOS see the test below.
    ...(process.platform === "darwin"
      ? []
      : [["listens on the wildcard address", () => cdpServer(), "0.0.0.0"] as const]),
  ] as const)(
    "refuses to relaunch while another process that %s holds the freed port",
    async (_n, make, host) => {
      await bootElectronApp({ appPath: appDir, port });
      await exitChild(children[0]!, 1, null);
      const foreign = await holdPort(make(), host);
      const registry = registryWithRestartApp();
      const udid = `chromium-cdp-${port}`;

      const started = Date.now();
      const err = await registry.invokeTool("restart-app", { udid, bundleId: "tag" }).then(
        () => undefined,
        (e: unknown) => e
      );

      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.CHROMIUM_RESTART_PORT_IN_USE);
      expect((err as Error).message).toContain("restart-app did not relaunch the app: port");
      expect(Date.now() - started).toBeLessThan(2000);
      expect(children).toHaveLength(1);

      await releasePort(foreign);
      await registry.invokeTool("restart-app", { udid, bundleId: "tag" });
      expect(children).toHaveLength(2);
    }
  );

  it.each([
    ["0.0.0.0", false],
    ["::", true],
  ])(
    "refuses a %s holder of the freed port on Windows, where Chromium binds exclusively",
    async (host, ipv6Only) => {
      await bootElectronApp({ appPath: appDir, port });
      await exitChild(children[0]!, 1, null);
      const foreign = await holdPort(cdpServer(), host, ipv6Only);
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { ...platform, value: "win32" });
      try {
        const err = await registryWithRestartApp()
          .invokeTool("restart-app", { udid: `chromium-cdp-${port}`, bundleId: "tag" })
          .then(
            () => undefined,
            (e: unknown) => e
          );

        expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.CHROMIUM_RESTART_PORT_IN_USE);
        expect(children).toHaveLength(1);
      } finally {
        Object.defineProperty(process, "platform", platform);
        await releasePort(foreign);
      }
    }
  );

  // Chromium's 127.0.0.1 listener binds beside it and takes the loopback connections.
  it.runIf(process.platform === "darwin")(
    "relaunches while another process holds the port on the wildcard address (macOS)",
    async () => {
      await bootElectronApp({ appPath: appDir, port });
      await exitChild(children[0]!, 1, null);
      const foreign = await holdPort(cdpServer(), "0.0.0.0");

      const result = await registryWithRestartApp().invokeTool("restart-app", {
        udid: `chromium-cdp-${port}`,
        bundleId: "tag",
      });

      expect(result).toEqual(restarted());
      expect(children).toHaveLength(2);
      await releasePort(foreign);
    }
  );

  it("relaunches on Windows when the :: probe fails for a reason other than a holder", async () => {
    await bootElectronApp({ appPath: appDir, port });
    await exitChild(children[0]!, 1, null);
    const listen = net.Server.prototype.listen;
    // An IPv6-less host refuses the :: bind with no process on the port.
    vi.spyOn(net.Server.prototype, "listen").mockImplementation(function (
      this: net.Server,
      ...args: unknown[]
    ) {
      if (args[1] !== "::") return listen.apply(this, args as never);
      const err = Object.assign(new Error("listen EAFNOSUPPORT"), { code: "EAFNOSUPPORT" });
      process.nextTick(() => this.emit("error", err));
      return this;
    });
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      const result = await registryWithRestartApp().invokeTool("restart-app", {
        udid: `chromium-cdp-${port}`,
        bundleId: "tag",
      });

      expect(result).toEqual(restarted());
      expect(children).toHaveLength(2);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("clears the pid of an app that its own failed relaunch stopped", async () => {
    await bootElectronApp({ appPath: appDir, port });
    const registry = registryWithRestartApp();
    const udid = `chromium-cdp-${port}`;
    const failSpawn = () => {
      throw new Error("spawn EAGAIN");
    };
    spawnMock.mockImplementationOnce(failSpawn);
    await registry.invokeTool("restart-app", { udid, bundleId: "tag" }).catch(() => {});

    expect(electronLaunchSpec(port)?.pid).toBeUndefined();
    spawnMock.mockImplementationOnce(failSpawn);
    const err = await registry.invokeTool("restart-app", { udid, bundleId: "tag" }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect((err as Error).message).toContain("restart-app could not relaunch the app: ");
    expect((err as Error).message).not.toContain("stopped");
  });

  it("keeps the boot's process group in the launch spec after its launcher exits", async () => {
    await bootElectronApp({ appPath: appDir, port });
    const leader = children[0]!;
    // The launcher exits on its own; the rest of its group lives on.
    leader.survivor = true;
    leader.exitCode = 0;
    leader.emit("exit", 0, null);

    expect(electronLaunchSpec(port)).toMatchObject({ pid: undefined, pgid: leader.pid });
  });

  it("spares a group that took the id of an app group that emptied after its launcher", async () => {
    await bootElectronApp({ appPath: appDir, port });
    const leader = children[0]!;
    leader.survivor = true;
    leader.exitCode = 0;
    leader.emit("exit", 0, null);
    // The rest of the group exits, then the kernel reuses the id.
    leader.survivor = false;
    await releasePort(await childServers.get(leader));
    await new Promise((r) => setTimeout(r, 200));
    recycledGroups.add(leader.pid);

    const result = await registryWithRestartApp().invokeTool("restart-app", {
      udid: `chromium-cdp-${port}`,
      bundleId: "tag",
    });

    expect(result).toEqual(restarted());
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      expect(process.kill).not.toHaveBeenCalledWith(-leader.pid, signal);
    }
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

  it("refuses a boot-device on a fixed port that a running copy holds, naming that copy's boot", async () => {
    await bootElectronApp({ appPath: appDir, port, extraArgs: ["--old"] });
    const registry = new Registry();
    registry.registerTool(createBootDeviceTool(registry));

    const err = await registry
      .invokeTool("boot-device", {
        electronAppPath: appDir,
        electronPort: port,
        electronArgs: ["--new"],
      })
      .then(
        () => undefined,
        (e: unknown) => e
      );

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.CHROMIUM_ELECTRON_PORT_IN_USE);
    expect((err as Error).message).toContain(
      `This tool-server session booted ${appDir} on that port with the arguments ["--old"], ` +
        `and restart-app relaunches that app with those arguments on chromium-cdp-${port}. ` +
        `To start another app or other arguments there,`
    );
    expect(children).toHaveLength(1);
    expect(electronLaunchSpec(port)?.pid).toBe(children[0]!.pid);
  });

  it("refuses a boot-device on a fixed port that a process Argent did not boot holds", async () => {
    forgetElectronLaunchSpec(port);
    const foreign = await holdPort(cdpServer());
    const registry = new Registry();
    registry.registerTool(createBootDeviceTool(registry));

    const err = await registry
      .invokeTool("boot-device", { electronAppPath: appDir, electronPort: port })
      .then(
        () => undefined,
        (e: unknown) => e
      );

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.CHROMIUM_ELECTRON_PORT_IN_USE);
    expect((err as Error).message).toContain(`Check which process listens on port ${port}`);
    expect((err as Error).message).not.toContain("restart-app");
    expect(spawnMock).not.toHaveBeenCalled();
    await releasePort(foreign);
  });

  it("forgets the port's app when a fixed-port boot-device there fails", async () => {
    await bootElectronApp({ appPath: appDir, port });
    await exitChild(children[0]!, 1, null);
    spawnMock.mockImplementationOnce(() => {
      throw new Error("spawn EAGAIN");
    });
    const registry = registryWithRestartApp();
    registry.registerTool(createBootDeviceTool(registry));
    await expect(
      registry.invokeTool("boot-device", { electronAppPath: appDir, electronPort: port })
    ).rejects.toThrow(/failed to spawn/);

    const err = await registry
      .invokeTool("restart-app", { udid: `chromium-cdp-${port}`, bundleId: "tag" })
      .then(
        () => undefined,
        (e: unknown) => e
      );

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.CHROMIUM_RESTART_NOT_BOOTED);
    expect((err as Error).message).toContain("a boot-device on its port failed since");
    expect(children).toHaveLength(1);
  });

  it("returns from a failed relaunch only once its copy is gone, so a retry relaunches", async () => {
    await bootElectronApp({ appPath: appDir, port });
    spawnMock.mockImplementationOnce(() => {
      const child = makeFakeChild();
      children.push(child);
      // The launcher exits before CDP is ready; the rest of its group holds the port.
      child.survivor = true;
      setTimeout(() => {
        child.exitCode = 1;
        child.emit("exit", 1, null);
      }, 10);
      return child;
    });
    const registry = registryWithRestartApp();
    const udid = `chromium-cdp-${port}`;
    await expect(registry.invokeTool("restart-app", { udid, bundleId: "tag" })).rejects.toThrow(
      /stopped the app but could not relaunch it/
    );

    const result = await registry.invokeTool("restart-app", { udid, bundleId: "tag" });

    expect(result).toEqual(restarted());
    expect(children).toHaveLength(3);
  });

  it("holds a boot-device on the fixed port of a restart in flight until the relaunch", async () => {
    await bootElectronApp({ appPath: appDir, port });
    spawnMock.mockImplementation(() => {
      const child = makeFakeChild(false);
      children.push(child);
      // The relaunch binds the port a moment after it starts.
      if (children.length === 2) {
        childServers.set(
          child,
          new Promise((r) => setTimeout(r, 200)).then(() => holdPort(cdpServer()))
        );
      }
      return child;
    });
    const registry = registryWithRestartApp();
    registry.registerTool(createBootDeviceTool(registry));
    let boot: Promise<unknown> | undefined;
    // Issued once the old copy has freed the port, before the relaunch binds it.
    children[0]!.once("exit", () => {
      boot = registry
        .invokeTool("boot-device", { electronAppPath: appDir, electronPort: port })
        .catch((e: unknown) => e);
    });

    await registry.invokeTool("restart-app", { udid: `chromium-cdp-${port}`, bundleId: "tag" });

    expect(getFailureSignal(await boot)?.error_code).toBe(
      FAILURE_CODES.CHROMIUM_ELECTRON_PORT_IN_USE
    );
    expect(children).toHaveLength(2);
  });

  it("waits for a process that outlives the launcher before checking the port", async () => {
    await bootElectronApp({ appPath: appDir, port });
    children[0]!.survivor = true;
    const registry = registryWithRestartApp();

    const result = await registry.invokeTool("restart-app", {
      udid: `chromium-cdp-${port}`,
      bundleId: "tag",
    });

    expect(result).toEqual(restarted());
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

  it("says it stopped the app when the port is still held after the kill", async () => {
    await bootElectronApp({ appPath: appDir, port });
    // The app is still running, but another process holds its port, so the port outlives the kill.
    await releasePort(await childServers.get(children[0]!));
    const foreign = await holdPort(cdpServer());

    const err = await registryWithRestartApp()
      .invokeTool("restart-app", { udid: `chromium-cdp-${port}`, bundleId: "tag" })
      .then(
        () => undefined,
        (e: unknown) => e
      );

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.CHROMIUM_RESTART_PORT_IN_USE);
    expect((err as Error).message).toContain(
      "restart-app stopped the copy of the app that Argent started but did not relaunch it"
    );
    expect((err as Error).message).toContain("Check which process listens on port");
    expect(children[0]!.kill).toHaveBeenCalled();
    await releasePort(foreign);
  });

  it("does not claim to have stopped a crashed app whose relaunch fails", async () => {
    await bootElectronApp({ appPath: appDir, port });
    await exitChild(children[0]!, 1, null);
    spawnMock.mockImplementationOnce(() => {
      throw new Error("spawn EAGAIN");
    });

    const err = await registryWithRestartApp()
      .invokeTool("restart-app", { udid: `chromium-cdp-${port}`, bundleId: "tag" })
      .then(
        () => undefined,
        (e: unknown) => e
      );

    expect((err as Error).message).toContain("restart-app could not relaunch the app: ");
    expect((err as Error).message).not.toContain("stopped");
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
    expect(second).toEqual({ status: "fulfilled", value: restarted() });
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
      expect(getFailureSignal(again)?.error_code).toBe(
        FAILURE_CODES.CHROMIUM_ELECTRON_APP_PATH_INVALID
      );
      expect(children[0]!.kill).not.toHaveBeenCalled();

      // Found in a later PATH entry, as the spawn would find it.
      fs.rmSync(path.join(otherBin, "electron"), { recursive: true });
      vi.stubEnv("PATH", [otherBin, emptyBin].join(path.delimiter));
      fs.chmodSync(path.join(emptyBin, "electron"), 0o755);
      await registry.invokeTool("restart-app", { udid, bundleId: "tag" });
      fs.rmSync(otherBin, { recursive: true, force: true });
      expect(children).toHaveLength(2);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
      fs.rmSync(emptyBin, { recursive: true, force: true });
    }
  });

  it("finds the fallback electron in the cwd through an empty PATH entry, as spawn does", async () => {
    const startCwd = process.cwd();
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "argent-restart-app-chromium-bare-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "argent-restart-app-chromium-cwd-"));
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "argent-restart-app-chromium-path-"));
    try {
      fs.writeFileSync(path.join(bare, "package.json"), JSON.stringify({ main: "main.js" }));
      fs.writeFileSync(path.join(cwd, "electron"), "", { mode: 0o755 });
      await bootElectronApp({ appPath: bare, port });
      process.chdir(cwd);
      vi.stubEnv("PATH", `${path.delimiter}${emptyBin}`);

      const result = await registryWithRestartApp().invokeTool("restart-app", {
        udid: `chromium-cdp-${port}`,
        bundleId: "tag",
      });

      expect(result).toEqual({ ...restarted(), appPath: bare });
      expect(children).toHaveLength(2);
    } finally {
      process.chdir(startCwd);
      for (const dir of [bare, cwd, emptyBin]) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says the app has exited when a crashed app's launcher is gone", async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "argent-restart-app-chromium-crashed-"));
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "argent-restart-app-chromium-path-"));
    try {
      fs.writeFileSync(path.join(bare, "package.json"), JSON.stringify({ main: "main.js" }));
      await bootElectronApp({ appPath: bare, port });
      await exitChild(children[0]!, 1, null);
      vi.stubEnv("PATH", emptyBin);

      const err = await registryWithRestartApp()
        .invokeTool("restart-app", { udid: `chromium-cdp-${port}`, bundleId: "tag" })
        .then(
          () => undefined,
          (e: unknown) => e
        );

      expect((err as Error).message).toContain(
        "restart-app did not relaunch the app, whose process has exited"
      );
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

  it("keeps the running app when its local electron is gone, even with one on PATH", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-restart-app-chromium-local-"));
    const globalBin = fs.mkdtempSync(path.join(os.tmpdir(), "argent-restart-app-chromium-path-"));
    try {
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ main: "main.js" }));
      fs.mkdirSync(path.join(dir, "node_modules", ".bin"), { recursive: true });
      fs.writeFileSync(path.join(dir, "node_modules", ".bin", "electron"), "", { mode: 0o755 });
      fs.writeFileSync(path.join(globalBin, "electron"), "", { mode: 0o755 });
      await bootElectronApp({ appPath: dir, port });
      fs.rmSync(path.join(dir, "node_modules"), { recursive: true });
      vi.stubEnv("PATH", globalBin);

      const err = await registryWithRestartApp()
        .invokeTool("restart-app", { udid: `chromium-cdp-${port}`, bundleId: "tag" })
        .then(
          () => undefined,
          (e: unknown) => e
        );

      expect(getFailureSignal(err)?.error_code).toBe(
        FAILURE_CODES.CHROMIUM_ELECTRON_APP_PATH_INVALID
      );
      expect((err as Error).message).toContain(
        "node_modules/.bin/electron, the launcher this app was booted with, is not an executable file"
      );
      expect(children[0]!.kill).not.toHaveBeenCalled();
      expect(children).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(globalBin, { recursive: true, force: true });
    }
  });

  it("keeps the running app when a local electron appeared after a boot through PATH", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-restart-app-chromium-added-"));
    const globalBin = fs.mkdtempSync(path.join(os.tmpdir(), "argent-restart-app-chromium-path-"));
    try {
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ main: "main.js" }));
      fs.writeFileSync(path.join(globalBin, "electron"), "", { mode: 0o755 });
      vi.stubEnv("PATH", globalBin);
      await bootElectronApp({ appPath: dir, port });
      fs.mkdirSync(path.join(dir, "node_modules", ".bin"), { recursive: true });
      fs.writeFileSync(path.join(dir, "node_modules", ".bin", "electron"), "", { mode: 0o755 });

      const err = await registryWithRestartApp()
        .invokeTool("restart-app", { udid: `chromium-cdp-${port}`, bundleId: "tag" })
        .then(
          () => undefined,
          (e: unknown) => e
        );

      expect(getFailureSignal(err)?.error_code).toBe(
        FAILURE_CODES.CHROMIUM_ELECTRON_APP_PATH_INVALID
      );
      expect((err as Error).message).toContain(
        "not with the 'electron' on PATH it was booted with"
      );
      expect(children[0]!.kill).not.toHaveBeenCalled();
      expect(children).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(globalBin, { recursive: true, force: true });
    }
  });

  it("is what flow-start-recording tells a chromium recording to start with", () => {
    const schema = zodObjectToJsonSchema(flowStartRecordingTool.zodSchema!) as {
      properties: { executionPrerequisite: { description: string } };
    };
    const description = schema.properties.executionPrerequisite.description;
    expect(description).toContain(
      "a leading restart-app of an app that boot-device started in this tool-server session"
    );
    expect(description).toContain("For any other chromium app, add that step to the YAML by hand.");
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
    expect((err as Error).message).toContain("Quit the app if it still runs, then start it again");
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
    [
      "args without the port flag Argent manages",
      ["--remote-debugging-port=1", "--feature-x"],
      {},
      false,
      () => ({ path: appDir, args: ["--feature-x"] }),
    ],
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
      const recorded = expected();
      expect(electronLaunchSpec(port)?.extraArgs).toEqual(
        typeof recorded === "string" ? [] : recorded.args
      );
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

  it("records a restart behind a step hand-added to the file mid-recording as a raw step", async () => {
    await bootElectronApp({ appPath: appDir, port });
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-restart-app-chromium-flow-"));
    try {
      await flowStartRecordingTool.execute({}, { name: "edited", project_root: projectRoot });
      const file = path.join(projectRoot, ".argent", "e2e", "edited.yaml");
      fs.writeFileSync(file, "version: 1\nsteps:\n  - tool: screenshot\n    args: {}\n");

      await createFlowAddStepTool(registryWithRestartApp()).execute(
        {},
        {
          name: "edited",
          project_root: projectRoot,
          command: "restart-app",
          args: JSON.stringify({ udid: `chromium-cdp-${port}`, bundleId: "tag" }),
        }
      );

      expect(parseFlow(fs.readFileSync(file, "utf8")).steps).toMatchObject([
        { kind: "tool", name: "screenshot" },
        { kind: "tool", name: "restart-app", args: { bundleId: "tag" } },
      ]);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("records a restart in the shutdown list as a raw step", async () => {
    await bootElectronApp({ appPath: appDir, port });
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-restart-app-chromium-flow-"));
    try {
      await flowStartRecordingTool.execute({}, { name: "cleanup", project_root: projectRoot });
      await flowInsertEchoTool.execute(
        {},
        { name: "cleanup", project_root: projectRoot, message: "start" }
      );

      await createFlowAddStepTool(registryWithRestartApp()).execute(
        {},
        {
          name: "cleanup",
          project_root: projectRoot,
          command: "restart-app",
          args: JSON.stringify({ udid: `chromium-cdp-${port}`, bundleId: "tag" }),
          shutdown: true,
        }
      );

      const flow = parseFlow(
        fs.readFileSync(path.join(projectRoot, ".argent", "e2e", "cleanup.yaml"), "utf8")
      );
      expect(flow.steps).toEqual([{ kind: "echo", message: "start" }]);
      expect(flow.shutdown).toEqual([
        { kind: "tool", name: "restart-app", args: { bundleId: "tag" } },
      ]);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ["only echo steps", "  - echo: seeded\n", { kind: "launch", app: { chromium: "__APP__" } }],
    [
      "a step that is not a launch",
      "  - tool: screenshot\n    args: {}\n",
      { kind: "tool", name: "restart-app", args: { bundleId: "tag" } },
    ],
    // That launch leads the run, so the restart is a later one.
    [
      "its own launch",
      "  - launch: { chromium: ./app }\n",
      { kind: "tool", name: "restart-app", args: { bundleId: "tag" } },
    ],
  ])(
    "records a restart behind a leading run: of a fragment of %s as the runner scans it",
    async (_name, fragmentSteps, expected) => {
      await bootElectronApp({ appPath: appDir, port });
      const projectRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "argent-restart-app-chromium-flow-")
      );
      try {
        await flowStartRecordingTool.execute({}, { name: "seeded", project_root: projectRoot });
        const dir = path.join(projectRoot, ".argent", "e2e");
        fs.writeFileSync(path.join(dir, "seed.yaml"), `version: 1\nsteps:\n${fragmentSteps}`);
        const file = path.join(dir, "seeded.yaml");
        fs.writeFileSync(file, "version: 1\nsteps:\n  - run: seed\n");

        await createFlowAddStepTool(registryWithRestartApp()).execute(
          {},
          {
            name: "seeded",
            project_root: projectRoot,
            command: "restart-app",
            args: JSON.stringify({ udid: `chromium-cdp-${port}`, bundleId: "tag" }),
          }
        );

        const steps = parseFlow(fs.readFileSync(file, "utf8")).steps;
        expect(steps).toMatchObject([
          { kind: "run", flow: "seed.yaml" },
          JSON.parse(JSON.stringify(expected).replace('"__APP__"', JSON.stringify(appDir))),
        ]);
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    }
  );

  it.each([
    ["two restarts", undefined, [{}, {}], 0],
    ["a restart behind a step that is not a launch", undefined, [{ delayMs: 1 }, {}], -1],
    ["a restart in a fragment", "the app shows its home screen", [{}], -1],
    ["a restart behind an echo", undefined, ["echo", {}], 1],
    ["a restart behind a script", undefined, ["script", {}], 1],
  ])(
    "records a Chromium restart as the launch only when it leads a standalone test: %s",
    async (_name, executionPrerequisite, restarts, launchAt) => {
      await bootElectronApp({ appPath: appDir, port });
      const registry = registryWithRestartApp();
      const projectRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "argent-restart-app-chromium-flow-")
      );
      try {
        await flowStartRecordingTool.execute(
          {},
          { name: "restarts", project_root: projectRoot, executionPrerequisite }
        );
        for (const extra of restarts) {
          if (extra === "echo") {
            await flowInsertEchoTool.execute(
              {},
              { name: "restarts", project_root: projectRoot, message: "start" }
            );
            continue;
          }
          if (extra === "script") {
            fs.mkdirSync(path.join(projectRoot, "scripts"));
            fs.writeFileSync(path.join(projectRoot, "scripts", "seed.mjs"), "output.ok = true;");
            const added = await flowAddScriptTool.execute(
              {},
              { name: "restarts", project_root: projectRoot, path: "../../scripts/seed.mjs" }
            );
            expect(added.status).toBe("pass");
            continue;
          }
          await createFlowAddStepTool(registry).execute(
            {},
            {
              name: "restarts",
              project_root: projectRoot,
              command: "restart-app",
              args: JSON.stringify({ udid: `chromium-cdp-${port}`, bundleId: "tag" }),
              ...extra,
            }
          );
        }

        const yaml = fs.readFileSync(
          path.join(projectRoot, ".argent", "e2e", "restarts.yaml"),
          "utf8"
        );
        const steps = parseFlow(yaml).steps;
        expect(steps).toHaveLength(restarts.length);
        steps.forEach((step, i) =>
          expect(step).toMatchObject(
            restarts[i] === "echo" || restarts[i] === "script"
              ? { kind: restarts[i] }
              : i === launchAt
                ? { kind: "launch", app: { chromium: appDir } }
                : { kind: "tool", name: "restart-app", args: { bundleId: "tag" } }
          )
        );
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    }
  );
});
