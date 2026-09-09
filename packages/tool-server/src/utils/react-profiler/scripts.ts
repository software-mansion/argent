/**
 * JS injected via `Runtime.evaluate` into the Hermes runtime for React
 * profiling.
 */

// #region Instrumentation Setup

/**
 * Wraps each `rendererInterface`'s start/stop to track `isProfiling` state and
 * `startedAtEpochMs`, and installs the session-owner heartbeat helper.
 * Idempotent — guarded by `ri.__argent_startWrapped__`.
 *
 * The fiber-name cache is a `WeakMap` keyed by `ri` identity because RN
 * registers two `react-native-renderer` interfaces (Fabric + dormant Paper);
 * a flat cache would let one renderer's wrapper clear the other's entries.
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
    if (!ri) return;

    // Resolve the display-name accessor once per ri and stash it. The API
    // was renamed in react-devtools-core 6.x: older bundles (RN ≤0.75-ish)
    // expose getDisplayNameForFiberID; newer bundles expose
    // getDisplayNameForElementID. Resolving here means every call site
    // can do a single function lookup instead of branching, and the bug
    // where calling the absent name silently throws and drops every fiber
    // into the "unattributed" bucket goes away. Re-run on every setup
    // invocation (idempotent — same function ref each time) so the stash
    // is also populated for ris that weren't wrapped yet, e.g. ones that
    // appeared only after BOOTSTRAP_DEVTOOLS_BACKEND_SCRIPT attached.
    if (typeof ri.getDisplayNameForElementID === 'function') {
      ri.__argent_getDisplayName__ = ri.getDisplayNameForElementID.bind(ri);
    } else if (typeof ri.getDisplayNameForFiberID === 'function') {
      ri.__argent_getDisplayName__ = ri.getDisplayNameForFiberID.bind(ri);
    }

    if (ri.__argent_startWrapped__) return;
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

/**
 * Attaches the React DevTools backend when no external DevTools client
 * (Fusebox React tab, `npx react-devtools`) is connected.
 *
 * `ri.startProfiling` needs `hook.rendererInterfaces`, which only the
 * backend's `attach()` populates — React's own `hook.inject()` fills in
 * `hook.renderers` alone. With no client connected the backend's WebSocket to
 * localhost:8097 never opens, so `initBackend` never runs and the profiler has
 * no renderer interface to drive.
 *
 * Workaround: find `react-devtools-core` in the Metro module registry and call
 * `connectWithCustomMessagingProtocol` (5.1+) with no-op handlers; it builds a
 * Bridge + Agent and runs `initBackend`, which populates
 * `hook.rendererInterfaces` via `attach()`. Discarding every outbound message
 * is fine — argent drives the renderer interface directly and never reads the
 * bridge.
 *
 * Idempotent — early-returns `already-attached`, so retries within a session
 * do not leak `hook.sub('renderer', ...)` listeners via repeated `initBackend`
 * calls.
 *
 * Returns a JSON string `{ ok, reason, renderersCount, rendererInterfacesCount,
 * message? }`; the reasons are enumerated in `devtools-bootstrap.ts`.
 */
