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
 * Measurement is async-safe: on Paper (where measureInWindow is async),
 * the script collects all candidates first, then batch-measures them via
 * Promise.all, with a per-host-tag cache to avoid redundant bridge calls.
 *
 * When includeSkipped is true, the script also tracks totalFibers walked
 * and a per-name count of JS-side skipped components.
 */
export function makeComponentTreeScript(opts: {
  includeSkipped?: boolean;
  requestId: string;
}): string {
  const trackSkipped = opts?.includeSkipped ? "true" : "false";
  const requestId = JSON.stringify(opts.requestId);
  return `(async function() {
  var REQUEST_ID = ${requestId};
  var TRACK_SKIPPED = ${trackSkipped};
  var hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) return JSON.stringify({ error: 'No DevTools hook' });
  var roots = hook.getFiberRoots(1);
  if (!roots || roots.size === 0) return JSON.stringify({ error: 'No fiber roots' });
  var root = Array.from(roots)[0];

  var useFabric = typeof nativeFabricUIManager !== 'undefined';
  var UIManagerMod;
  if (!useFabric) {
    if (typeof __r.getModules === 'function') {
      var _mods = __r.getModules();
      for (var _entry of _mods) {
        if (!_entry[1].isInitialized) continue;
        try { var m = __r(_entry[0]); if (m && m.UIManager) { UIManagerMod = m.UIManager; break; } } catch(e) {}
      }
    } else {
      for (var i = 0; i < 300; i++) {
        try { var m = __r(i); if (m && m.UIManager) { UIManagerMod = m.UIManager; break; } } catch(e) {}
      }
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
    if (!useFabric) {
      if (fiber.stateNode.canonical && typeof fiber.stateNode.canonical.nativeTag === 'number')
        return { f: false, n: fiber.stateNode.canonical.nativeTag };
      if (typeof fiber.stateNode._nativeTag === 'number')
        return { f: false, n: fiber.stateNode._nativeTag };
    }
    return null;
  }

  function findHostNode(fiber, d) {
    if (!fiber || d > 15) return null;
    var info = getHostInfo(fiber);
    if (info) return info;
    return findHostNode(fiber.child, d + 1);
  }

  // --- Screen dimensions via Dimensions API (reliable fallback) ---
  var screenW = 0, screenH = 0;
  try {
    function _findDimensions(mod) {
      if (mod && mod.Dimensions) {
        var win = mod.Dimensions.get('window');
        if (win && win.width > 0 && win.height > 0) {
          screenW = Math.round(win.width);
          screenH = Math.round(win.height);
          return true;
        }
      }
      return false;
    }
    if (typeof __r.getModules === 'function') {
      var _dMods = __r.getModules();
      for (var _dEntry of _dMods) {
        if (!_dEntry[1].isInitialized) continue;
        try { if (_findDimensions(__r(_dEntry[0]))) break; } catch(e) {}
      }
    } else {
      for (var i = 0; i < 500; i++) {
        try { if (_findDimensions(__r(i))) break; } catch(e) {}
      }
    }
  } catch(e) {}

  // --- Phase 1: Walk tree, collect candidates (no measurement yet) ---
  var candidates = [];
  var totalFibers = 0;
  var skippedCounts = {};

  function collectAll(fiber, parentCandidateIdx) {
    if (!fiber) return;

    // Skip entire subtrees of inactive screens/pages. react-native-screens uses
    // activityState (0=inactive, 2=active) and pagers use isPageFocused.
    // This prunes off-screen navigation stacks and inactive tab pages.
    if (fiber.memoizedProps) {
      var as = fiber.memoizedProps.activityState;
      if (as === 0 || as === 1) {
        collectAll(fiber.sibling, parentCandidateIdx);
        return;
      }
      if (fiber.memoizedProps.isPageFocused === false) {
        collectAll(fiber.sibling, parentCandidateIdx);
        return;
      }
    }

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

      // Skip host components (native views) with no testID — their parent React
      // component carries the semantic info and inherits their rect via findHostNode.
      // This removes rendering internals like UITextView, UITextViewInner, etc.
      if (!skip && typeof fiber.type === 'string' && !testID) {
        skip = true;
      }

      if (!skip) {
        var hostInfo = getHostInfo(fiber) || findHostNode(fiber, 0);
        emittedIdx = candidates.length;
        candidates.push({
          name: name,
          hostInfo: hostInfo,
          parentIdx: parentCandidateIdx,
          testID: testID,
          accLabel: accLabel,
          text: text,
          rect: null
        });
      } else if (TRACK_SKIPPED) {
        skippedCounts[name] = (skippedCounts[name] || 0) + 1;
      }
    }

    collectAll(fiber.child, emittedIdx >= 0 ? emittedIdx : parentCandidateIdx);
    collectAll(fiber.sibling, parentCandidateIdx);
  }

  collectAll(root.current.child, -1);

  // --- Phase 2: Batch measure with per-host-tag caching ---
  var rectCache = {};
  var uniqueHosts = [];
  var hostKeyMap = {};

  for (var ci = 0; ci < candidates.length; ci++) {
    var hi = candidates[ci].hostInfo;
    if (!hi) continue;
    var key = (hi.f ? 'f' : 'p') + hi.n;
    if (!(key in hostKeyMap)) {
      hostKeyMap[key] = uniqueHosts.length;
      uniqueHosts.push(hi);
    }
  }

  function measureOne(info) {
    return new Promise(function(resolve) {
      try {
        if (info.f) {
          nativeFabricUIManager.measure(info.n, function(x, y, w, h, px, py) {
            if (w > 0 && h > 0) resolve({ x: Math.round(px), y: Math.round(py), w: Math.round(w), h: Math.round(h) });
            else resolve(null);
          });
        } else {
          UIManagerMod.measureInWindow(info.n, function(x, y, w, h) {
            if (w > 0 && h > 0) resolve({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
            else resolve(null);
          });
        }
      } catch(e) { resolve(null); }
    });
  }

  var rects = await Promise.all(uniqueHosts.map(measureOne));

  for (var ri = 0; ri < uniqueHosts.length; ri++) {
    var rKey = (uniqueHosts[ri].f ? 'f' : 'p') + uniqueHosts[ri].n;
    rectCache[rKey] = rects[ri];
  }

  // Assign rects to candidates
  for (var ai = 0; ai < candidates.length; ai++) {
    var h = candidates[ai].hostInfo;
    if (h) {
      var rk = (h.f ? 'f' : 'p') + h.n;
      candidates[ai].rect = rectCache[rk] || null;
    }
  }

  // --- Phase 3: Filter and build final components array ---
  var components = [];
  var candidateToComp = {};

  for (var fi = 0; fi < candidates.length; fi++) {
    var c = candidates[fi];
    var isTextNode = c.name === 'Text' || c.name === 'RCTText';

    // Skip empty text nodes with no testID
    if (isTextNode && !c.text && !c.testID) continue;

    // Must have a rect or a testID. Components with only text/accLabel but no
    // rect and no testID are unmeasurable and untappable — they add context noise
    // without enabling any interaction.
    if (!c.rect && !c.testID) continue;

    // Find effective parent in the components array
    var effectiveParent = c.parentIdx;
    while (effectiveParent >= 0 && !(effectiveParent in candidateToComp)) {
      effectiveParent = candidates[effectiveParent].parentIdx;
    }
    var parentCompIdx = effectiveParent >= 0 ? candidateToComp[effectiveParent] : -1;

    // Generalized text dedup: skip ANY component whose display text (text or
    // accLabel) matches its effective parent's display text and has no testID.
    var displayText = c.text || c.accLabel;
    if (displayText && !c.testID && parentCompIdx >= 0) {
      var parentDisplay = components[parentCompIdx].text || components[parentCompIdx].accLabel;
      if (parentDisplay === displayText) continue;
    }

    var entry = { id: components.length, name: c.name, rect: c.rect, parentIdx: parentCompIdx };
    if (c.testID) entry.testID = c.testID;
    if (c.accLabel) entry.accLabel = c.accLabel;
    if (c.text) entry.text = c.text;
    candidateToComp[fi] = components.length;
    components.push(entry);
  }

  var result = { screenW: screenW, screenH: screenH, components: components };
  if (TRACK_SKIPPED) {
    result.totalFibers = totalFibers;
    result.skippedCounts = skippedCounts;
  }
  __argent_callback(JSON.stringify({ requestId: REQUEST_ID, result: JSON.stringify(result) }));
})()`;
}
