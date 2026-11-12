import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REACT_NATIVE_PROFILER_SETUP_SCRIPT,
  READ_STATE_SCRIPT,
  STOP_AND_READ_SCRIPT,
  STOP_FOR_TAKEOVER_SCRIPT,
  buildStartScript,
} from "../../src/utils/react-profiler/scripts";

/**
 * The injected scripts are self-contained IIFE strings — eval them against a
 * mock `globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__` to verify they iterate
 * every renderer (RN registers Fabric + Paper) and not just the first.
 */

interface BackendCommit {
  timestamp: number;
  duration: number;
  fiberActualDurations: Array<[number, number]>;
  fiberSelfDurations: Array<[number, number]>;
  changeDescriptions: Array<[number, unknown]>;
}

interface MockRi {
  __argent_isProfiling__: boolean;
  __argent_startedAtEpochMs__: number | null;
  flushInitialOperations: ReturnType<typeof vi.fn>;
  startProfiling: ReturnType<typeof vi.fn>;
  stopProfiling: ReturnType<typeof vi.fn>;
  getProfilingData: ReturnType<typeof vi.fn>;
  // A real rendererInterface has one or the other depending on
  // react-devtools-core version: `Element` in modern, `Fiber` in older bundles.
  getDisplayNameForElementID?: ReturnType<typeof vi.fn>;
  getDisplayNameForFiberID?: ReturnType<typeof vi.fn>;
}

function makeRi(
  opts: {
    willThrowOnStart?: boolean;
    startsButLeavesFlagFalse?: boolean;
    rootID?: number;
    commits?: BackendCommit[];
    names?: Record<number, string>;
    // Mocked devtools vintage: 'element' modern, 'fiber' RN ≤0.75-ish,
    // 'none' unrecognized.
    nameApi?: "element" | "fiber" | "both" | "none";
  } = {}
): MockRi {
  const ri = {
    __argent_isProfiling__: false,
    __argent_startedAtEpochMs__: null,
  } as unknown as MockRi;
  ri.flushInitialOperations = vi.fn();
  ri.startProfiling = vi.fn(() => {
    if (opts.willThrowOnStart) throw new Error("boom");
    if (!opts.startsButLeavesFlagFalse) {
      ri.__argent_isProfiling__ = true;
      ri.__argent_startedAtEpochMs__ = 1_700_000_000_000;
    }
  });
  ri.stopProfiling = vi.fn(() => {
    ri.__argent_isProfiling__ = false;
  });
  ri.getProfilingData = vi.fn(() => ({
    dataForRoots: opts.commits ? [{ rootID: opts.rootID ?? 1, commitData: opts.commits }] : [],
  }));
  const lookup = (id: number) => (opts.names && opts.names[id] != null ? opts.names[id] : null);
  const api = opts.nameApi ?? "element";
  if (api === "element" || api === "both") {
    ri.getDisplayNameForElementID = vi.fn(lookup);
  }
  if (api === "fiber" || api === "both") {
    ri.getDisplayNameForFiberID = vi.fn(lookup);
  }
  return ri;
}

function evalIIFE<T = unknown>(script: string): T {
  // Indirect eval runs the IIFE in global scope, where the hook mock lives.
  return (0, eval)(script) as T;
}

function withHook<T>(rendererInterfaces: Map<unknown, unknown>, body: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const originalHook = g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const originalCache = g.__argent_fiberNames__;
  const originalOwner = g.__ARGENT_PROFILER_OWNER__;
  g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { rendererInterfaces };
  g.__argent_fiberNames__ = new WeakMap();
  g.__ARGENT_PROFILER_OWNER__ = null;
  try {
    return body();
  } finally {
    g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = originalHook;
    g.__argent_fiberNames__ = originalCache;
    g.__ARGENT_PROFILER_OWNER__ = originalOwner;
  }
}

const ownerJson = JSON.stringify({
  sessionId: "sess-test",
  startedAtEpochMs: 0,
  lastHeartbeatEpochMs: 0,
});

interface StartResult {
  ok: boolean;
  reason?: string;
  message?: string;
  startedAtEpochMs?: number;
  isProfilingFlagSet?: boolean;
  ownerInstalled?: boolean;
}

interface StopReadResult {
  live: { dataForRoots: Array<{ rootID: number; commitData: BackendCommit[] }> } | null;
  displayNameById: Record<string, string | null>;
  displayNameApiAvailable?: boolean;
}

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  delete g.__ARGENT_PROFILER_OWNER__;
});

