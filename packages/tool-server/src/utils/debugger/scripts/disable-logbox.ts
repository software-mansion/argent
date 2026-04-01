/**
 * IIFE that scans the Metro module registry for the LogBox module
 * and calls `ignoreAllLogs(true)` to suppress the yellow/red overlay,
 * then clears any already-queued LogBox entries (e.g. SegmentFetcher).
 *
 * Uses `__r.getModules()` (available in DEV) to iterate only
 * already-initialized modules, avoiding forced evaluation of unloaded
 * modules. This prevents Metro's `guardedLoadModule` from reporting
 * errors to LogBox when a module's top-level code throws (e.g.
 * `TurboModuleRegistry.getEnforcing('SegmentFetcher')` in Expo builds).
 *
 * Falls back to the ErrorUtils-suppression approach when `getModules`
 * is unavailable: temporarily nulls `global.ErrorUtils` so that any
 * errors thrown during `__r(i)` scanning are caught by our try-catch
 * instead of being routed to LogBox via `ErrorUtils.reportFatalError`.
 *
 * Safe to call at any time — exits early when __r is unavailable.
 */
export const DISABLE_LOGBOX_SCRIPT = `(function() {
  if (typeof __r !== 'function') return;

  function findLogBox(mod) {
    return mod && (mod.LogBox || (mod.default && mod.default.ignoreAllLogs && mod.default));
  }

  function findLogBoxData(mod) {
    return mod
      && typeof mod.clear === 'function'
      && typeof mod.addLog === 'function'
      && typeof mod.isMessageIgnored === 'function'
      ? mod : null;
  }

  var LB = null;
  var LBData = null;

  if (typeof __r.getModules === 'function') {
    var modules = __r.getModules();
    for (var entry of modules) {
      var id = entry[0], meta = entry[1];
      if (!meta.isInitialized) continue;
      try {
        var mod = __r(id);
        if (!LB) LB = findLogBox(mod);
        if (!LBData) LBData = findLogBoxData(mod);
        if (LB && LBData) break;
      } catch(e) {}
    }
  } else {
    var savedEU = global.ErrorUtils;
    global.ErrorUtils = null;
    try {
      for (var i = 0; i < 5000; i++) {
        try {
          var mod = __r(i);
          if (!LB) LB = findLogBox(mod);
          if (!LBData) LBData = findLogBoxData(mod);
          if (LB && LBData) break;
        } catch(e) {}
      }
    } finally {
      global.ErrorUtils = savedEU;
    }
  }

  if (LB && typeof LB.ignoreAllLogs === 'function') {
    LB.ignoreAllLogs(true);
  }
  if (LBData) {
    LBData.clear();
  }
})()`;
