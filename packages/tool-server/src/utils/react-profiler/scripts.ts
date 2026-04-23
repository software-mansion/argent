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
      // during this session. Clearing here rather than in stopProfiling is
      // load-bearing: STOP_AND_READ_SCRIPT calls ri.stopProfiling() itself
      // before consulting the cache, so clearing on stop would wipe the
      // cache out from under the reader on every single session.
      globalThis.__argent_fiberNames__ = Object.create(null);
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
        // NOTE: we intentionally do NOT clear __argent_fiberNames__ here.
        // STOP_AND_READ_SCRIPT calls ri.stopProfiling() and then reads the
        // cache to resolve unmounted-fiber names. Clearing here would race
        // that read and break the fallback for every transient component.
        // The cache is cleared at the top of the next startProfiling wrapper.
      }
    };
  });
})();
`;

/**
 * Expression that resolves to the first attached `rendererInterface`, or
 * `null` if none is present. Used where a single eval needs both state and
 * the renderer reference.
 */
export const RENDERER_INTERFACE_EXPR = `(function(){
  var h = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!h || !h.rendererInterfaces) return null;
  var found = null;
  h.rendererInterfaces.forEach(function(ri){ if (!found) found = ri; });
  return found;
})()`;

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
 */
export const READ_STATE_SCRIPT = `
(function __argent_readState() {
  var h = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!h) return JSON.stringify({ hookExists: false });
  var ri = null;
  if (h.rendererInterfaces && typeof h.rendererInterfaces.forEach === 'function') {
    h.rendererInterfaces.forEach(function(r){ if (!ri) ri = r; });
  }
  if (!ri) return JSON.stringify({ hookExists: true, rendererInterfaceFound: false });

  return JSON.stringify({
    hookExists: true,
    rendererInterfaceFound: true,
    isRunning: ri.__argent_isProfiling__ === true,
    owner: globalThis.__ARGENT_PROFILER_OWNER__ || null,
    nowEpochMs: Date.now(),
  });
})()
`;

/**
 * Calls `ri.startProfiling`, writes the provided owner JSON into
 * `__ARGENT_PROFILER_OWNER__`, and records `startedAtEpochMs` from the
 * wrapper-captured wall-clock value to eliminate clock skew. Returns a JSON
 * result with `ok`, post-start verification flags, and the resolved timestamp.
 */
export function buildStartScript(ownerJson: string): string {
  return `
(function __argent_doStart() {
  var h = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!h || !h.rendererInterfaces) return JSON.stringify({ ok: false, reason: 'no-hook' });
  var ri = null;
  h.rendererInterfaces.forEach(function(r){ if (!ri) ri = r; });
  if (!ri) return JSON.stringify({ ok: false, reason: 'no-renderer-interface' });

  try { ri.flushInitialOperations(); } catch (_e) {}
  try {
    ri.startProfiling(true);
  } catch (err) {
    return JSON.stringify({ ok: false, reason: 'startProfiling-threw', message: String(err && err.message || err) });
  }

  var owner = ${ownerJson};
  owner.startedAtEpochMs = (typeof ri.__argent_startedAtEpochMs__ === 'number')
    ? ri.__argent_startedAtEpochMs__
    : Date.now();
  owner.lastHeartbeatEpochMs = owner.startedAtEpochMs;

  globalThis.__ARGENT_PROFILER_OWNER__ = owner;

  return JSON.stringify({
    ok: true,
    startedAtEpochMs: owner.startedAtEpochMs,
    isProfilingFlagSet: ri.__argent_isProfiling__ === true,
    ownerInstalled: !!globalThis.__ARGENT_PROFILER_OWNER__,
  });
})()
`;
}

/**
 * Stops the active profiling session and clears the owner record so a new
 * session can take over cleanly. Used on the takeover path in `react-profiler-start`.
 */
export const STOP_FOR_TAKEOVER_SCRIPT = `
(function __argent_stopForTakeover() {
  var h = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!h || !h.rendererInterfaces) return 'no-hook';
  var ri = null;
  h.rendererInterfaces.forEach(function(r){ if (!ri) ri = r; });
  if (!ri) return 'no-ri';
  try { ri.stopProfiling(); } catch (_e) {}
  // stop wrapper clears __ARGENT_PROFILER_OWNER__; belt-and-braces:
  globalThis.__ARGENT_PROFILER_OWNER__ = null;
  return 'ok';
})()
`;

// #endregion

// #region Data Collection

/**
 * Stops the backend profiler, then collects the live `getProfilingData()`
 * buffer in a single round-trip. Also resolves every referenced fiber ID to a
 * display name via `getDisplayNameForElementID` so the caller does not need a
 * second eval. Returns `{ live, displayNameById }` as a JSON string.
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
  var ri = null;
  h.rendererInterfaces.forEach(function(r){ if (!ri) ri = r; });
  if (!ri) {
    return JSON.stringify({ live: null, displayNameById: {} });
  }

  try { ri.stopProfiling(); } catch (_e) {}

  var live = null;
  try { live = ri.getProfilingData(); } catch (_e) { /* pristine — treat as empty */ }

  var idSet = Object.create(null);
  function collectIds(pd) {
    if (!pd || !pd.dataForRoots) return;
    for (var i = 0; i < pd.dataForRoots.length; i++) {
      var cd = pd.dataForRoots[i].commitData || [];
      for (var j = 0; j < cd.length; j++) {
        var fa = cd[j].fiberActualDurations || [];
        for (var k = 0; k < fa.length; k++) if (fa[k]) idSet[fa[k][0]] = true;
        var cds = cd[j].changeDescriptions || [];
        for (var k2 = 0; k2 < cds.length; k2++) if (cds[k2]) idSet[cds[k2][0]] = true;
      }
    }
  }
  collectIds(live);

  var displayNameById = {};
  var ids = Object.keys(idSet);
  var nameCache = globalThis.__argent_fiberNames__ || null;
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    try {
      var n = ri.getDisplayNameForElementID(Number(id));
      if (typeof n === 'string' && n.length > 0) {
        displayNameById[id] = n;
      } else {
        // Live resolution failed — fiber was likely unmounted before stop
        // (transient component). Fall back to the commit-time cache populated
        // by FIBER_ROOT_TRACKER_SCRIPT.
        var cached = nameCache ? nameCache[id] : undefined;
        displayNameById[id] = (typeof cached === 'string' && cached.length > 0) ? cached : null;
      }
    } catch (_e) {
      var cachedErr = nameCache ? nameCache[id] : undefined;
      displayNameById[id] = (typeof cachedErr === 'string' && cachedErr.length > 0) ? cachedErr : null;
    }
  }

  return JSON.stringify({ live: live, displayNameById: displayNameById });
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
