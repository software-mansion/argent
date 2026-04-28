/**
 * Suppress LogBox while the debugger is connected:
 *  - ignoreAllLogs(true): hide warnings.
 *  - wrap addException: ignoreAllLogs alone doesn't block fatal redboxes;
 *    wrapping (rather than replacing) lets ignoreAllLogs(false) re-enable them.
 *  - clear(): empty already-queued entries.
 *
 * Walks only already-initialized modules (__r.getModules) so we don't
 * force-load modules that throw on init.
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
    if (typeof LBData.addException === 'function' && !LBData.__argentAddExceptionWrapped) {
      var origAddException = LBData.addException;
      LBData.addException = function() {
        var disabled = typeof LBData.isDisabled === 'function' ? LBData.isDisabled() : true;
        if (disabled) return;
        return origAddException.apply(LBData, arguments);
      };
      LBData.__argentAddExceptionWrapped = true;
    }
    LBData.clear();
  }
})()`;
