/**
 * Stage 3: name-based false-positive flags. Stage 4 drops flagged components
 * from the ranked findings.
 */
import type { EnrichOutput, TagOutput, TaggedComponent } from "../types/pipeline";

// Case-sensitive, so a lowercase-embedded token (`PromotionCard`) never matches.
// The lookbehind rejects acronym/digit-glued prefixes (`SVGAnimatedPath`,
// `G2MotionSensor`); the lookahead requires the token to end a PascalCase segment,
// rejecting `MotionlessIndicator` while still allowing `Animated.View` and
// `Memo(AnimatedComponent(View))`.
// Bare tokens still over-tag ordinary names (`MotionSensor`, `TransitionMatrix`):
// accepted, because the match must stay unanchored to catch `FadeTransition`, and
// the only cost is excluding a component from perf findings.
const ANIMATED_PATTERN = /(?<![A-Z0-9])(Animated|Animation|Transition|Motion)(?=[A-Z0-9_(.]|$)/;
const RECYCLER_CHILD_PATTERN = /(ListItem|CellItem|Cell|Row|Item)$/i;
const RECYCLER_PARENT_PATTERN =
  /^(FlatList|SectionList|VirtualizedList|FlashList|RecyclerListView)/i;

export function tag(input: EnrichOutput): TagOutput {
  const allNames = new Set(input.components.keys());

  const hasRecyclerParent = Array.from(allNames).some((n) => RECYCLER_PARENT_PATTERN.test(n));

  const components = new Map<string, TaggedComponent>();

  for (const [name, comp] of input.components) {
    const isAnimated = ANIMATED_PATTERN.test(name);

    // Suffix alone over-matches; require a recycler parent in the same recording.
    const isRecyclerChild = RECYCLER_CHILD_PATTERN.test(name) && hasRecyclerParent;

    components.set(name, {
      ...comp,
      isAnimated,
      isRecyclerChild,
    });
  }

  return {
    components,
    sessionContext: input.sessionContext,
    reactCommits: input.reactCommits,
    fiberRenders: input.fiberRenders,
    anyRuntimeCompilerDetected: input.anyRuntimeCompilerDetected,
    totalFirstMounts: input.totalFirstMounts,
    firstMountOnlyComponents: input.firstMountOnlyComponents,
    recordingMs: input.recordingMs,
  };
}
