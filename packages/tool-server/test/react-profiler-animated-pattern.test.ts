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
});
