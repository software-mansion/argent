/**
 * IIFE that scans the Metro module registry for the LogBox module
 * and calls `ignoreAllLogs(true)` to suppress the yellow/red overlay.
 *
 * Safe to call at any time — exits early when __r is unavailable
 * (e.g. the JS context hasn't finished loading yet).
 */
export const DISABLE_LOGBOX_SCRIPT = `(function() {
  if (typeof __r !== 'function') return;
  for (var i = 0; i < 5000; i++) {
    try {
      var mod = __r(i);
      var LB = mod && (mod.LogBox || (mod.default && mod.default.ignoreAllLogs && mod.default));
      if (LB && typeof LB.ignoreAllLogs === 'function') {
        LB.ignoreAllLogs(true);
        return;
      }
    } catch(e) {}
  }
})()`;
