import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { DeviceInfo } from "@argent/registry";

// The Apple TV blueprint's respawn coalescing (`axRespawn` single-flight,
// unlink-and-rebind, exit-during-respawn) is the most concurrency-sensitive code
// in the TV change, but it spawns real daemons over unix sockets. We mock the
// three I/O boundaries it touches — child_process (daemon spawn), fs (socket
// file), net (socket connect) — plus the two device probes, and model socket
// liveness so the unlink → rebind window the race lives in is real: a socket is
// "dead" from the moment its file is unlinked until the freshly-spawned daemon
// binds it (deferred one macrotask, so a connect attempted in between fails,
// exactly as it would in production).

const h = vi.hoisted(() => {
  const liveSockets = new Set<string>();
  // execFile invocations, so a test can count ax-daemon spawns (cmd === "xcrun")
  // separately from the host HID daemon.
  const execFileCalls: Array<{ cmd: string; args: string[] }> = [];
  const killedProcs: Array<{ tag: string; signal: string | undefined }> = [];
  const unlinked: string[] = [];
  // When set, the host HID daemon spawn fails to ever bind its socket and exits,
  // so the factory's waitForSocket(hidSock) rejects and the error/cleanup path
  // runs. Lets a test exercise the half-up-daemon teardown without a 15s wait.
  // `axConnectHook` fires once, synchronously, when the ax socket is connected —
  // letting a test pull the socket out from under an in-flight connect (start a
  // concurrent recycle) in the gap between `ensureAxAlive()` and the connect, the
  // window `sendAx` retries.
  const state = {
    failHidSpawn: false,
    // When set, the host HID daemon emits `error` (a spawn fault) instead of
    // binding or exiting — the case waitForSocket must surface fast.
    hidSpawnError: false,
    axConnectHook: null as null | (() => void),
  };

  function socketArg(args: string[]): string | undefined {
    const i = args.indexOf("--socket");
    return i >= 0 ? args[i + 1] : undefined;
  }

  return { liveSockets, execFileCalls, killedProcs, unlinked, socketArg, state };
});

class FakeProc extends EventEmitter {
  killed = false;
  stderr = new EventEmitter();
  // "ax" (in-sim, simctl spawn) vs "hid" (host process) — set at spawn so a test
  // can assert each got the right kill signal.
  tag = "ax";
  kill(signal?: string) {
    this.killed = true;
    h.killedProcs.push({ tag: this.tag, signal });
    return true;
  }
}

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (cmd: string, args: string[]) => {
      h.execFileCalls.push({ cmd, args });
      const proc = new FakeProc();
      // The HID daemon runs its own host binary; the ax daemon runs via `xcrun
      // simctl spawn`. Tag by cmd so kill-signal assertions can tell them apart.
      const isHid = cmd === "/fake/tvos-hid-daemon";
      proc.tag = isHid ? "hid" : "ax";
      if (isHid && h.state.hidSpawnError) {
        // Emit `error` (not `exit`) — the spawn-fault signal. Never bind the
        // socket. waitForSocket must catch this and reject fast with the cause.
        setTimeout(() => proc.emit("error", new Error("spawn /fake/tvos-hid-daemon ENOENT")), 0);
        return proc;
      }
      if (isHid && h.state.failHidSpawn) {
        // Never bind the socket; exit so waitForSocket(hidSock) rejects fast.
        setTimeout(() => proc.emit("exit", 1), 0);
        return proc;
      }
      // The daemon binds its socket shortly after launch. Defer one macrotask so
      // there is a genuine window where the socket file has been unlinked by a
      // respawn but the new daemon has not yet rebound it.
      const sock = h.socketArg(args);
      if (sock) setTimeout(() => h.liveSockets.add(sock), 0);
      return proc;
    },
  };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: (p: string) => h.liveSockets.has(p),
    unlinkSync: (p: string) => {
      h.unlinked.push(p);
      h.liveSockets.delete(p);
    },
  };
});

