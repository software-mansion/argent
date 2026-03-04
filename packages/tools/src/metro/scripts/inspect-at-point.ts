/**
 * Generate a JS script that calls getInspectorDataForViewAtPoint at (x, y)
 * and pushes the result via __radon_lite_callback binding with a requestId
 * for correlation.
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
  function findHostSN(f,d){if(!f||d>30)return null;var sn=f.stateNode;if(sn&&typeof sn==='object'&&sn.canonical)return sn;return findHostSN(f.child,d+1)||null;}
  function findFiber(f,n,d){if(!f||d>40)return null;var t=f.type;var nm=t?(typeof t==='string'?t:(t.displayName||t.name)):null;if(nm===n)return f;return findFiber(f.child,n,d+1)||findFiber(f.sibling,n,d);}
  function frame1(stack) {
    if(!stack) return null;
    var s = typeof stack === 'string' ? stack : (stack.stack || '');
    var lines = s.split('\\n').slice(1).filter(function(l){return l.trim().startsWith('at ');});
    var target = lines[1] || lines[0];
    if(!target) return null;
    var m = target.trim().match(/at (?:([^\\s(]+) \\()?([^)]+):(\\d+):(\\d+)\\)?/);
    return m ? { fn:m[1]||'anon', file:m[2], line:parseInt(m[3]), col:parseInt(m[4]) } : null;
  }
  var sn = findHostSN(root.current.child, 0);
  if (!sn) { __radon_lite_callback(JSON.stringify({requestId:'${requestId}',type:'inspect_result',error:'no host fiber'})); return; }
  renderer.rendererConfig.getInspectorDataForViewAtPoint(
    sn.canonical.publicInstance, ${Math.round(x)}, ${Math.round(y)},
    function(data) {
      var items = (data.hierarchy||[]).map(function(item){
        var fiber = findFiber(root.current.child, item.name, 0);
        var ds = fiber && fiber._debugStack;
        return { name: item.name, frame: frame1(ds) };
      });
      __radon_lite_callback(JSON.stringify({ requestId:'${requestId}', type:'inspect_result', x:${Math.round(x)}, y:${Math.round(y)}, items:items }));
    }
  );
  return 'ok';
})()`;
}
