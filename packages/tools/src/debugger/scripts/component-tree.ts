/**
 * JS script injected via Runtime.evaluate to walk the React fiber tree.
 * Returns a JSON string of component entries with names, depth, and bounding rects.
 */
export const COMPONENT_TREE_SCRIPT = `(function() {
  var UIManager;
  for (var _i = 0; _i < 200; _i++) {
    try { var _m = __r(_i); if (_m && _m.UIManager) { UIManager = _m.UIManager; break; } } catch(e) {}
  }
  if (!UIManager) return JSON.stringify({ error: 'Could not find UIManager' });
  var hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) return JSON.stringify({ error: 'No DevTools hook' });
  var roots = hook.getFiberRoots(1);
  if (!roots || roots.size === 0) return JSON.stringify({ error: 'No fiber roots' });
  var root = Array.from(roots)[0];
  var SKIP = new Set(['PerformanceLoggerContext','AppContainer','RootTagContext',
    'DebuggingOverlay','LogBoxStateSubscription','_LogBoxNotificationContainer',
    'LogBoxInspectorContainer','LogBoxInspector','LogBoxInspectorCodeFrame',
    'CellRenderer','VirtualizedListContextProvider','VirtualizedListCellContextProvider']);
  var components = [];
  function collectFibers(fiber, depth, parentIdx) {
    if (!fiber || depth > 30) return;
    var type = fiber.type;
    var name = type ? (typeof type === 'string' ? type : (type.displayName || type.name || null)) : null;
    var idx = -1;
    if (name && !SKIP.has(name) && !name.startsWith('__')) {
      var entry = { id: components.length, name: name, depth: depth, rect: null, isHost: typeof type === 'string', parentIdx: parentIdx };
      idx = components.length;
      components.push(entry);
      var sn = fiber.stateNode;
      if (sn && sn.canonical && typeof sn.canonical.nativeTag === 'number') {
        var tag = sn.canonical.nativeTag;
        (function(e, t) {
          UIManager.measureInWindow(t, function(x, y, w, h) {
            if (w > 0 && h > 0) e.rect = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
          });
        })(entry, tag);
      }
    }
    collectFibers(fiber.child, depth + 1, idx >= 0 ? idx : parentIdx);
    collectFibers(fiber.sibling, depth, parentIdx);
  }
  collectFibers(root.current.child, 0, -1);
  return JSON.stringify(components);
})()`;