export const BOOTSTRAP_DEVTOOLS_BACKEND_SCRIPT = `
(function __argent_bootstrapDevtoolsBackend() {
  var h = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!h) return JSON.stringify({ ok: false, reason: 'no-hook' });

  function sizeOf(m) {
    if (!m || typeof m.forEach !== 'function') return 0;
    var n = 0;
    m.forEach(function () { n++; });
    return n;
  }

  var renderersCount = sizeOf(h.renderers);
  var rendererInterfacesCount = sizeOf(h.rendererInterfaces);

  if (rendererInterfacesCount > 0) {
    return JSON.stringify({
      ok: true,
      reason: 'already-attached',
      renderersCount: renderersCount,
      rendererInterfacesCount: rendererInterfacesCount,
    });
  }

  if (renderersCount === 0) {
    return JSON.stringify({
      ok: false,
      reason: 'no-renderers',
      renderersCount: renderersCount,
      rendererInterfacesCount: rendererInterfacesCount,
    });
  }

  if (typeof globalThis.__r !== 'function' || typeof globalThis.__r.getModules !== 'function') {
    return JSON.stringify({
      ok: false,
      reason: 'no-metro-modules',
      renderersCount: renderersCount,
      rendererInterfacesCount: rendererInterfacesCount,
    });
  }

  var found = null;
  var moduleSeenButUnsupported = false;
  try {
    var mods = globalThis.__r.getModules();
    var inspect = function (id, meta) {
      if (found) return;
      var name = meta && meta.verboseName;
      if (typeof name !== 'string') return;
      if (name.indexOf('react-devtools-core/dist/backend') < 0) return;
      try {
        var m = globalThis.__r(id);
        if (!m) return;
        if (typeof m.connectWithCustomMessagingProtocol === 'function') {
          found = m;
        } else {
          // Module exists but exposes only legacy WebSocket-based connectToDevTools
          // (rdt-core <5.1). We can't bootstrap without a real ws endpoint, so the
          // user has to attach an external backend (\`npx react-devtools\` + reload).
          moduleSeenButUnsupported = true;
        }
      } catch (_e) {
        // require failure on this id — keep searching.
      }
    };
    // Metro's getModules() returns a Map<id, meta> in modern versions.
    // Map#forEach calls back as (value, key); array-like fallback handled below.
    if (typeof mods.forEach === 'function' && typeof mods.size === 'number') {
      mods.forEach(function (meta, id) { inspect(id, meta); });
    } else if (typeof mods.length === 'number') {
      for (var i = 0; i < mods.length; i++) {
        if (mods[i]) inspect(i, mods[i]);
      }
    } else if (typeof mods.forEach === 'function') {
      mods.forEach(function (meta, id) { inspect(id, meta); });
    }
  } catch (err) {
    return JSON.stringify({
      ok: false,
      reason: 'metro-scan-error',
      message: String((err && err.message) || err),
      renderersCount: renderersCount,
      rendererInterfacesCount: rendererInterfacesCount,
    });
  }

  if (!found) {
    return JSON.stringify({
      ok: false,
      reason: moduleSeenButUnsupported ? 'unsupported-rdt-version' : 'no-rdt-module',
      renderersCount: renderersCount,
      rendererInterfacesCount: rendererInterfacesCount,
    });
  }

  try {
    found.connectWithCustomMessagingProtocol({
      onSubscribe: function () {},
      onUnsubscribe: function () {},
      onMessage: function () {},
    });
  } catch (err) {
    return JSON.stringify({
      ok: false,
      reason: 'bootstrap-threw',
      message: String((err && err.message) || err),
      renderersCount: renderersCount,
      rendererInterfacesCount: rendererInterfacesCount,
    });
  }

  var afterCount = sizeOf(h.rendererInterfaces);
  if (afterCount === 0) {
    return JSON.stringify({
      ok: false,
      reason: 'bootstrap-no-effect',
      renderersCount: renderersCount,
      rendererInterfacesCount: rendererInterfacesCount,
    });
  }

  return JSON.stringify({
    ok: true,
    reason: 'bootstrapped',
    renderersCount: renderersCount,
    rendererInterfacesCount: afterCount,
  });
})()
`;

// #endregion

// #region Session Lifecycle

/**
 * Bumps `lastHeartbeatEpochMs` on the session owner so concurrent tool-server
 * instances do not classify it as stale. No-op before
 * `REACT_NATIVE_PROFILER_SETUP_SCRIPT` has run.
 */
export const HEARTBEAT_SCRIPT = `
(function(){
  if (typeof globalThis.__argent_profilerHeartbeat === 'function') {
    try { globalThis.__argent_profilerHeartbeat(); } catch (_e) {}
  }
})()
`;