vi.mock("node:net", async () => {
  const actual = await vi.importActual<typeof import("node:net")>("node:net");
  // A connection to a live socket connects and, on write, replies; to a dead
  // socket it errors (the failure mode the race would otherwise hit).
  function createConnection(path: string) {
    const sock = new EventEmitter() as EventEmitter & {
      write: (line: string) => void;
      destroy: () => void;
    };
    sock.destroy = () => {};
    sock.write = (line: string) => {
      // `describe` expects a JSON body; navigate/type tolerate an empty reply.
      const reply = line.startsWith("describe")
        ? JSON.stringify({
            bundleId: "com.example.tvapp",
            focused: { label: "Home", isFocused: true },
            focusable: [{ label: "Home", isFocused: true }, { label: "Movies" }],
          })
        : "";
      setImmediate(() => {
        sock.emit("data", Buffer.from(reply, "utf8"));
        sock.emit("end");
      });
    };
    setImmediate(() => {
      // Fire a one-shot hook just before the liveness check so a test can pull
      // the ax socket out from under an in-flight connect (the sendAx race
      // window). Synchronous so any unlink it triggers is visible to the check.
      if (path.includes("-ax-") && h.state.axConnectHook) {
        const hook = h.state.axConnectHook;
        h.state.axConnectHook = null;
        hook();
      }
      if (h.liveSockets.has(path)) sock.emit("connect");
      else sock.emit("error", new Error(`ECONNREFUSED ${path}`));
    });
    return sock;
  }
  return { ...actual, createConnection, default: { ...actual, createConnection } };
});

vi.mock("../src/blueprints/ax-service", () => ({
  ensureAutomationEnabled: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@argent/native-devtools-ios", () => ({
  tvosAxServiceBinaryPath: () => "/fake/tvos-ax-service",
  tvosHidDaemonBinaryPath: () => "/fake/tvos-hid-daemon",
}));

const listIosSimulatorsMock = vi.fn();
const cacheSimulatorRuntimeKindMock = vi.fn();
vi.mock("../src/utils/ios-devices", () => ({
  listIosSimulators: () => listIosSimulatorsMock(),
  cacheSimulatorRuntimeKind: (...args: unknown[]) => cacheSimulatorRuntimeKindMock(...args),
}));

import { tvControlBlueprint, typeTimeoutMs } from "../src/blueprints/tv-control";
import { UnsupportedOperationError } from "../src/utils/capability";

const UDID = "DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD";
const DEVICE: DeviceInfo = { id: UDID, platform: "ios", kind: "simulator" };

function axSpawnCount(): number {
  // spawnAxDaemon shells out via `xcrun simctl spawn`; the host HID daemon runs
  // its own binary, so filtering on "xcrun" isolates ax (re)spawns.
  return h.execFileCalls.filter((c) => c.cmd === "xcrun").length;
}

async function buildService() {
  return tvControlBlueprint.factory({} as never, undefined as never, { device: DEVICE } as never);
}

beforeEach(() => {
  h.liveSockets.clear();
  h.execFileCalls.length = 0;
  h.killedProcs.length = 0;
  h.unlinked.length = 0;
  h.state.failHidSpawn = false;
  h.state.hidSpawnError = false;
  h.state.axConnectHook = null;
  listIosSimulatorsMock.mockReset();
  cacheSimulatorRuntimeKindMock.mockReset();
  listIosSimulatorsMock.mockResolvedValue([
    { udid: UDID, name: "Apple TV", runtime: "tvOS 17.0", runtimeKind: "tv", state: "Booted" },
  ]);
});

