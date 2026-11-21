import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIBER_ROOT_TRACKER_SCRIPT,
  REACT_NATIVE_PROFILER_SETUP_SCRIPT,
  STOP_AND_READ_SCRIPT,
  buildStartScript,
} from "../../src/utils/react-profiler/scripts";

/**
 * Drives the injected scripts against a fake DevTools backend that keeps the
 * behaviour of the real one they depend on:
 *
 * - `operations` events run synchronously inside the commit, after unmounted
 *   fibers have already left the ID map.
 * - Until the first `flushInitialOperations` the backend queues those events
 *   instead of emitting them. The first flush replays the queue.
 * - Any later flush walks the tree again, emits ADD entries for all of it, and
 *   gives every fiber a new ID, as DevTools 6 and later do. IDs are never reused.
 * - `operations` shows a rendered fiber only if its tree base duration changed.
 * - `getProfilingData` rebuilds every commit recorded so far.
 * - The name accessor only knows mounted fibers.
 */

const OP_ADD = 1;
const OP_REMOVE = 2;
const OP_UPDATE_TREE_BASE_DURATION = 4;

type Listener = (operations: number[]) => void;

interface FakeHook {
  rendererInterfaces: Map<number, FakeRenderer["ri"]>;
  onCommitFiberRoot: (rendererID: number, root: unknown, priorityLevel?: number) => void;
  sub: ReturnType<typeof vi.fn>;
  emit: (operations: number[]) => void;
  listeners: Listener[];
  nextID: number;
  __argent_roots__?: Set<unknown>;
}

interface CommitOptions {
  mount?: Array<[number, string]>;
  unmount?: number[];
  /** In the commit's durations, but not in `operations`. */
  rendered?: number[];
  /** Rendered with a new tree base duration, the only update `operations` carries. */
  baseDurationChanged?: number[];
}

interface FakeRenderer {
  ri: Record<string, unknown> & {
    flushInitialOperations: ReturnType<typeof vi.fn>;
    startProfiling: (...args: unknown[]) => void;
    stopProfiling: () => void;
    getProfilingData: ReturnType<typeof vi.fn>;
    getDisplayNameForElementID?: ReturnType<typeof vi.fn>;
    getDisplayNameForFiberID?: ReturnType<typeof vi.fn>;
    __argent_isProfiling__?: boolean;
  };
  live: Map<number, string>;
  /** What the next `onCommitFiberRoot` for this renderer applies. */
  pending: CommitOptions;
  /** Order of the backend calls. */
  calls: string[];
}

function makeRenderer(
  hook: FakeHook,
  rendererID: number,
  opts: {
    mounted?: Array<[number, string]>;
    /** ADD fields after the id. 6 is the layout up to DevTools 6, 7 from 7.0. */
    addFields?: number;
    nameApi?: "element" | "fiber";
    /** The queue is already gone: `initBackend` or a frontend flushed it. */
    drained?: boolean;
  } = {}
): FakeRenderer {
  const mounted = opts.mounted ?? [];
  const live = new Map<number, string>(mounted);
  const addFields = opts.addFields ?? 6;
  const commits: Array<{ fiberActualDurations: Array<[number, number]> }> = [];

  function addOps(entries: Array<[number, string]>): number[] {
    const ops: number[] = [];
    for (const [id] of entries) {
      // [ADD, id, type, parentID, ownerID, nameStringID, keyStringID, ...]
      ops.push(OP_ADD, id, 5, 0, 0, 1, 0);
      for (let i = 6; i < addFields; i++) ops.push(0);
    }
    return ops;
  }

  let queue: number[][] | null = opts.drained ? null : [[rendererID, 1, 0, ...addOps(mounted)]];
  const emitOrQueue = (operations: number[]) => {
    if (queue) queue.push(operations);
    else hook.emit(operations);
  };

  const lookup = (id: number) => {
    fake.calls.push("name");
    return live.get(id) ?? null;
  };
  const fake: FakeRenderer = {
    live,
    pending: {},
    calls: [],
    ri: {
      flushInitialOperations: vi.fn(() => {
        fake.calls.push("flush");
        const replay = queue;
        queue = null;
        if (replay && replay.length > 0) {
          replay.forEach((operations) => hook.emit(operations));
          return;
        }
        const walked = [...live].map(([, name]): [number, string] => [hook.nextID++, name]);
        live.clear();
        walked.forEach(([id, name]) => live.set(id, name));
        hook.emit([rendererID, 1, 0, ...addOps(walked)]);
      }),
      startProfiling: vi.fn(() => {
        fake.calls.push("start");
      }),
      stopProfiling: vi.fn(),
      getProfilingData: vi.fn(() => ({
        dataForRoots: commits.length
          ? [{ rootID: 1, commitData: commits.map((c) => ({ ...c })) }]
          : [],
      })),
      handleCommitFiberRoot: () => {
        const { mount = [], unmount = [], rendered = [], baseDurationChanged = [] } = fake.pending;
        fake.pending = {};
        mount.forEach(([id, name]) => live.set(id, name));
        unmount.forEach((id) => live.delete(id));
        const ids = [...rendered, ...baseDurationChanged, ...mount.map(([id]) => id)];
        commits.push({ fiberActualDurations: ids.map((id) => [id, 1]) });
        const ops: number[] = [rendererID, 1, 0];
        if (unmount.length) ops.push(OP_REMOVE, unmount.length, ...unmount);
        ops.push(...addOps(mount));
        ops.push(...baseDurationChanged.flatMap((id) => [OP_UPDATE_TREE_BASE_DURATION, id, 1500]));
        if (ops.length > 3) emitOrQueue(ops);
      },
    },
  };
  if ((opts.nameApi ?? "element") === "element") {
    fake.ri.getDisplayNameForElementID = vi.fn(lookup);
  } else {
    fake.ri.getDisplayNameForFiberID = vi.fn(lookup);
  }
  hook.rendererInterfaces.set(rendererID, fake.ri);
  return fake;
}