/**
 * Side-effect-free read of profiling state, so the caller can decide whether
 * to start, take over, or refuse a new session.
 *
 * `isRunning` is true when ANY renderer is profiling — with RN's Fabric +
 * dormant Paper pair the first iterated renderer is not necessarily the
 * active one.
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
 * Starts profiling on EVERY registered renderer interface and installs
 * `ownerJson` as `__ARGENT_PROFILER_OWNER__`. Starting all of them is
 * load-bearing: RN registers Fabric plus a dormant Paper renderer, and `Map`
 * insertion order can put the dormant one first.
 *
 * `ok: true` requires at least one renderer to report
 * `__argent_isProfiling__ === true`, not merely that no call threw — a dormant
 * renderer accepts `startProfiling` without ever capturing a commit.
 *
 * `startedAtEpochMs` comes from the wrapper's device-side `Date.now()` rather
 * than the host clock, so host/device skew cannot shift the session window.
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
 * Stops profiling on EVERY registered renderer and clears the owner record so
 * a new session can take over cleanly.
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
 * Tracks fiber roots in `hook.__argent_roots__` and, while profiling, records
 * a per-renderer fiberID → displayName cache in `globalThis.__argent_fiberNames__`
 * (`WeakMap<ri, {[fiberID]: name}>`). Idempotent via
 * `hook.__argent_profiler_installed__`.
 *
 * That cache is the only way to recover names for components that unmount
 * before `STOP_AND_READ_SCRIPT` runs (modals, popovers, navigation screens):
 * the DevTools backend drops unmounted fibers from `idToDevToolsInstanceMap`,
 * so the display-name accessor returns null at stop time. Reading names
 * immediately after React's `handleCommitFiberRoot` guarantees the fiber is
 * still present. Keying by `ri` keeps Fabric's and Paper's ID spaces apart.
 *
 * Prefers the accessor stashed by the setup wrapper, resolving one directly as
 * a fallback in case setup has not run yet.
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

      var getName = (typeof ri.__argent_getDisplayName__ === 'function')
        ? ri.__argent_getDisplayName__
        : (typeof ri.getDisplayNameForElementID === 'function')
          ? ri.getDisplayNameForElementID.bind(ri)
          : (typeof ri.getDisplayNameForFiberID === 'function')
            ? ri.getDisplayNameForFiberID.bind(ri)
            : null;
      if (!getName) return;

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
            var name = getName(fiberID);
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
 * Stops the backend profiler on EVERY registered renderer and merges each
 * one's `getProfilingData()` buffer into a single `dataForRoots` array.
 * Iterating all of them is load-bearing — on RN (Fabric + dormant Paper) the
 * active renderer is not necessarily first in `Map` insertion order.
 *
 * `displayNameById` is keyed by bare `fiberID`: the dormant Paper renderer
 * emits no commits, so its ID space never overlaps Fabric's in practice. Were
 * a second active renderer ever added, the renderer iterated first would win
 * and a composite key would be needed.
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
  // Set to true if at least one ri exposed a usable display-name accessor.
  // Stays false when every ri lacks both API names — useful diagnostic
  // surfaced by the stop tool to distinguish "API missing" from
  // "transient-unmount race" failures.
  var anyNameApi = false;

  function resolveName(getName, id, out, bucket) {
    if (out[id] !== undefined) return;
    if (getName) {
      try {
        var n = getName(Number(id));
        if (typeof n === 'string' && n.length > 0) { out[id] = n; return; }
      } catch (_e) {}
    }
    // Live resolution failed or unavailable — fiber was likely unmounted
    // before stop (transient component) or the renderer never exposed an
    // accessor. Fall back to the per-ri commit-time cache.
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

    // Resolve the display-name accessor lazily — setup may not have run
    // for this ri (e.g. an external caller invoked stop without start).
    var getName = (typeof ri.__argent_getDisplayName__ === 'function')
      ? ri.__argent_getDisplayName__
      : (typeof ri.getDisplayNameForElementID === 'function')
        ? ri.getDisplayNameForElementID.bind(ri)
        : (typeof ri.getDisplayNameForFiberID === 'function')
          ? ri.getDisplayNameForFiberID.bind(ri)
          : null;
    if (getName) anyNameApi = true;

    for (var i = 0; i < pd.dataForRoots.length; i++) {
      var root = pd.dataForRoots[i];
      allRoots.push(root);

      var cd = root.commitData || [];
      for (var j = 0; j < cd.length; j++) {
        var fa = cd[j].fiberActualDurations || [];
        for (var k = 0; k < fa.length; k++) if (fa[k]) {
          resolveName(getName, fa[k][0], displayNameById, bucket);
        }
        var cds = cd[j].changeDescriptions || [];
        for (var k2 = 0; k2 < cds.length; k2++) if (cds[k2]) {
          resolveName(getName, cds[k2][0], displayNameById, bucket);
        }
      }
    }
  });

  if (!anySaw) {
    return JSON.stringify({ live: null, displayNameById: {} });
  }
  return JSON.stringify({
    live: { dataForRoots: allRoots },
    displayNameById: displayNameById,
    displayNameApiAvailable: anyNameApi,
  });
})()
`;

/**
 * Walks the live fiber tree from all known roots and collects per-component
 * `hookTypes`, `isCompilerOptimized` and `parentName`, keyed by display name,
 * to enrich the commit data returned by `STOP_AND_READ_SCRIPT`.
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

  // Null prototype: component display names are untrusted, and on a plain
  // object a fiber named "__proto__" or "constructor" would fail the
  // membership check (inherited member) and its row would be silently skipped.
  var out = Object.create(null);
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
