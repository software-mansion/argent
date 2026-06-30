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
 * Supports both Fabric (new architecture) and Paper (old architecture), across
 * RN versions whose getInspectorDataForViewAtPoint contract differs:
 * - Anchor: Fabric uses the host fiber's public instance; Paper anchors at the
 *   FiberRoot container (its native tag) because the first host fiber is often a
 *   sibling subtree that does not contain the point, so findSubviewIn would
 *   resolve nothing. (Older Paper builds without a containerTag fall back to the
 *   host fiber, recognised via stateNode.canonical or stateNode._nativeTag.)
 * - Result: older RN returns a walkable data.closestInstance; RN 0.81+ returns
 *   data.componentStack (a stack string) instead -- both are handled.
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
  // JSON.stringify yields a valid JS string literal — escapes quotes/newlines
  // that a bare '${requestId}' would inject raw (consistent with the network
  // detail script; requestId is a randomUUID today, so this is defense-in-depth).
  const ridLiteral = JSON.stringify(requestId);
  return `(function() {
  function __argent_fail(msg) {
    __argent_callback(JSON.stringify({requestId:${ridLiteral},type:'inspect_result',error:msg}));
  }
  try {
  var hook = (typeof globalThis !== 'undefined' ? globalThis : window).__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) { __argent_fail(${noHookMsg}); return; }
  if (!hook.renderers || typeof hook.renderers.values !== 'function' || hook.renderers.size === 0) {
    __argent_fail(${noRendererMsg}); return;
  }
  if (typeof hook.getFiberRoots !== 'function') { __argent_fail(${noRendererMsg}); return; }

  // Pick the renderer + root that hosts the real app UI. Secondary reconcilers
  // (react-native-skia, react-native-svg, ...) register their own renderer and
  // often take id 1, whose roots contain only that library's nodes. Walk every
  // renderer's roots and keep the (renderer, root) pair with the largest fiber
  // subtree, then run getInspectorDataForViewAtPoint against that renderer.
  var renderer = null, root = null, _best = -1;
  if (hook.renderers && typeof hook.renderers.forEach === 'function') {
    hook.renderers.forEach(function(_r, _id) {
      var _rs;
      try { _rs = hook.getFiberRoots(_id); } catch (e) { return; }
      if (!_rs) return;
      _rs.forEach(function(_rt) {
        var _sz = 0, _stk = [_rt.current];
        while (_stk.length > 0 && _sz < 20000) {
          var _nd = _stk.pop();
          if (!_nd) continue;
          _sz++;
          if (_nd.child) _stk.push(_nd.child);
          if (_nd.sibling) _stk.push(_nd.sibling);
        }
        if (_sz > _best) { _best = _sz; renderer = _r; root = _rt; }
      });
    });
  }
  if (!renderer || !root) {
    renderer = Array.from(hook.renderers.values())[0];
    var _legacy = hook.getFiberRoots(1);
    root = _legacy ? Array.from(_legacy)[0] : null;
  }
  if (!renderer || !root || !root.current) { __argent_fail(${noRootMsg}); return; }

  var useFabric = typeof nativeFabricUIManager !== 'undefined';

  function findHostFiber(f, d) {
    if (!f || d > 30) return null;
    if (typeof f.type === 'string' && f.stateNode) {
      if (useFabric && f.stateNode.node) return f;
      // Old-arch (Paper) host fibers may expose stateNode.canonical (newer RN)
      // OR a bare ReactNativeFiberHostComponent whose native tag lives directly
      // on stateNode._nativeTag (RN 0.81 on the legacy bridge). Recognise both,
      // mirroring component-tree.ts getHostInfo. Without the _nativeTag fallback
      // findHostFiber returns nothing and the script throws 'no host fiber'.
      if (!useFabric && (f.stateNode.canonical || typeof f.stateNode._nativeTag === 'number')) return f;
    }
    return findHostFiber(f.child, d + 1) || null;
  }

  // Resolve the host instance to hand to getInspectorDataForViewAtPoint.
  // When a canonical wrapper exists (Fabric, and newer Paper), its publicInstance
  // IS the inspectedView -- return it as-is, even when null. On Fabric the
  // publicInstance is realized lazily, so a freshly-mounted host fiber can have
  // canonical.publicInstance === null; the prior code handed that null straight
  // through (the renderer fast-fails into our try/catch). We must NOT substitute
  // the raw stateNode on a canonical path -- a raw Fabric stateNode is not a valid
  // inspectedView, so the renderer logs and never invokes the callback (the
  // inspect request would hang). Returning publicInstance as-is preserves the
  // prior behavior on every canonical path exactly.
  // Paper without canonical: the bare ReactNativeFiberHostComponent stateNode is
  // itself a valid inspectedView -- it carries _internalFiberInstanceHandleDEV and
  // findNodeHandle() reads its _nativeTag, which is exactly what the renderer's
  // Paper branch needs. This is the RN 0.81 legacy-bridge case that previously
  // produced 'no host fiber'.
  function getInspectRef(f) {
    var sn = f.stateNode;
    if (sn.canonical) return sn.canonical.publicInstance;
    return sn;
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

  // On the RN runtimes observed live (RN 0.81.x + Hermes, legacy bridge),
  // getInspectorDataForViewAtPoint does not return a walkable data.closestInstance
  // -- closestInstance is absent and data.componentStack (a React component-stack
  // STRING) carries the result instead. Lines look like:
  //   "    at View (http://.../index.bundle//...:10685:19)"
  //   "    at RCTView (<anonymous>)"
  //   "    at f (address at http://.../InternalBytecode.js:1:2)"  // Hermes internal
  // Parse the component frames out of it. Bundle locations (file:line:col) are
  // handed back as unsymbolicated frames so the tool layer /symbolicate's them
  // exactly like _debugStack frames. Host primitives (<anonymous>, no source)
  // and Hermes bytecode/native frames (file token with a space or '<', e.g.
  // "address at <url>") are dropped -- only a clean source/bundle path is
  // symbolicatable and corresponds to an app component.
  function itemsFromComponentStack(cs) {
    var out = [];
    var lines = cs.split('\\n');
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^\\s*at (.+) \\(([^()]*)\\)\\s*$/);
      if (!m) continue;
      var lm = m[2].match(/^(.*):(\\d+):(\\d+)$/);
      if (!lm) continue;
      if (/[ <]/.test(lm[1])) continue;
      out.push({ name: m[1], frame: { fn: m[1], file: lm[1], line: parseInt(lm[2]), col: parseInt(lm[3]) } });
    }
    return out;
  }

  // Choose the anchor view for getInspectorDataForViewAtPoint.
  // On Paper (old arch) the FiberRoot container is the universal ancestor of the
  // app's views, so findSubviewIn scoped to it hit-tests the whole screen. The
  // first host fiber is NOT a safe anchor on RN 0.81: it is frequently a sibling
  // subtree (a gesture / overlay root) that does not contain the touch point, so
  // findSubviewIn then returns nothing for EVERY coordinate. Anchor at the
  // container's native tag (with the root fiber as the handle the renderer's
  // old-arch branch guard checks). Fabric keeps the host-fiber path (its
  // container shape differs); older Paper builds without a containerTag also fall
  // back to the host fiber.
  // foundAnchor distinguishes "no anchor at all" (real 'no host fiber') from
  // "anchor found but ref is intentionally null" (Fabric host fiber whose
  // publicInstance is not yet realized -- we pass null through unchanged, as the
  // pre-container-anchor code did, rather than reporting no host fiber).
  var inspectRef = null;
  var foundAnchor = false;
  var containerInfo = root.current && root.current.stateNode && root.current.stateNode.containerInfo;
  if (!useFabric && containerInfo && typeof containerInfo.containerTag === 'number') {
    inspectRef = { _nativeTag: containerInfo.containerTag, _internalFiberInstanceHandleDEV: root.current };
    foundAnchor = true;
  } else {
    var hostFiber = findHostFiber(root.current.child, 0);
    if (hostFiber) { inspectRef = getInspectRef(hostFiber); foundAnchor = true; }
  }
  if (!foundAnchor) { __argent_callback(JSON.stringify({requestId:${ridLiteral},type:'inspect_result',error:'no host fiber'})); return; }

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
      } else if (typeof data.componentStack === 'string' && data.componentStack.length > 0) {
        items = itemsFromComponentStack(data.componentStack);
      } else {
        var hi = data.hierarchy || [];
        for (var i = 0; i < hi.length; i++) {
          items.push({ name: hi[i].name, frame: null });
        }
      }

      __argent_callback(JSON.stringify({ requestId:${ridLiteral}, type:'inspect_result', x:${Math.round(x)}, y:${Math.round(y)}, items:items }));
    }
  );
  return 'ok';
  } catch (e) {
    __argent_fail('Inspect script crashed: ' + (e && e.message ? e.message : String(e)));
  }
})()`;
}