describe("buildStartScript (multi-renderer)", () => {
  it("starts profiling on every registered renderer", () => {
    const fabric = makeRi();
    const paper = makeRi();
    const ris = new Map<number, MockRi>([
      [1, fabric],
      [2, paper],
    ]);
    const out = withHook(ris, () => evalIIFE<string>(buildStartScript(ownerJson)));
    const r = JSON.parse(out) as StartResult;

    expect(fabric.startProfiling).toHaveBeenCalledTimes(1);
    expect(paper.startProfiling).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
    expect(r.isProfilingFlagSet).toBe(true);
    expect(r.ownerInstalled).toBe(true);
  });

  it("starts the active renderer even when the dormant ri is iterated first", () => {
    const dormant = makeRi();
    const active = makeRi();
    const ris = new Map<number, MockRi>([
      [99, dormant],
      [1, active],
    ]);
    const out = withHook(ris, () => evalIIFE<string>(buildStartScript(ownerJson)));
    const r = JSON.parse(out) as StartResult;

    expect(dormant.startProfiling).toHaveBeenCalledTimes(1);
    expect(active.startProfiling).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
    expect(r.isProfilingFlagSet).toBe(true);
  });

  it("succeeds when one ri throws and the other starts", () => {
    const broken = makeRi({ willThrowOnStart: true });
    const ok = makeRi();
    const ris = new Map<number, MockRi>([
      [1, broken],
      [2, ok],
    ]);
    const out = withHook(ris, () => evalIIFE<string>(buildStartScript(ownerJson)));
    const r = JSON.parse(out) as StartResult;

    expect(r.ok).toBe(true);
    expect(r.isProfilingFlagSet).toBe(true);
    expect(broken.startProfiling).toHaveBeenCalledTimes(1);
    expect(ok.__argent_isProfiling__).toBe(true);
  });

  it("treats a renderer that flips its own __argent_isProfiling__ flag as success", () => {
    // ok needs `__argent_isProfiling__ === true` on some ri, not merely that
    // no call threw.
    const broken = makeRi({ willThrowOnStart: true });
    const dormant = makeRi(); // its mock startProfiling flips the flag
    const ris = new Map<number, MockRi>([
      [1, broken],
      [99, dormant],
    ]);
    const out = withHook(ris, () => evalIIFE<string>(buildStartScript(ownerJson)));
    const r = JSON.parse(out) as StartResult;

    expect(r.ok).toBe(true);
    expect(r.isProfilingFlagSet).toBe(true);
  });

  it("reports ok=false with the first error when every ri throws", () => {
    const a = makeRi({ willThrowOnStart: true });
    const b = makeRi({ willThrowOnStart: true });
    const ris = new Map<number, MockRi>([
      [1, a],
      [2, b],
    ]);
    const out = withHook(ris, () => evalIIFE<string>(buildStartScript(ownerJson)));
    const r = JSON.parse(out) as StartResult;

    expect(r.ok).toBe(false);
    expect(r.reason).toBe("startProfiling-threw");
    expect(r.message).toBe("boom");
  });

  it("reports ok=false when no renderers are registered", () => {
    const ris = new Map();
    const out = withHook(ris, () => evalIIFE<string>(buildStartScript(ownerJson)));
    const r = JSON.parse(out) as StartResult;
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no-renderer-interface");
  });

  it("smoke: single-renderer (DOM topology) still works", () => {
    const dom = makeRi();
    const ris = new Map<number, MockRi>([[1, dom]]);
    const out = withHook(ris, () => evalIIFE<string>(buildStartScript(ownerJson)));
    const r = JSON.parse(out) as StartResult;
    expect(r.ok).toBe(true);
    expect(r.isProfilingFlagSet).toBe(true);
    expect(dom.startProfiling).toHaveBeenCalledTimes(1);
  });
});