describe("tvControlBlueprint — ax respawn coalescing", () => {
  it("spawns the ax + hid daemons and serves describe over their sockets", async () => {
    const instance = await buildService();
    expect(axSpawnCount()).toBe(1); // one ax spawn at init
    const res = await instance.api.describe();
    expect(res.bundleId).toBe("com.example.tvapp");
    expect(res.focusable).toHaveLength(2);
    await instance.dispose();
  });

  it("coalesces concurrent recycleAx() calls onto a single respawn", async () => {
    const instance = await buildService();
    const baseline = axSpawnCount(); // 1 (init)

    // Three recyclers fire at once; the single-flight `axRespawn` guard must
    // fold them into one spawnFreshAx, not three competing kill/unlink/respawns.
    await Promise.all([
      instance.api.recycleAx(),
      instance.api.recycleAx(),
      instance.api.recycleAx(),
    ]);

    expect(axSpawnCount()).toBe(baseline + 1);
    await instance.dispose();
  });

  it("makes a concurrent describe() await an in-flight respawn instead of hitting the unlinked socket", async () => {
    const instance = await buildService();

    // Start a recycle but do NOT await it: its synchronous prefix kills the ax
    // daemon and unlinks the socket, then suspends waiting for the rebind. The
    // socket is dead for this whole window.
    const recycling = instance.api.recycleAx();

    // A describe arriving now must observe the in-flight respawn and await it
    // (the fix). Without that guard `ensureAxAlive` returns early — `axExited` is
    // false — and the describe connects to the just-unlinked socket and fails.
    const res = await instance.api.describe();
    await recycling;

    expect(res.bundleId).toBe("com.example.tvapp");
    // Exactly one respawn happened despite the overlap (init + the one recycle).
    expect(axSpawnCount()).toBe(2);
    await instance.dispose();
  });

  it("retries describe() when a recycle unlinks the socket AFTER ensureAxAlive() returns", async () => {
    const instance = await buildService();

    // The narrow window the in-flight-respawn guard does NOT cover: describe's
    // `ensureAxAlive()` resolves while no respawn is pending (socket live), then a
    // concurrent recycle on the shared instance unlinks the socket before the
    // connect lands. Drive it deterministically — start the recycle from inside
    // the ax connect hook, so the first connect hits a just-unlinked socket and
    // must error, then `sendAx` waits out the respawn and retries.
    let recycling: Promise<void> | undefined;
    h.state.axConnectHook = () => {
      recycling = instance.api.recycleAx();
    };

    const res = await instance.api.describe();
    await recycling;

    // describe still returns real data despite the mid-flight unlink, and only
    // one extra respawn happened (init + the single recycle).
    expect(res.bundleId).toBe("com.example.tvapp");
    expect(axSpawnCount()).toBe(2);
    await instance.dispose();
  });

  it("dispose() kills both daemons and removes their sockets", async () => {
    const instance = await buildService();
    await instance.dispose();
    // ax + hid procs both killed; both socket files unlinked.
    expect(h.killedProcs.length).toBeGreaterThanOrEqual(2);
    expect(h.unlinked.some((p) => p.includes("ax"))).toBe(true);
    expect(h.unlinked.some((p) => p.includes("hid"))).toBe(true);
    // The in-sim ax daemon (simctl spawn) must be SIGKILLed — SIGTERM doesn't
    // propagate through `simctl spawn` and would orphan it; the host hid daemon
    // takes SIGTERM.
    expect(h.killedProcs.find((p) => p.tag === "ax")?.signal).toBe("SIGKILL");
    expect(h.killedProcs.find((p) => p.tag === "hid")?.signal).toBe("SIGTERM");
  });

  it("SIGKILLs the in-sim ax daemon and clears sockets when the factory fails mid-startup", async () => {
    // The hid daemon never binds its socket, so waitForSocket(hidSock) rejects
    // and the factory throws. The ax daemon may already be up — its in-sim
    // process must be SIGKILLed (not SIGTERMed, which `simctl spawn` swallows,
    // orphaning it) and any bound socket unlinked so the next attempt can't see
    // a stale false-ready file.
    h.state.failHidSpawn = true;
    await expect(buildService()).rejects.toThrow();

    const ax = h.killedProcs.find((p) => p.tag === "ax");
    const hid = h.killedProcs.find((p) => p.tag === "hid");
    expect(ax?.signal).toBe("SIGKILL");
    expect(hid?.signal).toBe("SIGTERM");
    // No socket survives the failed factory.
    expect([...h.liveSockets]).toHaveLength(0);
    expect(h.unlinked.some((p) => p.includes("ax"))).toBe(true);
  });

  it("fails fast with the spawn cause when a daemon emits `error` instead of binding", async () => {
    // A missing binary fires `error`, never `exit`. The old exit-only wait
    // polled to the 15s deadline; it must now surface the cause immediately.
    h.state.hidSpawnError = true;
    const started = Date.now();
    await expect(buildService()).rejects.toThrow(/failed to spawn|ENOENT/i);
    // Well under the 15s socket deadline — proof it didn't poll to timeout.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("does not leak an ax daemon when dispose() races an in-flight recycle", async () => {
    const instance = await buildService();

    // Start a recycle (spawns a fresh ax daemon, awaits its socket) but DON'T
    // await it, then dispose while that respawn is still in flight. dispose must
    // wait out the respawn and kill the daemon it produces; spawnFreshAx must
    // also re-check `disposed` and self-reap. Either way nothing may survive.
    const recycling = instance.api.recycleAx();
    const disposing = instance.dispose();
    await Promise.all([recycling.catch(() => {}), disposing]);

    // Give any deferred socket-bind (setTimeout in the execFile mock) a chance to
    // fire, so a daemon that escaped teardown would re-create its socket here.
    await new Promise((r) => setTimeout(r, 0));

    // Every ax daemon spawned (init + the recycle's) plus the hid daemon is
    // killed — no orphaned in-sim process outlives the service.
    expect(h.killedProcs.length).toBe(axSpawnCount() + 1);
    // And the ax socket is gone, not left re-bound by a surviving daemon.
    expect([...h.liveSockets].some((p) => p.includes("ax"))).toBe(false);
  });
});