function makeHook(): FakeHook {
  const hook: FakeHook = {
    rendererInterfaces: new Map(),
    listeners: [],
    nextID: 1000,
    sub: vi.fn((event: string, fn: Listener) => {
      if (event === "operations") hook.listeners.push(fn);
      return () => {};
    }),
    emit: (operations) => hook.listeners.forEach((fn) => fn(operations)),
    onCommitFiberRoot: (rendererID) => {
      const ri = hook.rendererInterfaces.get(rendererID);
      (ri?.handleCommitFiberRoot as (() => void) | undefined)?.();
    },
  };
  return hook;
}

function evalIIFE<T = unknown>(script: string): T {
  return (0, eval)(script) as T;
}

const ownerJson = JSON.stringify({
  sessionId: "sess-test",
  startedAtEpochMs: 0,
  lastHeartbeatEpochMs: 0,
});

interface StopRead {
  live: { dataForRoots: unknown[] } | null;
  displayNameById: Record<string, string | null>;
}

function install(): void {
  evalIIFE(FIBER_ROOT_TRACKER_SCRIPT);
  evalIIFE(REACT_NATIVE_PROFILER_SETUP_SCRIPT);
}

function start(): void {
  const out = JSON.parse(evalIIFE<string>(buildStartScript(ownerJson))) as { ok: boolean };
  expect(out.ok).toBe(true);
}

function commit(
  hook: FakeHook,
  renderer: FakeRenderer,
  rendererID: number,
  c: CommitOptions
): void {
  renderer.pending = c;
  hook.onCommitFiberRoot(rendererID, { rendererID }, 0);
}

function stop(): StopRead {
  return JSON.parse(evalIIFE<string>(STOP_AND_READ_SCRIPT)) as StopRead;
}

function bucketOf(ri: object): Record<number, string> | undefined {
  const cache = (globalThis as Record<string, unknown>).__argent_fiberNames__ as WeakMap<
    object,
    Record<number, string>
  >;
  return cache.get(ri);
}

/** A flush can renumber every fiber, so find one by name afterwards. */
function idOf(renderer: FakeRenderer, name: string): number {
  const entry = [...renderer.live].find(([, n]) => n === name);
  if (!entry) throw new Error(`no live fiber named ${name}`);
  return entry[0];
}

