/**
 * JS scripts injected via Runtime.evaluate into the Hermes runtime for React
 * profiling. Grouped by use-case: instrumentation setup, session lifecycle,
 * and data collection.
 */

// #region Instrumentation Setup

/**
 * One-time setup script injected at the start of every profiling session.
 * Monkey-patches each `rendererInterface` to track `isProfiling` state,
 * capture `startedAtEpochMs`, and expose a heartbeat helper used to keep the
 * session owner record fresh.
 *
 * Idempotent — guarded by `ri.__argent_startWrapped__` so re-injecting across
 * tool invocations does not produce cascading wrappers.
 *
 * Multi-renderer note: React Native registers two `react-native-renderer`
 * interfaces (Fabric + dormant Paper) in `hook.rendererInterfaces`. The
 * fiber-name cache is keyed by `ri` identity via a `WeakMap` so each renderer
 * has its own bucket — preventing one renderer's wrapper from clearing
 * another's cache during multi-renderer start.
 */
export const REACT_NATIVE_PROFILER_SETUP_SCRIPT = `
(function __argent_nativeProfilerInit() {
  var h = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!h) return;

  // Heartbeat helper — safe to call from any tool entry. No-op if no owner.
  if (typeof globalThis.__argent_profilerHeartbeat !== 'function') {
    globalThis.__argent_profilerHeartbeat = function () {
      var o = globalThis.__ARGENT_PROFILER_OWNER__;
      if (o && typeof o === 'object') {
        o.lastHeartbeatEpochMs = Date.now();
      }
    };
  }

  // WeakMap<ri, {[fiberID]: displayName}> — per-renderer fiber-name cache.
  // Replaces the prior flat object cache so multi-renderer starts don't
  // clobber each other's entries.
  if (!globalThis.__argent_fiberNames__ ||
      typeof globalThis.__argent_fiberNames__.get !== 'function') {
    globalThis.__argent_fiberNames__ = new WeakMap();
  }

  if (!h.rendererInterfaces || typeof h.rendererInterfaces.forEach !== 'function') return;

  h.rendererInterfaces.forEach(function (ri) {
    if (!ri || ri.__argent_startWrapped__) return;
    ri.__argent_startWrapped__ = true;
    if (typeof ri.__argent_isProfiling__ !== 'boolean') {
      ri.__argent_isProfiling__ = false;
    }
    var origStart = ri.startProfiling;
    var origStop = ri.stopProfiling;

    ri.startProfiling = function __argent_startProfiling() {
      // Silent no-op when already recording — matches native semantics and
      // preserves the live buffer against accidental re-entry.
      if (ri.__argent_isProfiling__ === true) return;

      var startedAtEpochMs = Date.now();
      ri.__argent_startedAtEpochMs__ = startedAtEpochMs;
      // Reset the commit-time fiber-name cache BEFORE flipping the
      // isProfiling flag so the tracker only populates it with fibers seen
      // during this session. Per-renderer bucket: clearing this ri's bucket
      // does not affect other renderers' caches. Clearing here rather than in
      // stopProfiling is load-bearing: STOP_AND_READ_SCRIPT calls
      // ri.stopProfiling() itself before consulting the cache, so clearing on
      // stop would wipe the cache out from under the reader on every session.
      globalThis.__argent_fiberNames__.set(ri, Object.create(null));
      ri.__argent_isProfiling__ = true;
      try {
        return origStart.apply(this, arguments);
      } catch (err) {
        ri.__argent_isProfiling__ = false;
        ri.__argent_startedAtEpochMs__ = null;
        throw err;
      }
    };

    ri.stopProfiling = function __argent_stopProfiling() {
      try {
        return origStop.apply(this, arguments);
      } finally {
        ri.__argent_isProfiling__ = false;
        globalThis.__ARGENT_PROFILER_OWNER__ = null;
        // NOTE: we intentionally do NOT clear this ri's name-cache bucket here.
        // STOP_AND_READ_SCRIPT calls ri.stopProfiling() and then reads the
        // cache to resolve unmounted-fiber names. Clearing here would race
        // that read and break the fallback for every transient component.
        // The cache is cleared at the top of the next startProfiling wrapper.
      }
    };
  });
})();
`;

// #endregion

// #region Session Lifecycle

/**
 * Bumps `lastHeartbeatEpochMs` on the current session owner so it is not
 * classified as stale by concurrent tool-server instances. Safe to evaluate
 * before `REACT_NATIVE_PROFILER_SETUP_SCRIPT` has run.
 */
export const HEARTBEAT_SCRIPT = `
(function(){
  if (typeof globalThis.__argent_profilerHeartbeat === 'function') {
    try { globalThis.__argent_profilerHeartbeat(); } catch (_e) {}
  }
})()
`;

