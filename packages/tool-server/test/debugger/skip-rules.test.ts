import { describe, it, expect } from "vitest";
import { shouldSkip, isHardSkip } from "../../src/utils/debugger/skip-rules";

describe("isHardSkip", () => {
  it("matches HARD_SKIP set entries", () => {
    expect(isHardSkip("BaseTextInput")).toBe(true);
    expect(isHardSkip("ExpoImage")).toBe(true);
    expect(isHardSkip("LottieAnimationView")).toBe(true);
  });

  it("matches AnimatedComponent( prefix", () => {
    expect(isHardSkip("AnimatedComponent(View)")).toBe(true);
    expect(isHardSkip("AnimatedComponent(Text)")).toBe(true);
  });

  it("matches Animated( prefix", () => {
    expect(isHardSkip("Animated(View)")).toBe(true);
    expect(isHardSkip("Animated(ScrollView)")).toBe(true);
  });

  it("matches With*(Component) HOC wrappers", () => {
    expect(isHardSkip("WithNavigationFallback(Button)")).toBe(true);
    expect(isHardSkip("WithToggleVisibilityViewWithRef(BaseLoginForm)")).toBe(true);
  });

  it("matches with*(Component) lowercase HOC wrappers", () => {
    expect(isHardSkip("withTheme(Header)")).toBe(true);
  });

  it("does NOT match short With prefix without parens", () => {
    expect(isHardSkip("WithoutFeedback")).toBe(false);
  });

  it("matches ViewManagerAdapter_", () => {
    expect(isHardSkip("ViewManagerAdapter_RNSScreen")).toBe(true);
  });

  it("does NOT match normal app components", () => {
    expect(isHardSkip("LoginForm")).toBe(false);
    expect(isHardSkip("Button")).toBe(false);
    expect(isHardSkip("ScrollView")).toBe(false);
  });
});

describe("shouldSkip", () => {
  it("returns true for SKIP set entries", () => {
    expect(shouldSkip("View")).toBe(true);
    expect(shouldSkip("RCTView")).toBe(true);
    expect(shouldSkip("StaticContainer")).toBe(true);
    expect(shouldSkip("Pressable")).toBe(true);
  });

  it("returns true for hard-skip entries (superset)", () => {
    expect(shouldSkip("AnimatedComponent(View)")).toBe(true);
    expect(shouldSkip("ExpoImage")).toBe(true);
  });

  it("returns true for __ prefix", () => {
    expect(shouldSkip("__SafeAreaProvider")).toBe(true);
  });

  it("returns true for withDevTools( prefix", () => {
    expect(shouldSkip("withDevTools(App)")).toBe(true);
  });

  it("returns true for Route and Route( prefix", () => {
    expect(shouldSkip("Route")).toBe(true);
    expect(shouldSkip("Route(Home)")).toBe(true);
  });

  it("returns true for main( prefix", () => {
    expect(shouldSkip("main(App)")).toBe(true);
  });

  it("returns true for *Provider suffix", () => {
    expect(shouldSkip("AuthProvider")).toBe(true);
    expect(shouldSkip("ThemeProvider")).toBe(true);
    expect(shouldSkip("ComposeProviders")).toBe(false); // doesn't end with "Provider"
  });

  it("returns true for *Context suffix", () => {
    expect(shouldSkip("AuthContext")).toBe(true);
    expect(shouldSkip("NavigationContext")).toBe(true);
  });

  it("does NOT match short Provider/Context names", () => {
    // "Provider" itself is 8 chars — the rule requires length > 8
    expect(shouldSkip("Provider")).toBe(false);
    // "Context" itself is 7 chars — the rule requires length > 7
    expect(shouldSkip("Context")).toBe(false);
  });

  it("returns true for new Fabric/cross-app SKIP entries", () => {
    expect(shouldSkip("VScrollViewNativeComponent")).toBe(true);
    expect(shouldSkip("InnerScreen")).toBe(true);
    expect(shouldSkip("ScreenStackItem")).toBe(true);
    expect(shouldSkip("BaseNavigationContainer")).toBe(true);
    expect(shouldSkip("NavigationContainerInner")).toBe(true);
    expect(shouldSkip("PlatformPressableInternal")).toBe(true);
  });

  it("does NOT match app-specific components", () => {
    expect(shouldSkip("LoginForm")).toBe(false);
    expect(shouldSkip("SignInPage")).toBe(false);
    expect(shouldSkip("FormAlertWithSubmitButton")).toBe(false);
    expect(shouldSkip("Text")).toBe(false);
    expect(shouldSkip("TextInput")).toBe(false);
  });
});
