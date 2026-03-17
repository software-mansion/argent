/**
 * Shared skip-rule logic for filtering React Native component names.
 *
 * Used by the TypeScript layer (inspect-element pruning). The JS-side script
 * (component-tree.ts) maintains its own copy of these rules because it runs
 * inside the app's JS runtime, not in Node.
 */

const HARD_SKIP_SET = new Set([
  "BaseTextInput",
  "InternalTextInput",
  "RNTextInputWithRef",
  "RCTSinglelineTextInputView",
  "RCTMultilineTextInputView",
  "LottieAnimationView",
  "Lottie",
  "ExpoImage",
]);

const SKIP_SET = new Set([
  "View",
  "RCTView",
  "RCTText",
  "RCTScrollView",
  "RCTScrollContentView",
  "RCTImageView",
  "RCTSafeAreaView",
  "RCTVirtualText",
  "RCTSinglelineTextInputView",
  "RCTMultilineTextInputView",
  "RNCSafeAreaProvider",
  "RNSScreen",
  "RNSScreenStack",
  "RNSScreenContentWrapper",
  "RNSScreenNavigationContainer",
  "RNSScreenStackHeaderConfig",
  "ScreenStackHeaderConfig",
  "NavigationContent",
  "NavigationStateListenerProvider",
  "PreventRemoveProvider",
  "EnsureSingleNavigator",
  "StaticContainer",
  "SceneView",
  "NativeStackView",
  "NativeStackNavigator",
  "DelayedFreeze",
  "Freeze",
  "Suspender",
  "DebugContainer",
  "ScreenContentWrapper",
  "Screen",
  "ScreenStack",
  "ScreenContainer",
  "MaybeScreenContainer",
  "MaybeScreen",
  "FrameSizeProvider",
  "FrameSizeProviderInner",
  "FrameSizeListenerNativeFallback",
  "SafeAreaProviderCompat",
  "SafeAreaProvider",
  "SafeAreaInsetsContext",
  "SafeArea",
  "SafeAreaFrameContext",
  "ErrorOverlay",
  "ErrorToastContainer",
  "PerformanceLoggerContext",
  "AppContainer",
  "RootTagContext",
  "DebuggingOverlay",
  "DebuggingOverlayRegistrySubscription",
  "LogBoxStateSubscription",
  "_LogBoxNotificationContainer",
  "LogBoxInspectorContainer",
  "LogBoxInspector",
  "LogBoxInspectorCodeFrame",
  "CellRenderer",
  "VirtualizedListContextProvider",
  "VirtualizedListCellContextProvider",
  "wrapper",
  "Background",
  "Pressable",
  "PlatformPressable",
  "ExpoRoot",
  "ContextNavigator",
  "RootApp",
  "ThemeProvider",
  "StatusBar",
  "ReactNativeProfiler",
  "FeedbackWidgetProvider",
  "NavigationRouteContext",
  "BottomTabNavigator",
  "BottomTabView",
  "TabBarIcon",
  "Icon",
  "MissingIcon",
  "Label",
  "ImageAnalyticsTagContext",
  "Image",
  "RootLayout",
  "TabLayout",
  "GestureHandlerRootView",
  "GestureDetector",
  "Wrap",
  "RenderRegistryProvider",
  "SharedPropsProvider",
  "ListStyleSpecsProvider",
  "RenderersPropsProvider",
  "TRenderEngineProvider",
  "RenderHTMLConfigProvider",
  "RenderHtmlSource",
  "RawSourceLoader",
  "SourceLoaderInline",
  "RenderTTree",
  "TNodeChildrenRenderer",
  "MemoizedTNodeRenderer",
  "PortalProviderComponent",
  "KeyboardProviderWrapper",
  "KeyboardProvider",
  "KeyboardControllerView",
  "ScrollViewContext",
  "TextAncestorContext",
  "TextInputLabel",
  "ThemeContext",
  "BaseHTMLEngineProvider",
  // Fabric / cross-app entries
  "VScrollViewNativeComponent",
  "InnerScreen",
  "ScreenStackItem",
  "BaseNavigationContainer",
  "NavigationContainerInner",
  "PlatformPressableInternal",
]);

export function isHardSkip(name: string): boolean {
  if (HARD_SKIP_SET.has(name)) return true;
  if (name.startsWith("AnimatedComponent(")) return true;
  if (name.startsWith("Animated(")) return true;
  if (name.startsWith("With") && name.indexOf("(") > 3) return true;
  if (name.startsWith("with") && name.indexOf("(") > 3) return true;
  if (name.includes("ViewManagerAdapter_")) return true;
  return false;
}

export function shouldSkip(name: string): boolean {
  if (isHardSkip(name)) return true;
  if (SKIP_SET.has(name)) return true;
  if (name.startsWith("__")) return true;
  if (name.startsWith("withDevTools(")) return true;
  if (name === "Route" || name.startsWith("Route(")) return true;
  if (name.startsWith("main(")) return true;
  if (name.length > 8 && name.endsWith("Provider")) return true;
  if (name.length > 7 && name.endsWith("Context")) return true;
  return false;
}