/**
 * Reads the current profiling state without side-effects. Returns a JSON
 * string with `hookExists`, `rendererInterfaceFound`, `isRunning`, `owner`,
 * and `nowEpochMs` so the caller can decide whether to start, take over, or
 * refuse a new session.
 *
 * `isRunning` reflects "any renderer is profiling" — with multiple renderers
 * registered (RN Fabric + dormant Paper) the operator-relevant question is
 * whether profiling is in progress anywhere, not whether the first iterated
 * renderer is profiling.
 */
export const READ_STATE_SCRIPT = `
(function __argent_readState() {
  var h = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!h) return JSON.stringify({ hookExists: false });
  var rendererInterfaceFound = false;
  var isRunning = false;
  if (h.rendererInterfaces && typeof h.rendererInterfaces.forEach === 'function') {
    h.rendererInterfaces.forEach(function (ri) {
      rendererInterfaceFound = true;
      if (ri && ri.__argent_isProfiling__ === true) isRunning = true;
    });
  }
  if (!rendererInterfaceFound) {
    return JSON.stringify({ hookExists: true, rendererInterfaceFound: false });
  }

  return JSON.stringify({
    hookExists: true,
    rendererInterfaceFound: true,
    isRunning: isRunning,
    owner: globalThis.__ARGENT_PROFILER_OWNER__ || null,
    nowEpochMs: Date.now(),
  });
})()
`;

/**
 * Calls `ri.startProfiling` on EVERY registered renderer interface, writes the
 * provided owner JSON into `__ARGENT_PROFILER_OWNER__`, and records
 * `startedAtEpochMs` from the wrapper-captured wall-clock value to eliminate
 * clock skew. Returns a JSON result with `ok`, post-start verification flags,
 * and the resolved timestamp.
 *
 * Multi-renderer rationale: React Native registers two
 * `react-native-renderer` interfaces (Fabric + dormant Paper). Picking only
 * the first via `forEach` silently profiles the wrong one when `Map`
 * insertion order puts the dormant renderer first — see
 * `profiler-react19-multi-renderer-bug.md`. `ok: true` requires at least one
 * renderer to actually be profiling (`__argent_isProfiling__ === true`), not
 * just that any `forEach` body ran without throwing — otherwise we'd report
 * success when every active-root renderer threw and only a dormant one
 * accepted the call without ever capturing commits.
 */
export function buildStartScript(ownerJson: string): string {
  return `
(function __argent_doStart() {
  var h = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!h || !h.rendererInterfaces) return JSON.stringify({ ok: false, reason: 'no-hook' });

  var sawAny = false;
  var anyStarted = false;
  var firstError = null;
  var startedAtEpochMs = null;
  h.rendererInterfaces.forEach(function (ri) {
    sawAny = true;
    try { ri.flushInitialOperations(); } catch (_e) {}
    try {
      ri.startProfiling(true);
      // The wrapper in REACT_NATIVE_PROFILER_SETUP_SCRIPT flips this flag.
      // A renderer can return without throwing yet leave the flag false
      // (e.g. the wrapper short-circuited because a prior session was still
      // active). Only flag=true counts as a real start.
      if (ri.__argent_isProfiling__ === true) {
        anyStarted = true;
        if (startedAtEpochMs == null && typeof ri.__argent_startedAtEpochMs__ === 'number') {
          startedAtEpochMs = ri.__argent_startedAtEpochMs__;
        }
      }
    } catch (err) {
      // Preserve the first error verbatim — if every renderer ends up
      // throwing, this is the only diagnostic the operator gets.
      if (firstError == null) firstError = String((err && err.message) || err);
    }
  });

  if (!sawAny) return JSON.stringify({ ok: false, reason: 'no-renderer-interface' });
  if (!anyStarted) {
    return JSON.stringify({ ok: false, reason: 'startProfiling-threw', message: firstError });
  }

  var owner = ${ownerJson};
  owner.startedAtEpochMs = startedAtEpochMs != null ? startedAtEpochMs : Date.now();
  owner.lastHeartbeatEpochMs = owner.startedAtEpochMs;
  globalThis.__ARGENT_PROFILER_OWNER__ = owner;

  return JSON.stringify({
    ok: true,
    startedAtEpochMs: owner.startedAtEpochMs,
    isProfilingFlagSet: anyStarted,
    ownerInstalled: !!globalThis.__ARGENT_PROFILER_OWNER__,
  });
})()
`;
}

/**
 * Stops the active profiling session on EVERY registered renderer and clears
 * the owner record so a new session can take over cleanly. Used on the
 * takeover path in `react-profiler-start`.
 */