describe("tvControlBlueprint — type() timeout scaling", () => {
  it("scales the socket timeout with input length so a long string can't time out mid-type", () => {
    // A single press / short string still gets the ~10s floor.
    expect(typeTimeoutMs(0)).toBe(10_000);
    // A few-hundred-char input — which at ~40ms/char takes well over the old
    // fixed 10s — gets a budget comfortably above its real typing time.
    const longInput = 300;
    const realTypingMs = longInput * 40; // the daemon's ~40ms/keypress cadence
    expect(typeTimeoutMs(longInput)).toBeGreaterThan(realTypingMs);
    expect(typeTimeoutMs(longInput)).toBeGreaterThan(10_000); // and above the old fixed default
    // Monotonic in length.
    expect(typeTimeoutMs(500)).toBeGreaterThan(typeTimeoutMs(100));
  });

  it("types a long string over the hid socket without a timeout failure", async () => {
    const instance = await buildService();
    // The socket mock replies on the next macrotask, so as long as type() passes
    // a length-scaled timeout (not a value that fires first) this resolves.
    await expect(instance.api.type("x".repeat(400))).resolves.toBeUndefined();
    await instance.dispose();
  });

  it("rejects newline-containing text instead of silently truncating it", async () => {
    const instance = await buildService();
    // One line per connection: `foo\nbar` would type only `foo` yet resolve
    // cleanly. type() must reject rather than report the dropped tail as typed.
    await expect(instance.api.type("foo\nbar")).rejects.toThrow(/newline/i);
    await expect(instance.api.type("foo\rbar")).rejects.toThrow(/newline/i);
    // A newline-free string still types fine.
    await expect(instance.api.type("foobar")).resolves.toBeUndefined();
    await instance.dispose();
  });
});

describe("tvControlBlueprint — target validation", () => {
  it("rejects a non-tvOS simulator with an UnsupportedOperationError (→ 400, not 500)", async () => {
    listIosSimulatorsMock.mockResolvedValue([
      {
        udid: UDID,
        name: "iPhone 15",
        runtime: "iOS 17.0",
        runtimeKind: "mobile",
        state: "Booted",
      },
    ]);
    // UnsupportedOperationError so http.ts maps it to 400, not 500.
    const err = await buildService().then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(UnsupportedOperationError);
    expect(err.message).toMatch(/tvOS-only/);
    // The warm runs BEFORE this reject, so a misrouted iPhone caches its true
    // `mobile` kind (keeping its telemetry coarse `ios`, never mislabeled tvOS).
    // Pins the warm-before-reject ordering: moving the warm below the throw would
    // silently regress refinement for this path with no other test catching it.
    expect(cacheSimulatorRuntimeKindMock).toHaveBeenCalledWith(UDID, "mobile");
  });

  it("warms the telemetry runtime-kind cache with the resolved tvOS kind", async () => {
    // The factory already fetched the simulator list to validate the target, so it
    // seeds the synchronous cache the telemetry hot path reads — without this, a
    // tv-remote-only Apple TV session never warms the cache and stays coarse `ios`,
    // asymmetric with the Android TV factory. Refinement lands from the next call.
    await buildService();
    expect(cacheSimulatorRuntimeKindMock).toHaveBeenCalledWith(UDID, "tv");
  });

  it("rejects a tvOS simulator that isn't booted", async () => {
    listIosSimulatorsMock.mockResolvedValue([
      { udid: UDID, name: "Apple TV", runtime: "tvOS 17.0", runtimeKind: "tv", state: "Shutdown" },
    ]);
    await expect(buildService()).rejects.toThrow(/Boot it first/);
  });

  it("rejects when no simulator matches the udid", async () => {
    listIosSimulatorsMock.mockResolvedValue([]);
    await expect(buildService()).rejects.toThrow(/no available simulator/);
    // The no-match throw is before the warm call, so nothing is cached.
    expect(cacheSimulatorRuntimeKindMock).not.toHaveBeenCalled();
  });
});
