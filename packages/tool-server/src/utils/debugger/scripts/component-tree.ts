/**
 * JS script injected via Runtime.evaluate to walk the React fiber tree.
 * Returns a JSON string with screen dimensions and component entries,
 * each carrying a name, bounding rect, parent index, and useful props
 * (testID, accessibilityLabel, visible text).
 *
 * Supports both Fabric (new architecture) and Paper (old architecture).
 * On Fabric, uses nativeFabricUIManager.measure with the shadow node.
 * On Paper, falls back to UIManager.measureInWindow with native tags.
 *
 * When includeSkipped is true, the script also tracks totalFibers walked
 * and a per-name count of JS-side skipped components.
 */
export function makeComponentTreeScript(opts?: {
  includeSkipped?: boolean;
}): string {
  const trackSkipped = opts?.includeSkipped ? "true" : "false";
  return `(function() {
  var TRACK_SKIPPED = ${trackSkipped};
  var hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) return JSON.stringify({ error: 'No DevTools hook' });
  var roots = hook.getFiberRoots(1);
  if (!roots || roots.size === 0) return JSON.stringify({ error: 'No fiber roots' });
  var root = Array.from(roots)[0];

  var useFabric = typeof nativeFabricUIManager !== 'undefined';
  var UIManagerMod;
  if (!useFabric) {
    for (var i = 0; i < 300; i++) {
      try { var m = __r(i); if (m && m.UIManager) { UIManagerMod = m.UIManager; break; } } catch(e) {}
    }
    if (!UIManagerMod) return JSON.stringify({ error: 'Could not find UIManager' });
  }

  var SKIP = new Set([
    'View','RCTView','RCTText','RCTScrollView','RCTScrollContentView','RCTImageView',
    'RCTSafeAreaView','RCTVirtualText','RCTSinglelineTextInputView','RCTMultilineTextInputView',
    'RNCSafeAreaProvider','RNSScreen','RNSScreenStack',
    'RNSScreenContentWrapper','RNSScreenNavigationContainer','RNSScreenStackHeaderConfig',
    'ScreenStackHeaderConfig','NavigationContent','NavigationStateListenerProvider',
    'PreventRemoveProvider','EnsureSingleNavigator','StaticContainer','SceneView',
    'NativeStackView','NativeStackNavigator','DelayedFreeze','Freeze','Suspender',
    'DebugContainer','ScreenContentWrapper','Screen','ScreenStack','ScreenContainer',
    'MaybeScreenContainer','MaybeScreen','FrameSizeProvider','FrameSizeProviderInner',
    'FrameSizeListenerNativeFallback','SafeAreaProviderCompat','SafeAreaProvider',
    'SafeAreaInsetsContext','SafeArea','SafeAreaFrameContext',
    'ErrorOverlay','ErrorToastContainer',
    'PerformanceLoggerContext','AppContainer','RootTagContext','DebuggingOverlay',
    'DebuggingOverlayRegistrySubscription',
    'LogBoxStateSubscription','_LogBoxNotificationContainer','LogBoxInspectorContainer',
    'LogBoxInspector','LogBoxInspectorCodeFrame','CellRenderer',
    'VirtualizedListContextProvider','VirtualizedListCellContextProvider',
    'wrapper','Background','Pressable','PlatformPressable',
    'ExpoRoot','ContextNavigator','RootApp','ThemeProvider','StatusBar',
    'ReactNativeProfiler','FeedbackWidgetProvider',
    'NavigationRouteContext','BottomTabNavigator','BottomTabView',
    'TabBarIcon','Icon','MissingIcon','Label','ImageAnalyticsTagContext',
    'Image','RootLayout','TabLayout',
    'GestureHandlerRootView','GestureDetector','Wrap',
    'RenderRegistryProvider','SharedPropsProvider','ListStyleSpecsProvider',
    'RenderersPropsProvider','TRenderEngineProvider','RenderHTMLConfigProvider',
    'RenderHtmlSource','RawSourceLoader','SourceLoaderInline','RenderTTree',
    'TNodeChildrenRenderer','MemoizedTNodeRenderer',
    'PortalProviderComponent',
    'KeyboardProviderWrapper','KeyboardProvider','KeyboardControllerView',
    'ScrollViewContext','TextAncestorContext',
    'TextInputLabel',
    'ThemeContext',
    'BaseHTMLEngineProvider',
    'VScrollViewNativeComponent','InnerScreen','ScreenStackItem',
    'BaseNavigationContainer','NavigationContainerInner','PlatformPressableInternal',
  ]);

  var HARD_SKIP = new Set([
    'BaseTextInput','InternalTextInput','RNTextInputWithRef',
    'RCTSinglelineTextInputView','RCTMultilineTextInputView',
    'LottieAnimationView','Lottie',
    'ExpoImage',
  ]);

  function isHardSkip(name) {
    if (HARD_SKIP.has(name)) return true;
    if (name.indexOf('AnimatedComponent(') === 0) return true;
    if (name.indexOf('Animated(') === 0) return true;
    if (name.indexOf('With') === 0 && name.indexOf('(') > 3) return true;
    if (name.indexOf('with') === 0 && name.indexOf('(') > 3) return true;
    if (name.indexOf('ViewManagerAdapter_') >= 0) return true;
    return false;
  }

  function shouldSkip(name) {
    if (isHardSkip(name)) return true;
    if (SKIP.has(name)) return true;
    if (name.charAt(0) === '_' && name.charAt(1) === '_') return true;
    if (name.indexOf('withDevTools(') === 0) return true;
    if (name === 'Route' || name.indexOf('Route(') === 0) return true;
    if (name.indexOf('main(') === 0) return true;
    if (name.length > 8 && name.slice(-8) === 'Provider') return true;
    if (name.length > 7 && name.slice(-7) === 'Context') return true;
    return false;
  }

  function getCompName(f) {
    var t = f.type;
    if (!t) return null;
    if (typeof t === 'string') return t;
    return t.displayName || t.name || null;
  }

  function getHostInfo(fiber) {
    if (typeof fiber.type !== 'string' || !fiber.stateNode) return null;
    if (useFabric && fiber.stateNode.node) return { f: true, n: fiber.stateNode.node };
    if (!useFabric && fiber.stateNode.canonical && typeof fiber.stateNode.canonical.nativeTag === 'number')
      return { f: false, n: fiber.stateNode.canonical.nativeTag };
    return null;
  }

  function findHostNode(fiber, d) {
    if (!fiber || d > 15) return null;
    var info = getHostInfo(fiber);
    if (info) return info;
    return findHostNode(fiber.child, d + 1);
  }

  function measureRect(info) {
    var rect = null;
    try {
      if (info.f) {
        nativeFabricUIManager.measure(info.n, function(x, y, w, h, px, py) {
          if (w > 0 && h > 0) rect = { x: Math.round(px), y: Math.round(py), w: Math.round(w), h: Math.round(h) };
        });
      } else {
        UIManagerMod.measureInWindow(info.n, function(x, y, w, h) {
          if (w > 0 && h > 0) rect = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
        });
      }
    } catch(e) {}
    return rect;
  }

  var screenW = 0, screenH = 0;
  (function findScreenDims(fiber) {
    if (!fiber || screenW > 0) return;
    var info = getHostInfo(fiber);
    if (info) {
      var r = measureRect(info);
      if (r && r.x === 0 && r.y === 0 && r.w > 0 && r.h > 0) { screenW = r.w; screenH = r.h; return; }
    }
    findScreenDims(fiber.child);
  })(root.current);

  var components = [];
  var totalFibers = 0;
  var skippedCounts = {};

  function collectAll(fiber, parentIdx) {
    if (!fiber) return;
    var name = getCompName(fiber);
    var emittedIdx = -1;

    if (name) {
      if (TRACK_SKIPPED) totalFibers++;

      var skip = shouldSkip(name);
      var testID = null, accLabel = null, text = null;
      if (fiber.memoizedProps) {
        var p = fiber.memoizedProps;
        testID = p.testID || null;
        accLabel = p.accessibilityLabel || null;
        if (typeof p.children === 'string') text = p.children.substring(0, 80);
        else if (typeof p.title === 'string') text = p.title.substring(0, 80);
        else if (typeof p.label === 'string') text = p.label.substring(0, 80);
        else if (typeof p.placeholder === 'string') text = p.placeholder.substring(0, 80);
      }

      if (skip && testID && !isHardSkip(name)) skip = false;

      if (!skip) {
        var hostInfo = getHostInfo(fiber) || findHostNode(fiber, 0);
        var rect = hostInfo ? measureRect(hostInfo) : null;

        var isTextNode = name === 'Text' || name === 'RCTText';
        if (isTextNode && !text && !testID) {
        } else if (rect || testID || accLabel || text) {
          if (isTextNode && text && parentIdx >= 0 && components[parentIdx].text === text) {
          } else {
            var entry = { id: components.length, name: name, rect: rect, parentIdx: parentIdx };
            if (testID) entry.testID = testID;
            if (accLabel) entry.accLabel = accLabel;
            if (text) entry.text = text;
            emittedIdx = components.length;
            components.push(entry);
          }
        }
      } else if (TRACK_SKIPPED) {
        skippedCounts[name] = (skippedCounts[name] || 0) + 1;
      }
    }

    collectAll(fiber.child, emittedIdx >= 0 ? emittedIdx : parentIdx);
    collectAll(fiber.sibling, parentIdx);
  }

  collectAll(root.current.child, -1);
  var result = { screenW: screenW, screenH: screenH, components: components };
  if (TRACK_SKIPPED) {
    result.totalFibers = totalFibers;
    result.skippedCounts = skippedCounts;
  }
  return JSON.stringify(result);
})()`;
}