export const STOP_FOR_TAKEOVER_SCRIPT = `
(function __argent_stopForTakeover() {
  var h = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!h || !h.rendererInterfaces) return 'no-hook';
  var sawRi = false;
  h.rendererInterfaces.forEach(function (ri) {
    sawRi = true;
    try { ri.stopProfiling(); } catch (_e) {}
  });
  if (!sawRi) return 'no-ri';
  // stop wrapper clears __ARGENT_PROFILER_OWNER__; belt-and-braces:
  globalThis.__ARGENT_PROFILER_OWNER__ = null;
  return 'ok';
})()
`;

// #endregion

// #region Data Collection

/**
 * Injected once on connect — tracks fiber root commits for get_react_renders
 * and get_fiber_tree. Idempotent (guard via __argent_profiler_installed__).
 *
 * Also populates a per-renderer commit-time fiberID → displayName cache via
 * `globalThis.__argent_fiberNames__` (a `WeakMap<ri, {[fiberID]: name}>`).
 * This is the only reliable way to recover names for transient components
 * (modals, popovers, navigation screens) that unmount between the profiled
 * interaction and `STOP_AND_READ_SCRIPT`: once a fiber is unmounted the
 * DevTools backend drops it from `idToDevToolsInstanceMap`, so
 * `getDisplayNameForElementID` returns null at stop time. Reading the name
 * right after React's own `handleCommitFiberRoot` runs (synchronous inside
 * `orig.call`) guarantees the fiber is still present. Fiber IDs are
 * monotonically increasing and never reused within a renderer; keying the
 * cache by `ri` identity isolates each renderer's IDs from collisions across
 * the multi-renderer (Fabric + Paper) topology.
 */
export const FIBER_ROOT_TRACKER_SCRIPT = `
(function() {
  var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook || hook.__argent_profiler_installed__) return;
  hook.__argent_profiler_installed__ = true;
  hook.__argent_roots__ = new Set();

  if (!globalThis.__argent_fiberNames__ ||
      typeof globalThis.__argent_fiberNames__.get !== 'function') {
    globalThis.__argent_fiberNames__ = new WeakMap();
  }

  var orig = hook.onCommitFiberRoot;
  hook.onCommitFiberRoot = function __argent_fiberRootTracker(rendererID, root, priorityLevel) {
    hook.__argent_roots__.add(root);
    if (typeof orig === 'function') orig.call(this, rendererID, root, priorityLevel);

    // Populate fiberID → displayName cache for every fiber that rendered in
    // this commit. Must run AFTER orig.call() — the DevTools backend writes
    // commitData synchronously inside handleCommitFiberRoot, so by the time
    // control returns here getProfilingData() already reflects this commit.
    try {
      var ri = hook.rendererInterfaces && hook.rendererInterfaces.get(rendererID);
      if (!ri || ri.__argent_isProfiling__ !== true) return;

      var pd = ri.getProfilingData ? ri.getProfilingData() : null;
      if (!pd || !pd.dataForRoots) return;

      var cacheRoot = globalThis.__argent_fiberNames__;
      var bucket = cacheRoot.get(ri);
      if (!bucket) {
        bucket = Object.create(null);
        cacheRoot.set(ri, bucket);
      }
      for (var r = 0; r < pd.dataForRoots.length; r++) {
        var commitData = pd.dataForRoots[r].commitData;
        if (!commitData || commitData.length === 0) continue;
        var latest = commitData[commitData.length - 1];
        var fa = latest.fiberActualDurations || [];
        for (var k = 0; k < fa.length; k++) {
          var entry = fa[k];
          if (!entry) continue;
          var fiberID = entry[0];
          if (bucket[fiberID] !== undefined) continue;
          try {
            var name = ri.getDisplayNameForElementID(fiberID);
            if (typeof name === 'string' && name.length > 0) {
              bucket[fiberID] = name;
            }
          } catch (_e) {}
        }
      }
    } catch (_e) {
      // Swallow — a bug in the cache path must never disrupt React rendering.
    }
  };
})();
`;

/**
 * Stops the backend profiler on EVERY registered renderer, then collects the
 * live `getProfilingData()` buffer from each and merges them into a single
 * `dataForRoots` array. Iterating every renderer is load-bearing — the active
 * renderer is not necessarily the first in `Map` insertion order on RN
 * (Fabric + dormant Paper).
 *
 * Display names are keyed by bare `fiberID`. RN's dormant Paper renderer
 * doesn't emit commits, so its fiber-ID space never overlaps with Fabric's
 * in practice. If a future topology adds a second active renderer with
 * colliding IDs, names from the renderer iterated first win — we'd add a
 * composite key at that point, with a real failure to point at.
 *
 * Returns `{ live, displayNameById }` as a JSON string.
 */
