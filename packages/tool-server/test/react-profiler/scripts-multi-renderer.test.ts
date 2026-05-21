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
 *
 * These tests are the regression harness for
 * `profiler-react19-multi-renderer-bug.md`.
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
  getDisplayNameForElementID: ReturnType<typeof vi.fn>;
}

function makeRi(
  opts: {
    willThrowOnStart?: boolean;
    startsButLeavesFlagFalse?: boolean;
    rootID?: number;
    commits?: BackendCommit[];
    names?: Record<number, string>;
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
  ri.getDisplayNameForElementID = vi.fn((id: number) =>
    opts.names && opts.names[id] != null ? opts.names[id] : null
  );
  return ri;
}

function evalIIFE<T = unknown>(script: string): T {
  // Use indirect eval to run the IIFE in a fresh-ish scope while preserving
  // access to globalThis (which holds the hook mock the script reads).
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
}

afterEach(() => {
  // Defensive — withHook restores its own state, but if a test throws between
  // setting and restoring we want the next test to start clean.
  const g = globalThis as Record<string, unknown>;
  delete g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  delete g.__ARGENT_PROFILER_OWNER__;
});

// ── buildStartScript ──────────────────────────────────────────────────

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
    // Reverse insertion order: dormant Paper first, active Fabric second.
    // Pre-fix code took the first ri from forEach and never touched the
    // active renderer — bug doc §3 reproduction.
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
    // Boundary case: every active-root ri throws, only a dormant one
    // succeeds. ok requires `__argent_isProfiling__ === true` on at least
    // one ri, so as long as the dormant one's flag flipped we report ok.
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

// ── STOP_AND_READ_SCRIPT ──────────────────────────────────────────────

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
    // Distinct fiber IDs (RN's dormant Paper doesn't actually emit commits in
    // practice, so collisions don't occur). Both names should appear in the
    // merged map.
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

  it("falls back to the per-renderer cache when getDisplayNameForElementID returns null", () => {
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
});

// ── STOP_FOR_TAKEOVER_SCRIPT ──────────────────────────────────────────

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

// ── READ_STATE_SCRIPT ────────────────────────────────────────────────

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

// ── REACT_NATIVE_PROFILER_SETUP_SCRIPT (cache isolation) ───────────────

describe("REACT_NATIVE_PROFILER_SETUP_SCRIPT (per-renderer cache isolation)", () => {
  it("clearing one renderer's cache bucket does not affect another's", () => {
    // Direct check on the WeakMap semantics that the wrapper relies on.
    // The actual wrapper invokes `cache.set(ri, Object.create(null))` on
    // start; if the cache were a flat object we shared across renderers,
    // ri#2's start would wipe ri#1's entries.
    const a = makeRi();
    const b = makeRi();
    const ris = new Map<number, MockRi>([
      [1, a],
      [2, b],
    ]);
    withHook(ris, () => {
      // Run setup so the wrapper is installed and the cache is the new WeakMap.
      evalIIFE(REACT_NATIVE_PROFILER_SETUP_SCRIPT);
      const cache = (globalThis as Record<string, unknown>).__argent_fiberNames__ as WeakMap<
        MockRi,
        Record<number, string>
      >;

      // Pre-populate ri#a's bucket as if a prior FIBER_ROOT_TRACKER capture happened.
      const aBucket: Record<number, string> = Object.create(null);
      aBucket[7] = "FromA";
      cache.set(a, aBucket);

      // Start on ri#b — wrapper should reset only b's bucket, leaving a's intact.
      (b.startProfiling as () => void)();
      expect(cache.get(a)?.[7]).toBe("FromA");
      expect(cache.get(b)).toBeDefined();
      expect(Object.keys(cache.get(b)!)).toHaveLength(0);
    });
  });
});