describe("STOP_AND_READ_SCRIPT (multi-renderer)", () => {
  function commit(fiberID: number): BackendCommit {
    return {
      timestamp: 0,
      duration: 1,
      fiberActualDurations: [[fiberID, 1]],
      fiberSelfDurations: [[fiberID, 1]],
      changeDescriptions: [],
    };
  }

  it("merges dataForRoots from every renderer", () => {
    const fabric = makeRi({
      rootID: 10,
      commits: [commit(42)],
      names: { 42: "FabricNode" },
    });
    const paper = makeRi({
      rootID: 20,
      commits: [commit(99)],
      names: { 99: "PaperNode" },
    });
    const ris = new Map<number, MockRi>([
      [1, fabric],
      [2, paper],
    ]);
    const out = withHook(ris, () => evalIIFE<string>(STOP_AND_READ_SCRIPT));
    const r = JSON.parse(out) as StopReadResult;

    expect(r.live).not.toBeNull();
    expect(r.live!.dataForRoots).toHaveLength(2);
    expect(r.live!.dataForRoots.map((root) => root.rootID).sort()).toEqual([10, 20]);
    expect(fabric.stopProfiling).toHaveBeenCalledTimes(1);
    expect(paper.stopProfiling).toHaveBeenCalledTimes(1);
  });

  it("resolves names from every renderer into the merged displayNameById map", () => {
    // Bare-fiberID keys only collide if two renderers emit commits; RN's
    // dormant Paper does not.
    const fabric = makeRi({
      rootID: 10,
      commits: [commit(42)],
      names: { 42: "FabricNode" },
    });
    const paper = makeRi({
      rootID: 20,
      commits: [commit(99)],
      names: { 99: "PaperNode" },
    });
    const ris = new Map<number, MockRi>([
      [1, fabric],
      [2, paper],
    ]);
    const out = withHook(ris, () => evalIIFE<string>(STOP_AND_READ_SCRIPT));
    const r = JSON.parse(out) as StopReadResult;

    expect(r.displayNameById["42"]).toBe("FabricNode");
    expect(r.displayNameById["99"]).toBe("PaperNode");
  });

  it("falls back to the per-renderer cache when the live accessor returns null", () => {
    const fabric = makeRi({ rootID: 10, commits: [commit(42)] }); // returns null for 42
    const ris = new Map<number, MockRi>([[1, fabric]]);
    const out = withHook(ris, () => {
      const cache = (globalThis as Record<string, unknown>).__argent_fiberNames__ as WeakMap<
        MockRi,
        Record<number, string>
      >;
      const bucket: Record<number, string> = Object.create(null);
      bucket[42] = "CachedTooltip";
      cache.set(fabric, bucket);
      return evalIIFE<string>(STOP_AND_READ_SCRIPT);
    });
    const r = JSON.parse(out) as StopReadResult;

    expect(r.displayNameById["42"]).toBe("CachedTooltip");
  });

  it("returns empty payload when no renderers are registered", () => {
    const ris = new Map();
    const out = withHook(ris, () => evalIIFE<string>(STOP_AND_READ_SCRIPT));
    const r = JSON.parse(out) as StopReadResult;
    expect(r.live).toBeNull();
    expect(r.displayNameById).toEqual({});
  });

  it("resolves names via getDisplayNameForFiberID when ElementID is absent (old react-devtools)", () => {
    const ri = makeRi({
      rootID: 10,
      commits: [commit(42)],
      names: { 42: "FromFiberID" },
      nameApi: "fiber",
    });
    const ris = new Map<number, MockRi>([[1, ri]]);
    const out = withHook(ris, () => {
      // Setup wrapper stashes __argent_getDisplayName__ once per ri.
      evalIIFE(REACT_NATIVE_PROFILER_SETUP_SCRIPT);
      return evalIIFE<string>(STOP_AND_READ_SCRIPT);
    });
    const r = JSON.parse(out) as StopReadResult;

    expect(r.displayNameById["42"]).toBe("FromFiberID");
    expect(r.displayNameApiAvailable).toBe(true);
    expect(ri.getDisplayNameForFiberID).toHaveBeenCalled();
  });

  it("also works when ElementID is present (modern react-devtools)", () => {
    const ri = makeRi({
      rootID: 10,
      commits: [commit(42)],
      names: { 42: "FromElementID" },
      nameApi: "element",
    });
    const ris = new Map<number, MockRi>([[1, ri]]);
    const out = withHook(ris, () => {
      evalIIFE(REACT_NATIVE_PROFILER_SETUP_SCRIPT);
      return evalIIFE<string>(STOP_AND_READ_SCRIPT);
    });
    const r = JSON.parse(out) as StopReadResult;

    expect(r.displayNameById["42"]).toBe("FromElementID");
    expect(r.displayNameApiAvailable).toBe(true);
    expect(ri.getDisplayNameForElementID).toHaveBeenCalled();
  });

  it("prefers ElementID when both names exist (modern-name precedence)", () => {
    const ri = makeRi({
      rootID: 10,
      commits: [commit(42)],
      names: { 42: "Shared" },
      nameApi: "both",
    });
    const ris = new Map<number, MockRi>([[1, ri]]);
    withHook(ris, () => {
      evalIIFE(REACT_NATIVE_PROFILER_SETUP_SCRIPT);
      return evalIIFE<string>(STOP_AND_READ_SCRIPT);
    });
    expect(ri.getDisplayNameForElementID).toHaveBeenCalled();
    expect(ri.getDisplayNameForFiberID).not.toHaveBeenCalled();
  });

  it("flags displayNameApiAvailable=false when no accessor exists on any ri", () => {
    // Lets the stop tool's unattributed report blame the missing accessor
    // instead of a transient-unmount race.
    const ri = makeRi({ rootID: 10, commits: [commit(42)], nameApi: "none" });
    const ris = new Map<number, MockRi>([[1, ri]]);
    const out = withHook(ris, () => evalIIFE<string>(STOP_AND_READ_SCRIPT));
    const r = JSON.parse(out) as StopReadResult;

    expect(r.displayNameApiAvailable).toBe(false);
    expect(r.displayNameById["42"]).toBeNull();
  });
});

