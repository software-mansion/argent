import { describe, it, expect } from "vitest";
import {
  stripComponentWrappers,
  annotateComponentName,
  resolveComponentName,
  renderComponentNameMiss,
  astLookupCandidates,
} from "../../src/utils/react-profiler/component-names";

/**
 * Names taken verbatim from a real Expo SDK 54 profiling session (RN 0.81.5,
 * React Compiler on) — the session that produced issue #632. Includes the one
 * genuine collision it contained and a router name whose inner text has
 * parentheses, dots and slashes.
 */
const REAL_SESSION_NAMES = [
  "Forget(ParallaxScrollView)",
  "Forget(Collapsible)",
  "Forget(IconSymbol)",
  "Forget(ThemedText)",
  "Forget(BottomTabItem)",
  "Forget(TabTwoScreen(./(tabs)/explore.tsx))",
  "StaticContainer",
  "Memo(StaticContainer)",
  "Anonymous",
  "Animated(Anonymous)",
  "Animated(View)",
  "View",
  "Context.Provider",
  "InnerScreen",
  "ForwardRef(InnerScreen)",
];

describe("stripComponentWrappers", () => {
  it("strips the three wrappers React DevTools adds, including nested ones", () => {
    expect(stripComponentWrappers("Forget(Foo)").baseName).toBe("Foo");
    expect(stripComponentWrappers("Memo(Foo)").baseName).toBe("Foo");
    expect(stripComponentWrappers("ForwardRef(Foo)").baseName).toBe("Foo");
    expect(stripComponentWrappers("Memo(Forget(Foo))").baseName).toBe("Foo");
    expect(stripComponentWrappers("Forget(Memo(ForwardRef(Memo(Deep))))").baseName).toBe("Deep");
  });

  it("handles an inner name containing parens, dots and slashes", () => {
    // expo-router names a screen after its file, so the greedy anchored match
    // must not stop at the first inner ")".
    expect(stripComponentWrappers("Forget(TabTwoScreen(./(tabs)/explore.tsx))").baseName).toBe(
      "TabTwoScreen(./(tabs)/explore.tsx)"
    );
  });

  it("leaves wrappers the report never strips alone", () => {
    // Stripping these would make a query for `View` ambiguous in almost every
    // session, and no agent ever holds a stripped form of them.
    for (const n of ["Animated(View)", "AnimatedComponent(View)", "Motion(View)", "Anonymous"]) {
      expect(stripComponentWrappers(n).baseName).toBe(n);
    }
    expect(stripComponentWrappers("Context.Provider").baseName).toBe("Context.Provider");
  });

  it("reports which wrappers were present", () => {
    const s = stripComponentWrappers("Memo(Forget(Foo))");
    expect(s.hasMemo).toBe(true);
    expect(s.hasForget).toBe(true);
    expect(s.hasForwardRef).toBe(false);
  });
});

describe("annotateComponentName", () => {
  it("keeps the tag wording and ordering the report has always used", () => {
    expect(annotateComponentName("Forget(Foo)")).toEqual({
      displayName: "Foo",
      tag: " [React Compiler]",
      rawName: "Forget(Foo)",
    });
    expect(annotateComponentName("Memo(Forget(ForwardRef(Foo)))").tag).toBe(
      " [React.memo + React Compiler + forwardRef]"
    );
    expect(annotateComponentName("View").tag).toBe("");
  });
});

