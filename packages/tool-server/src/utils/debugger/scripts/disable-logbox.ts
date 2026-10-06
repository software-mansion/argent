/**
 * Suppresses the LogBox overlay and clears already-queued entries.
 *
 * Scans only initialized modules via `__r.getModules()`: evaluating an unloaded
 * module would let Metro report a top-level throw to LogBox. The `__r(i)`
 * fallback cannot avoid that, so it nulls `global.ErrorUtils` to keep those
 * errors out of LogBox.
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