export const STOP_AND_READ_SCRIPT = `
(function __argent_stopAndRead() {
  if (typeof globalThis.__argent_profilerHeartbeat === 'function') {
    try { globalThis.__argent_profilerHeartbeat(); } catch (_e) {}
  }

  var h = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!h || !h.rendererInterfaces) {
    return JSON.stringify({ live: null, displayNameById: {} });
  }

  var nameCache = globalThis.__argent_fiberNames__ || null;
  var allRoots = [];
  var displayNameById = {};
  var anySaw = false;

  function resolveName(ri, id, out, bucket) {
    if (out[id] !== undefined) return;
    try {
      var n = ri.getDisplayNameForElementID(Number(id));
      if (typeof n === 'string' && n.length > 0) { out[id] = n; return; }
    } catch (_e) {}
    // Live resolution failed — fiber was likely unmounted before stop
    // (transient component). Fall back to the per-ri commit-time cache.
    var cached = bucket ? bucket[id] : undefined;
    out[id] = (typeof cached === 'string' && cached.length > 0) ? cached : null;
  }

  h.rendererInterfaces.forEach(function (ri) {
    anySaw = true;
    try { ri.stopProfiling(); } catch (_e) {}
    var pd = null;
    try { pd = ri.getProfilingData(); } catch (_e) { /* pristine — treat as empty */ }
    if (!pd || !pd.dataForRoots) return;

    var bucket = (nameCache && typeof nameCache.get === 'function')
      ? (nameCache.get(ri) || null)
      : null;

    for (var i = 0; i < pd.dataForRoots.length; i++) {
      var root = pd.dataForRoots[i];
      allRoots.push(root);

      var cd = root.commitData || [];
      for (var j = 0; j < cd.length; j++) {
        var fa = cd[j].fiberActualDurations || [];
        for (var k = 0; k < fa.length; k++) if (fa[k]) {
          resolveName(ri, fa[k][0], displayNameById, bucket);
        }
        var cds = cd[j].changeDescriptions || [];
        for (var k2 = 0; k2 < cds.length; k2++) if (cds[k2]) {
          resolveName(ri, cds[k2][0], displayNameById, bucket);
        }
      }
    }
  });

  if (!anySaw) {
    return JSON.stringify({ live: null, displayNameById: {} });
  }
  return JSON.stringify({ live: { dataForRoots: allRoots }, displayNameById: displayNameById });
})()
`;

/**
 * Walks the live fiber tree from all known roots and collects per-component
 * metadata — `hookTypes`, `isCompilerOptimized`, and `parentName` — keyed
 * by display name. Used to enrich commit data after `STOP_AND_READ_SCRIPT`
 * without requiring a second CDP round-trip during the stop flow.
 */
export const RESOLVE_FIBER_META_SCRIPT = `
(function __argent_resolveFiberMeta() {
  var h = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!h) return JSON.stringify({});
  var roots = h.__argent_roots__ || h._fiberRoots || h.fiberRoots;
  if (!roots) return JSON.stringify({});

  function getName(fiber) {
    if (!fiber || !fiber.type) return null;
    if (typeof fiber.type === 'string') return null;
    return fiber.type.displayName || fiber.type.name || null;
  }

  function getParentName(fiber) {
    var r = fiber.return;
    while (r) {
      var pn = getName(r);
      if (pn) return pn;
      r = r.return;
    }
    return null;
  }

  var out = {};
  function walk(fiber) {
    if (!fiber) return;
    try {
      var name = getName(fiber);
      if (name && !(name in out)) {
        var hookTypes = (fiber._debugHookTypes && fiber._debugHookTypes.length > 0) ? fiber._debugHookTypes : null;
        var isCompilerOptimized = false;
        try {
          if (fiber.updateQueue && fiber.updateQueue.memoCache != null) isCompilerOptimized = true;
          if (!isCompilerOptimized && fiber.alternate && fiber.alternate.updateQueue && fiber.alternate.updateQueue.memoCache != null) isCompilerOptimized = true;
        } catch (_e) {}
        if (!isCompilerOptimized && fiber._debugHookTypes) {
          for (var i = 0; i < fiber._debugHookTypes.length; i++) {
            var ht = fiber._debugHookTypes[i];
            if (ht === 'useMemoCache' || ht === 'MemoCache' || ht === 'unstable_useMemoCache') {
              isCompilerOptimized = true;
              break;
            }
          }
        }
        out[name] = {
          hookTypes: hookTypes,
          isCompilerOptimized: isCompilerOptimized,
          parentName: getParentName(fiber)
        };
      }
    } catch (_e) {}
    if (fiber.child) walk(fiber.child);
    if (fiber.sibling) walk(fiber.sibling);
  }

  var iter = roots.values ? roots.values() : Object.values(roots);
  for (var root of iter) {
    if (root && root.current) walk(root.current);
  }
  return JSON.stringify(out);
})()
`;

// #endregion
