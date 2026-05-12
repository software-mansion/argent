/**
 * Verbose error message returned when the React DevTools hook is missing.
 * Exported so the tool layer can recognise the same diagnosis without string
 * matching on bespoke phrasings. Mirrored by `react-profiler-start` so the
 * operator sees one consistent explanation regardless of which entry point
 * they hit first.
 */
export const INSPECT_NO_DEVTOOLS_HOOK_ERROR =
  "React DevTools hook (__REACT_DEVTOOLS_GLOBAL_HOOK__) is not present in this app's JavaScript runtime. " +
  "Component inspection requires a development build with React DevTools enabled. " +
  "Likely causes: (1) the app is a release/production build — DevTools is stripped to reduce bundle size; " +
  "(2) you connected to the wrong JS runtime; (3) this isn't a React (Native) app. " +
  "Fix: rebuild in debug/dev mode (e.g. `npx react-native run-ios` without --configuration Release; for Expo, run a dev client).";

export const INSPECT_NO_RENDERER_ERROR =
  "React DevTools hook is present but no renderer has registered yet. " +
  "Component inspection requires the React renderer to be attached — wait for the app to render its first commit, then retry. " +
  "If this persists, confirm the app is a React (Native) app running in development mode.";

export const INSPECT_NO_FIBER_ROOT_ERROR =
  "React DevTools is attached but no fiber root has mounted yet. " +
  "Wait for the app to render its first frame and retry.";

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
 *
 * Production-build guards: dereferencing __REACT_DEVTOOLS_GLOBAL_HOOK__ blindly
 * would throw `Cannot read property 'renderers' of undefined` on release builds
 * where DevTools is stripped. The script reports these conditions through the
 * same __argent_callback error channel as `no host fiber`, so the tool surfaces
 * a verbose diagnostic instead of a generic TypeError.
 */
export function makeInspectScript(x: number, y: number, requestId: string): string {
  const noHookMsg = JSON.stringify(INSPECT_NO_DEVTOOLS_HOOK_ERROR);
  const noRendererMsg = JSON.stringify(INSPECT_NO_RENDERER_ERROR);
  const noRootMsg = JSON.stringify(INSPECT_NO_FIBER_ROOT_ERROR);
  return `(function() {
  function __argent_fail(msg) {
    __argent_callback(JSON.stringify({requestId:'${requestId}',type:'inspect_result',error:msg}));
  }
  var hook = (typeof globalThis !== 'undefined' ? globalThis : window).__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) { __argent_fail(${noHookMsg}); return; }
  if (!hook.renderers || typeof hook.renderers.values !== 'function' || hook.renderers.size === 0) {
    __argent_fail(${noRendererMsg}); return;
  }
  var renderer = Array.from(hook.renderers.values())[0];
  if (typeof hook.getFiberRoots !== 'function') { __argent_fail(${noRendererMsg}); return; }
  var roots = hook.getFiberRoots(1);
  var root = roots && Array.from(roots)[0];
  if (!root || !root.current) { __argent_fail(${noRootMsg}); return; }

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
