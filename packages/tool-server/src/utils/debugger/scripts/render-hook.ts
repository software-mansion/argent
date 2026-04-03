/**
 * JS script injected via Runtime.evaluate that patches onCommitFiberRoot
 * to detect re-renders. Tracks fibers with a WeakMap, distinguishes mounts
 * from re-renders, measures bounding rects, and pushes results via binding.
 */
export const RENDER_HOOK_SCRIPT = `(function() {
  if (globalThis.__argent_render_patched) return 'already active';
  globalThis.__argent_render_patched = true;
  var UIManager;
  if (typeof __r.getModules === 'function') {
    var _mods = __r.getModules();
    for (var _entry of _mods) {
      if (!_entry[1].isInitialized) continue;
      try { var _m = __r(_entry[0]); if (_m && _m.UIManager) { UIManager = _m.UIManager; break; } } catch(e) {}
    }
  } else {
    for (var _i = 0; _i < 200; _i++) {
      try { var _m = __r(_i); if (_m && _m.UIManager) { UIManager = _m.UIManager; break; } } catch(e) {}
    }
  }
  var hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  var SKIP = new Set(['PerformanceLoggerContext','AppContainer','RootTagContext',
    'DebuggingOverlay','LogBoxStateSubscription','_LogBoxNotificationContainer',
    'RNCSafeAreaProvider','CellRenderer','VirtualizedListContextProvider']);
  var fiberSeen = new WeakMap();
  var commitCount = 0;
  function isComp(f){return f.tag===0||f.tag===1;}
  function getHF(f){var c=f.child;while(c){if(c.tag===5)return c;var n=getHF(c);if(n)return n;c=c.sibling;}return null;}
  function getName(f){var t=f.type;return !t?null:(typeof t==='string'?t:(t.displayName||t.name||null));}
  function walk(fiber, results, depth) {
    if(!fiber||depth>25)return;
    if(isComp(fiber)){
      var name=getName(fiber);
      if(name&&!SKIP.has(name)){
        var wasSeen=fiberSeen.has(fiber)||(fiber.alternate&&fiberSeen.has(fiber.alternate));
        fiberSeen.set(fiber,commitCount);
        if(fiber.alternate)fiberSeen.set(fiber.alternate,commitCount);
        var hf=getHF(fiber);
        if(hf&&hf.stateNode&&hf.stateNode.canonical){
          var tag=hf.stateNode.canonical.nativeTag;
          if(typeof tag==='number'){
            var e={name:name,tag:tag,isRerender:wasSeen,x:0,y:0,w:0,h:0};
            results.push(e);
            UIManager.measureInWindow(tag,function(x,y,w,h){e.x=Math.round(x);e.y=Math.round(y);e.w=Math.round(w);e.h=Math.round(h);});
          }
        }
      }
    }
    walk(fiber.child,results,depth+1);
    walk(fiber.sibling,results,depth);
  }
  var origCommit = hook.onCommitFiberRoot;
  hook.onCommitFiberRoot = function(rid, root, pri) {
    if(origCommit) origCommit(rid, root, pri);
    commitCount++;
    var results=[];
    walk(root.current, results, 0);
    var rerenders = results.filter(function(r){return r.isRerender;}).length;
    if(results.length > 0) {
      var payload = results.map(function(r){var c=Object.assign({},r);delete c.tag;return c;});
      __argent_callback(JSON.stringify({type:'render',commit:commitCount,count:results.length,rerenders:rerenders,renders:payload.slice(0,20)}));
    }
  };
  return 'render hook installed';
})()`;