describe("resolveComponentName", () => {
  it("resolves the display name the report prints — the issue", () => {
    const r = resolveComponentName("ParallaxScrollView", REAL_SESSION_NAMES);
    expect(r.kind).toBe("display");
    expect(r.kind === "display" && r.rawName).toBe("Forget(ParallaxScrollView)");
  });

  it("still resolves the raw name unchanged", () => {
    const r = resolveComponentName("Forget(ParallaxScrollView)", REAL_SESSION_NAMES);
    expect(r.kind).toBe("exact");
    expect(r.kind === "exact" && r.rawName).toBe("Forget(ParallaxScrollView)");
  });

  it("lets an exact match win over a wrapped sibling, and never widens it", () => {
    // Both `StaticContainer` and `Memo(StaticContainer)` were recorded in one
    // real session. Asking for the bare one must return the bare one.
    const r = resolveComponentName("StaticContainer", REAL_SESSION_NAMES);
    expect(r.kind).toBe("exact");
    expect(r.kind === "exact" && r.rawName).toBe("StaticContainer");
    // ...but the caller is told the other fiber exists, instead of silently
    // seeing one of two.
    expect(r.kind === "exact" && r.alsoMatching).toEqual(["Memo(StaticContainer)"]);
  });

  it("does not cross-resolve one wrapper into another", () => {
    // Matching on the recorded name's DISPLAY form (not a stripped query)
    // means asking for a Forget() fiber never silently returns a Memo() one.
    const r = resolveComponentName("Forget(StaticContainer)", REAL_SESSION_NAMES);
    expect(r.kind).toBe("missing");
  });

  it("does not resolve a non-stripped wrapper from its inner name", () => {
    const r = resolveComponentName("View", REAL_SESSION_NAMES);
    expect(r.kind).toBe("exact");
    expect(r.kind === "exact" && r.rawName).toBe("View");
    // `Animated(View)` is a different component and must not be pulled in.
    expect(r.kind === "exact" && r.alsoMatching).toEqual([]);
  });

  it("refuses rather than merging when several fibers share a display name", () => {
    const names = ["Memo(Widget)", "ForwardRef(Widget)"];
    const r = resolveComponentName("Widget", names);
    expect(r.kind).toBe("ambiguous");
    expect(r.kind === "ambiguous" && r.candidates.sort()).toEqual([
      "ForwardRef(Widget)",
      "Memo(Widget)",
    ]);
  });

  it("reports a miss with re-queryable suggestions", () => {
    const r = resolveComponentName("ParallaxScroll", REAL_SESSION_NAMES);
    expect(r.kind).toBe("missing");
    expect(r.kind === "missing" && r.suggestions).toContain("Forget(ParallaxScrollView)");
  });
});

describe("renderComponentNameMiss", () => {
  it("hands back exact strings to retry with on an ambiguity", () => {
    const r = resolveComponentName("Widget", ["Memo(Widget)", "ForwardRef(Widget)"]);
    const out = renderComponentNameMiss(r as never);
    expect(out).toContain("ambiguous");
    expect(out).toContain("`Memo(Widget)`");
    expect(out).toContain("`ForwardRef(Widget)`");
    expect(out).toContain("are not merged");
  });

  it("quantifies the session so a miss can be told from an empty capture", () => {
    const r = resolveComponentName("Nope", REAL_SESSION_NAMES);
    const out = renderComponentNameMiss(r as never, { fiberRenders: 313, commits: 16 });
    expect(out).toContain("313 fiber renders across 16 commits");
    expect(out).toContain("profiler-commit-query");
  });
});

describe("astLookupCandidates", () => {
  it("offers the bare source identifier for a wrapped name", () => {
    expect(astLookupCandidates("Forget(IconSymbol)")).toEqual(["Forget(IconSymbol)", "IconSymbol"]);
  });

  it("offers the declared identifier for an expo-router screen name", () => {
    // The report shows `TabTwoScreen(./(tabs)/explore.tsx)`; the source declares
    // `export default function TabTwoScreen()`.
    expect(astLookupCandidates("Forget(TabTwoScreen(./(tabs)/explore.tsx))")).toEqual([
      "Forget(TabTwoScreen(./(tabs)/explore.tsx))",
      "TabTwoScreen(./(tabs)/explore.tsx)",
      "TabTwoScreen",
    ]);
  });

  it("does not invent variants for a plain name", () => {
    expect(astLookupCandidates("IconSymbol")).toEqual(["IconSymbol"]);
  });

  it("only drops a suffix when what remains is a valid identifier", () => {
    expect(astLookupCandidates("Context.Provider")).toEqual(["Context.Provider"]);
  });
});