describe("STOP_FOR_TAKEOVER_SCRIPT (multi-renderer)", () => {
  it("calls stopProfiling on every renderer, even if one throws", () => {
    const a = makeRi();
    a.__argent_isProfiling__ = true;
    const b = makeRi();
    b.__argent_isProfiling__ = true;
    a.stopProfiling = vi.fn(() => {
      a.__argent_isProfiling__ = false;
      throw new Error("ignored");
    });
    const ris = new Map<number, MockRi>([
      [1, a],
      [2, b],
    ]);
    const out = withHook(ris, () => evalIIFE<string>(STOP_FOR_TAKEOVER_SCRIPT));
    expect(out).toBe("ok");
    expect(a.stopProfiling).toHaveBeenCalledTimes(1);
    expect(b.stopProfiling).toHaveBeenCalledTimes(1);
  });
});

describe("READ_STATE_SCRIPT (multi-renderer)", () => {
  it("reports isRunning: true when any renderer is profiling, even if the first iterated one is not", () => {
    const dormant = makeRi(); // never started
    const active = makeRi();
    active.__argent_isProfiling__ = true;
    const ris = new Map<number, MockRi>([
      [99, dormant],
      [1, active],
    ]);
    const out = withHook(ris, () => evalIIFE<string>(READ_STATE_SCRIPT));
    const r = JSON.parse(out) as { isRunning: boolean };
    expect(r.isRunning).toBe(true);
  });

  it("reports isRunning: false when no renderers are profiling", () => {
    const a = makeRi();
    const b = makeRi();
    const ris = new Map<number, MockRi>([
      [1, a],
      [2, b],
    ]);
    const out = withHook(ris, () => evalIIFE<string>(READ_STATE_SCRIPT));
    const r = JSON.parse(out) as { isRunning: boolean };
    expect(r.isRunning).toBe(false);
  });
});

describe("REACT_NATIVE_PROFILER_SETUP_SCRIPT (per-renderer cache isolation)", () => {
  it("clearing one renderer's cache bucket does not affect another's", () => {
    // The wrapper does `cache.set(ri, Object.create(null))` on start; a flat
    // cache shared across renderers would let ri#2's start wipe ri#1's entries.
    const a = makeRi();
    const b = makeRi();
    const ris = new Map<number, MockRi>([
      [1, a],
      [2, b],
    ]);
    withHook(ris, () => {
      // Setup installs the wrapper that b.startProfiling exercises below.
      evalIIFE(REACT_NATIVE_PROFILER_SETUP_SCRIPT);
      const cache = (globalThis as Record<string, unknown>).__argent_fiberNames__ as WeakMap<
        MockRi,
        Record<number, string>
      >;

      // Pre-populate a's bucket as FIBER_ROOT_TRACKER_SCRIPT would.
      const aBucket: Record<number, string> = Object.create(null);
      aBucket[7] = "FromA";
      cache.set(a, aBucket);

      (b.startProfiling as () => void)();
      expect(cache.get(a)?.[7]).toBe("FromA");
      expect(cache.get(b)).toBeDefined();
      expect(Object.keys(cache.get(b)!)).toHaveLength(0);
    });
  });
});
