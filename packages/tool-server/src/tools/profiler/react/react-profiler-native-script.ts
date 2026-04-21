/**
 * App-side instrumentation for the native React DevTools profiler backend.
 *
 * Does two things:
 *   (a) Installs an idempotent monkey-patch on every `rendererInterface`'s
 *       `startProfiling` / `stopProfiling` — gives us an authoritative sync
 *       `isProfiling` flag, captures `startedAtEpochMs` (the wall-clock anchor
 *       for commit timestamps, which the backend reports ms-since-start), and
 *       snapshots prior data to `__ARGENT_PREV_PROFILE__` before any call
 *       that would otherwise silently wipe it.
 *   (b) Exposes `__argent_profilerHeartbeat()` so profiler tools can bump
 *       `__ARGENT_PROFILER_OWNER__.lastHeartbeatEpochMs` on each invocation.
 *
 * Owner metadata (`__ARGENT_PROFILER_OWNER__`) is set by the start tool after
 * a successful `ri.startProfiling` and cleared by the stop wrapper on stop —
 * the script itself only creates it lazily when needed.
 *
 * Idempotency is load-bearing: re-running this script across tool invocations
 * must not produce cascading wrappers. Guarded via `ri.__argent_startWrapped__`.
 */
export const NATIVE_PROFILER_SCRIPT = `
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

      // Snapshot any prior buffer before native start wipes it.
      try {
        var prev = ri.getProfilingData();
        if (prev && prev.dataForRoots && prev.dataForRoots.length > 0) {
          globalThis.__ARGENT_PREV_PROFILE__ = prev;
        }
      } catch (_e) { /* pristine state — nothing to save */ }

      var startedAtEpochMs = Date.now();
      ri.__argent_startedAtEpochMs__ = startedAtEpochMs;
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
      }
    };
  });
})();
`;

/**
 * Returns the first rendererInterface as-a-JS-expression, or `null` if none.
 * Used by the start/stop tools to read backend state in a single eval.
 */
export const RENDERER_INTERFACE_EXPR = `(function(){
  var h = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!h || !h.rendererInterfaces) return null;
  var found = null;
  h.rendererInterfaces.forEach(function(ri){ if (!found) found = ri; });
  return found;
})()`;
