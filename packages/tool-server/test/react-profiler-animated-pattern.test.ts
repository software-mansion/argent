import { describe, it, expect } from "vitest";
import { tag } from "../src/utils/react-profiler/pipeline/03-tag";
import { rank } from "../src/utils/react-profiler/pipeline/04-rank";
import type {
  EnrichOutput,
  EnrichedComponent,
  SessionContext,
} from "../src/utils/react-profiler/types/pipeline";
const sessionContext: SessionContext = {
  reactCompilerEnabled: false,
  strictModeEnabled: false,
  buildMode: "dev",
  rnArchitecture: "bridge",
  projectRoot: "/proj",
  platform: "ios",
};
function slow(name: string): EnrichedComponent {
  return {
    name,
    n: 10,
    normalizedRenderCount: 10,
    mean: 20,
    min: 5,
    max: 40,
    totalRenderMs: 200,
    dominantReason: "props",
    topChangedProps: ["data"],
    topChangedHooks: [],
    isCompilerOptimized: false,
    firstCommitTs: 0,
    lastCommitTs: 100,
  };
}
function enrich(names: string[]): EnrichOutput {
  const components = new Map<string, EnrichedComponent>();
  for (const n of names) components.set(n, slow(n));
  return {
    components,
    sessionContext,
    reactCommits: 50,
    fiberRenders: 100,
    anyRuntimeCompilerDetected: false,
    totalFirstMounts: 0,
    firstMountOnlyComponents: [],
    recordingMs: 10_000,
  };
}
describe("ANIMATED_PATTERN matches only real animation segments", () => {
  it("does NOT tag non-animation names containing 'motion' as a substring", () => {
    const tagged = tag(
      enrich(["PromotionCard", "EmotionThemeCard", "CommotionList", "ProductCard"])
    );
    for (const n of ["PromotionCard", "EmotionThemeCard", "CommotionList", "ProductCard"]) {
      expect(tagged.components.get(n)!.isAnimated).toBe(false);
    }
    const ranked = rank(tagged).map((f) => f.component);
    expect(ranked).toContain("PromotionCard");
  });
  it("DOES still tag real animation components", () => {
    const tagged = tag(enrich(["Animated", "AnimatedView", "MotionView", "FadeTransition"]));
    for (const n of ["Animated", "AnimatedView", "MotionView", "FadeTransition"]) {
      expect(tagged.components.get(n)!.isAnimated).toBe(true);
    }
  });
  it("does NOT tag a capitalized token that merely trails into lowercase letters", () => {
    // Case-sensitivity alone isn't a boundary: without one, "MotionlessIndicator"
    // still matches "Motion" as a bare substring, same bug class as the
    // original lowercase false positives.
    const tagged = tag(enrich(["MotionlessIndicator", "AnimationsDisabledBanner"]));
    for (const n of ["MotionlessIndicator", "AnimationsDisabledBanner"]) {
      expect(tagged.components.get(n)!.isAnimated).toBe(false);
    }
  });
  it("DOES still tag real animation components with a digit/underscore suffix", () => {
    // A digit/underscore right after the token is a legitimate PascalCase
    // continuation (numbered/keyed variants) and must still be recognized.
    const names = ["Animated2", "Animated_View", "Motion360Player"];
    const tagged = tag(enrich(names));
    for (const n of names) {
      expect(tagged.components.get(n)!.isAnimated).toBe(true);
    }
  });
  it("does NOT tag a real, non-animation acronym-prefixed name", () => {
    // Without a leading-boundary requirement, an acronym immediately followed
    // by the token (no lowercase-to-uppercase transition) reads as a match
    // with nothing to reject it. CMMotionManager/CMMotionActivity are real
    // Apple CoreMotion SDK class names with nothing to do with animation —
    // a React Native wrapper/bridge component plausibly named after them must
    // not be silently excluded from profiler findings.
    const names = [
      "CMMotionManager",
      "CMMotionActivity",
      "IOMotionSensor",
      "RNMotionDetector",
      "GPSMotionTracker",
    ];
    const tagged = tag(enrich(names));
    for (const n of names) {
      expect(tagged.components.get(n)!.isAnimated).toBe(false);
    }
  });
  it("does NOT tag a digit-suffixed acronym prefix either", () => {
    // The leading boundary must reject digits too, not just uppercase — a
    // digit immediately before the token is the tail of an acronym/model
    // number (G2, IMU2, BLE4, L3), not a real PascalCase word start. Allowing
    // digits here (matching the trailing side's digit allowance) reopened the
    // same CMMotionManager-class false positive with a different acronym shape.
    const names = ["G2MotionSensor", "IMU2MotionTracker", "BLE4MotionBeacon", "L3MotionFilter"];
    const tagged = tag(enrich(names));
    for (const n of names) {
      expect(tagged.components.get(n)!.isAnimated).toBe(false);
    }
  });
});
