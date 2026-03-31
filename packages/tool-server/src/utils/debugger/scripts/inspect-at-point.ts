/**
 * Generate a JS script that calls getInspectorDataForViewAtPoint at (x, y)
 * and pushes the result via __argent_callback binding with a requestId
 * for correlation.
 *
 * Uses data.closestInstance (the fiber at the touch point) and walks UP the
 * fiber tree via .return pointers. This is more robust than searching globally
 * by name — it correctly resolves fibers when multiple components share a name
 * (e.g. several <Button /> instances in different parents).
 *
 * Supports both Fabric (new architecture) and Paper (old architecture).
 * On Fabric, host fibers have stateNode.node (shadow node) and the stateNode
 * itself serves as the public instance for getInspectorDataForViewAtPoint.
 * On Paper, host fibers have stateNode.canonical with nativeTag and publicInstance.
 *
 * Source resolution: tries _debugStack first (bundled frame needing symbolication),
 * then falls back to _debugSource ({ fileName, lineNumber, columnNumber } from
 * @babel/plugin-transform-react-jsx-source). Frames from _debugSource are flagged
 * with `original: true` since they already contain the real source path.
 */
export function makeInspectScript(
  x: number,
  y: number,
  requestId: string
): string {
  return `(function() {
  var hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  var renderer = Array.from(hook.renderers.values())[0];
  var roots = hook.getFiberRoots(1);
  var root = Array.from(roots)[0];

  var useFabric = typeof nativeFabricUIManager !== 'undefined';

  function findHostFiber(f, d) {
    if (!f || d > 30) return null;
    if (typeof f.type === 'string' && f.stateNode) {
      if (useFabric && f.stateNode.node) return f;
      if (!useFabric && f.stateNode.canonical) return f;
    }
    return findHostFiber(f.child, d + 1) || null;
  }

  function getCompName(f) {
    var t = f.type;
    if (!t || typeof t === 'string') return null;
    if (typeof t === 'function') return t.displayName || t.name || null;
    if (typeof t === 'object') {
      var inner = t.render || t.type;
      if (inner && typeof inner === 'function') return inner.displayName || inner.name || null;
      return t.displayName || null;
    }
    return null;
  }

  function parseFrame(stack) {
    if (!stack) return null;
    var s = typeof stack === 'string' ? stack : (stack.stack || '');
    var lines = s.split('\\n').slice(1).filter(function(l){ return l.trim().startsWith('at '); });
    var target = lines[1] || lines[0];
    if (!target) return null;
    var m = target.trim().match(/at (?:([^\\s(]+) \\()?([^)]+):(\\d+):(\\d+)\\)?/);
    return m ? { fn: m[1]||'anon', file: m[2], line: parseInt(m[3]), col: parseInt(m[4]) } : null;
  }

  function getFrame(fiber) {
    var frame = parseFrame(fiber._debugStack);
    if (frame) return frame;
    var ds = fiber._debugSource;
    if (ds && ds.fileName) {
      return { fn: 'component', file: ds.fileName, line: ds.lineNumber || 0, col: ds.columnNumber || 0, original: true };
    }
    return null;
  }

  var hostFiber = findHostFiber(root.current.child, 0);
  if (!hostFiber) { __argent_callback(JSON.stringify({requestId:'${requestId}',type:'inspect_result',error:'no host fiber'})); return; }

  var inspectRef = hostFiber.stateNode.canonical.publicInstance;

  renderer.rendererConfig.getInspectorDataForViewAtPoint(
    inspectRef, ${Math.round(x)}, ${Math.round(y)},
    function(data) {
      var items = [];
      var fiber = data.closestInstance;

      if (fiber) {
        var depth = 0;
        var f = fiber;
        while (f && depth < 200) {
          var name = getCompName(f);
          if (name) {
            items.push({ name: name, frame: getFrame(f) });
          }
          f = f.return;
          depth++;
        }
      } else {
        var hi = data.hierarchy || [];
        for (var i = 0; i < hi.length; i++) {
          items.push({ name: hi[i].name, frame: null });
        }
      }

      __argent_callback(JSON.stringify({ requestId:'${requestId}', type:'inspect_result', x:${Math.round(x)}, y:${Math.round(y)}, items:items }));
    }
  );
  return 'ok';
})()`;
}