describe("FIBER_ROOT_TRACKER_SCRIPT fiber-name cache", () => {
  const g = globalThis as Record<string, unknown>;
  let hook: FakeHook;

  beforeEach(() => {
    hook = makeHook();
    g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
    g.__argent_fiberNames__ = new WeakMap();
    g.__ARGENT_PROFILER_OWNER__ = null;
  });

  afterEach(() => {
    delete g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    delete g.__ARGENT_PROFILER_OWNER__;
    delete g.__argent_fiberNames__;
    delete g.__argent_profilerHeartbeat;
  });

  describe("names of unmounted components", () => {
    it("resolves a component that mounts and unmounts during the recording", () => {
      const r = makeRenderer(hook, 1, { mounted: [[10, "App"]] });
      install();
      start();

      commit(hook, r, 1, { mount: [[20, "Modal"]] });
      commit(hook, r, 1, { unmount: [20] });

      expect(r.live.has(20)).toBe(false);
      expect(stop().displayNameById["20"]).toBe("Modal");
    });

    it("resolves a component mounted before the recording, from the queue the flush replays", () => {
      const r = makeRenderer(hook, 1, {
        mounted: [
          [10, "App"],
          [11, "Screen"],
        ],
      });
      install();
      start();

      // Neither commit shows this fiber's ID: only the flush can name it.
      commit(hook, r, 1, { rendered: [11] });
      commit(hook, r, 1, { unmount: [11] });

      expect(r.live.has(11)).toBe(false);
      expect(stop().displayNameById["11"]).toBe("Screen");
    });

    it("resolves a component that mounted between launch and the first flush", () => {
      const r = makeRenderer(hook, 1, { mounted: [[10, "App"]] });
      install();

      commit(hook, r, 1, { mount: [[30, "Queued"]] });
      expect(r.ri.getDisplayNameForElementID).not.toHaveBeenCalled();

      start();
      commit(hook, r, 1, { rendered: [30] });
      commit(hook, r, 1, { unmount: [30] });

      expect(stop().displayNameById["30"]).toBe("Queued");
    });

    it("resolves a component mounted before the recording when the queue is already drained", () => {
      // The default once initBackend ran. The flush renumbers the tree.
      const r = makeRenderer(hook, 1, {
        drained: true,
        mounted: [
          [10, "App"],
          [11, "Screen"],
        ],
      });
      install();
      start();

      const id = idOf(r, "Screen");
      expect(id).not.toBe(11);
      commit(hook, r, 1, { rendered: [id] });
      commit(hook, r, 1, { unmount: [id] });

      expect(stop().displayNameById[String(id)]).toBe("Screen");
    });

    it("resolves a component mounted before a second recording in the same runtime", () => {
      const r = makeRenderer(hook, 1, {
        mounted: [
          [10, "App"],
          [11, "Screen"],
        ],
      });
      install();
      start();
      stop();

      start();
      const id = idOf(r, "Screen");
      commit(hook, r, 1, { rendered: [id] });
      commit(hook, r, 1, { unmount: [id] });

      expect(stop().displayNameById[String(id)]).toBe("Screen");
    });

    it("keeps names across a restart that skips the flush", () => {
      // A DevTools frontend pressing stop and record during an Argent recording.
      const r = makeRenderer(hook, 1, {
        mounted: [
          [10, "App"],
          [11, "Screen"],
        ],
      });
      install();
      start();

      r.ri.stopProfiling();
      r.ri.startProfiling(true);
      expect(r.ri.__argent_isProfiling__).toBe(true);

      commit(hook, r, 1, { rendered: [11] });
      commit(hook, r, 1, { unmount: [11] });

      expect(stop().displayNameById["11"]).toBe("Screen");
    });

    it.each([
      ["DevTools 6 and earlier", 6],
      ["DevTools 7 and later", 7],
    ])("reads the ADD layout of %s", (_label, addFields) => {
      const r = makeRenderer(hook, 1, { mounted: [[10, "App"]], addFields });
      install();
      start();

      commit(hook, r, 1, {
        mount: [
          [20, "First"],
          [21, "Second"],
        ],
      });
      commit(hook, r, 1, { unmount: [20, 21] });

      const { displayNameById } = stop();
      expect(displayNameById["20"]).toBe("First");
      expect(displayNameById["21"]).toBe("Second");
    });

    it("uses getDisplayNameForFiberID on older DevTools", () => {
      const r = makeRenderer(hook, 1, { mounted: [[10, "App"]], nameApi: "fiber" });
      install();
      start();

      commit(hook, r, 1, { mount: [[20, "OldApi"]] });
      commit(hook, r, 1, { unmount: [20] });

      expect(stop().displayNameById["20"]).toBe("OldApi");
    });

    it("flushes before starting and names fibers after", () => {
      // A flush can renumber what start snapshots. Naming goes last because
      // commit times count from start and CPU samples from before it.
      const r = makeRenderer(hook, 1, { mounted: [[10, "App"]] });
      install();
      start();

      expect(r.calls.slice(0, 3)).toEqual(["flush", "start", "name"]);
      expect(bucketOf(r.ri)?.[10]).toBe("App");
    });
  });

  describe("cost", () => {
    it("does not read the profiling data on commits", () => {
      const r = makeRenderer(hook, 1, { mounted: [[10, "App"]] });
      install();
      start();

      for (let i = 0; i < 500; i++) commit(hook, r, 1, { baseDurationChanged: [10] });
      expect(r.ri.getProfilingData).not.toHaveBeenCalled();

      stop();
      expect(r.ri.getProfilingData).toHaveBeenCalledTimes(1);
    });

    it("does the same work per commit however long the recording is", () => {
      const r = makeRenderer(hook, 1, { mounted: [[10, "App"]] });
      install();
      start();
      const accessor = r.ri.getDisplayNameForElementID!;

      function callsForOneCommit(): number {
        const before = accessor.mock.calls.length;
        commit(hook, r, 1, { baseDurationChanged: [10] });
        return accessor.mock.calls.length - before;
      }

      const early = callsForOneCommit();
      for (let i = 0; i < 1000; i++) commit(hook, r, 1, { baseDurationChanged: [10] });
      expect(callsForOneCommit()).toBe(early);
      expect(r.ri.getProfilingData).not.toHaveBeenCalled();
    });

    it("looks a named fiber up only once", () => {
      const r = makeRenderer(hook, 1, { mounted: [[10, "App"]] });
      install();
      start();
      commit(hook, r, 1, { mount: [[20, "Row"]] });

      const accessor = r.ri.getDisplayNameForElementID!;
      accessor.mockClear();
      commit(hook, r, 1, { baseDurationChanged: [20] });

      expect(accessor).not.toHaveBeenCalledWith(20);
    });
  });

  describe("renderers", () => {
    it("files each event under the renderer it came from", () => {
      const fabric = makeRenderer(hook, 1, { mounted: [[50, "FabricThing"]] });
      const paper = makeRenderer(hook, 2, { mounted: [[51, "PaperThing"]] });
      install();
      start();

      commit(hook, fabric, 1, { mount: [[60, "FabricOnly"]] });

      expect(bucketOf(fabric.ri)).toEqual({ 50: "FabricThing", 60: "FabricOnly" });
      expect(bucketOf(paper.ri)).toEqual({ 51: "PaperThing" });
    });

    it("starts every renderer before naming any", () => {
      // Time spent naming the first renderer's fibers would otherwise delay the
      // second one's start, and with it the zero of its commit timestamps.
      const a = makeRenderer(hook, 1, { mounted: [[50, "First"]] });
      const b = makeRenderer(hook, 2, { mounted: [[51, "Second"]] });
      const startB = b.ri.startProfiling as ReturnType<typeof vi.fn>;
      install();
      start();

      const firstName = a.ri.getDisplayNameForElementID!.mock.invocationCallOrder[0]!;
      expect(startB.mock.invocationCallOrder[0]!).toBeLessThan(firstName);
      expect(bucketOf(a.ri)?.[50]).toBe("First");
      expect(bucketOf(b.ri)?.[51]).toBe("Second");
    });

    it("still names the other renderers when one start throws", () => {
      const broken = makeRenderer(hook, 1, { mounted: [[50, "Broken"]] });
      const good = makeRenderer(hook, 2, { mounted: [[51, "Good"]] });
      broken.ri.startProfiling = vi.fn(() => {
        throw new Error("no start");
      });
      install();
      start();

      expect(bucketOf(broken.ri)?.[50]).toBeUndefined();
      expect(bucketOf(good.ri)?.[51]).toBe("Good");
    });

    it("ignores events for a renderer that is not registered", () => {
      const r = makeRenderer(hook, 1, { mounted: [[10, "App"]] });
      install();
      start();

      expect(() => hook.emit([99, 1, 0, OP_ADD, 77, 5, 0, 0, 1, 0])).not.toThrow();
      expect(bucketOf(r.ri)?.[77]).toBeUndefined();
    });
  });

  describe("install and failure", () => {
    it("installs once however many times the script is evaluated", () => {
      const r = makeRenderer(hook, 1, { mounted: [[10, "App"]] });
      const original = hook.onCommitFiberRoot;
      install();
      const wrapped = hook.onCommitFiberRoot;
      install();

      expect(wrapped).not.toBe(original);
      expect(hook.onCommitFiberRoot).toBe(wrapped);
      expect(hook.sub).toHaveBeenCalledTimes(1);

      start();
      commit(hook, r, 1, { mount: [[20, "Once"]] });
      expect(bucketOf(r.ri)?.[20]).toBe("Once");
    });

    it("still tracks roots and lets commits through when the hook has no sub", () => {
      const r = makeRenderer(hook, 1, { mounted: [[10, "App"]] });
      (hook as Partial<FakeHook>).sub = undefined;
      const original = vi.fn(hook.onCommitFiberRoot);
      hook.onCommitFiberRoot = original;
      install();

      const root = { name: "root" };
      r.pending = {};
      hook.onCommitFiberRoot(1, root, 0);

      expect(original).toHaveBeenCalledTimes(1);
      expect(hook.__argent_roots__?.has(root)).toBe(true);
    });

    it("never lets a failure reach the commit", () => {
      const r = makeRenderer(hook, 1, { mounted: [[10, "App"]] });
      install();
      start();

      r.ri.getDisplayNameForElementID!.mockImplementation(() => {
        throw new Error("accessor broke");
      });
      expect(() => commit(hook, r, 1, { mount: [[20, "Broken"]] })).not.toThrow();

      // Neither must the cache going away or a malformed event.
      g.__argent_fiberNames__ = undefined;
      expect(() => commit(hook, r, 1, { mount: [[21, "NoCache"]] })).not.toThrow();
      g.__argent_fiberNames__ = new WeakMap();
      expect(() => hook.emit(undefined as unknown as number[])).not.toThrow();
    });

    it("keeps names from an accessor that fails for only some IDs", () => {
      const r = makeRenderer(hook, 1, { mounted: [[10, "App"]] });
      install();
      start();

      r.ri.getDisplayNameForElementID!.mockImplementation((id: number) => {
        if (id === 20) throw new Error("one bad fiber");
        return r.live.get(id) ?? null;
      });
      commit(hook, r, 1, {
        mount: [
          [20, "Bad"],
          [21, "Good"],
        ],
      });

      expect(bucketOf(r.ri)?.[20]).toBeUndefined();
      expect(bucketOf(r.ri)?.[21]).toBe("Good");
    });
  });

  describe("lifecycle", () => {
    it("does nothing while no recording is running", () => {
      const r = makeRenderer(hook, 1, { mounted: [[10, "App"]], drained: true });
      install();
      const accessor = r.ri.getDisplayNameForElementID!;

      commit(hook, r, 1, { mount: [[20, "BeforeStart"]] });
      expect(accessor).not.toHaveBeenCalled();
      expect(bucketOf(r.ri)).toBeUndefined();

      start();
      stop();
      accessor.mockClear();
      commit(hook, r, 1, { mount: [[21, "AfterStop"]] });

      expect(accessor).not.toHaveBeenCalled();
      expect(bucketOf(r.ri)?.[21]).toBeUndefined();
      expect(r.ri.__argent_flushedOperations__).toBeNull();
    });

    it("starts each session with only that session's names", () => {
      const r = makeRenderer(hook, 1, { mounted: [[10, "App"]] });
      install();
      start();
      commit(hook, r, 1, { mount: [[20, "FirstSession"]] });
      commit(hook, r, 1, { unmount: [20] });
      stop();

      start();

      expect(bucketOf(r.ri)?.[20]).toBeUndefined();
      expect(bucketOf(r.ri)?.[idOf(r, "App")]).toBe("App");
    });

    it("keeps the live names when start runs during a recording", () => {
      const r = makeRenderer(hook, 1, { mounted: [[10, "App"]] });
      install();
      start();
      commit(hook, r, 1, { mount: [[20, "Live"]] });
      commit(hook, r, 1, { unmount: [20] });

      start();

      expect(bucketOf(r.ri)?.[20]).toBe("Live");
      // That second flush renumbered the tree, so the new IDs need names too.
      expect(bucketOf(r.ri)?.[idOf(r, "App")]).toBe("App");
      expect(r.ri.__argent_flushedOperations__).toBeNull();
    });

    it("keeps what a flush emitted before it threw, and still starts", () => {
      const r = makeRenderer(hook, 1, { mounted: [[10, "App"]] });
      install();
      r.ri.flushInitialOperations.mockImplementationOnce(() => {
        hook.emit([1, 1, 0, OP_ADD, 10, 5, 0, 0, 1, 0]);
        throw new Error("flush broke");
      });

      start();

      expect(r.ri.__argent_isProfiling__).toBe(true);
      expect(r.ri.__argent_flushedOperations__).toBeNull();
      expect(bucketOf(r.ri)?.[10]).toBe("App");
    });

    it("does not collect names for a start that fails", () => {
      const r = makeRenderer(hook, 1, { mounted: [[10, "App"]] });
      r.ri.startProfiling = vi.fn(() => {
        throw new Error("no start");
      });
      install();

      const out = JSON.parse(evalIIFE<string>(buildStartScript(ownerJson))) as { ok: boolean };
      expect(out.ok).toBe(false);
      expect(r.ri.__argent_isProfiling__).toBe(false);
      expect(r.ri.__argent_flushedOperations__).toBeNull();

      const accessor = r.ri.getDisplayNameForElementID!;
      accessor.mockClear();
      commit(hook, r, 1, { mount: [[20, "AfterFailedStart"]] });
      expect(accessor).not.toHaveBeenCalled();
    });
  });
});
