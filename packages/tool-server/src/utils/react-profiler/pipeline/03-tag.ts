/**
 * Stage 3: Tag Context
 *
 * Attaches false-positive flags to each component:
 *   isAnimated     — component is part of an animation subtree
 *   isRecyclerChild — component is a FlatList/VirtualizedList item
 *
 * These flags drive filtering in Stage 4: components tagged here are
 * excluded from the ranked findings.
 */
import type { EnrichOutput, TagOutput, TaggedComponent } from "../types/pipeline";

// Match the animation tokens only as genuine PascalCase segments.
//  - Case-sensitive: a lowercase-embedded "motion" (`PromotionCard`,
//    `Emotion`, `Locomotion`) never contains the capitalized token, so it is
//    rejected with no boundary needed.
//  - Leading `(?<![A-Z0-9])` rejects acronym/number-glued prefixes
//    (`SVGAnimatedPath`, `RNAnimatedView`, `G2MotionSensor`) where the token
//    is not a real PascalCase word-start.
//  - Trailing `(?=[A-Z0-9_(.]|$)` requires the token to end a segment: another
//    capitalized word, a digit/underscore, `(` or `.` (paren/dot/HOC-wrapped
//    display names like `Animated(View)`, `Animated.View`,
//    `Memo(AnimatedComponent(View))`), or end-of-string — so it still matches
//    real names while rejecting tokens that bleed into more lowercase
//    (`MotionlessIndicator`).
//  - KNOWN LIMITATION: only acronym/digit-GLUED prefixes (`CMMotionManager`,
//    `G2MotionSensor`) are rejected. A BARE token that starts a PascalCase word
//    still matches even in a non-animation name: `MotionSensor`/`MotionManager`
//    (device motion), and — since `Transition` is also an ordinary word (state
//    machines, phase changes) — `StateTransitionDiagram`, `TransitionMatrix`.
//    The match is unanchored on purpose so real mid-name animation forms are
//    caught (`FadeTransition`, `FadeInAnimation`, `SharedElementTransition`),
//    which makes each over-tag structurally
//    indistinguishable from a genuine animation name of the same shape
//    (`MotionView`, `@legendapp/motion`'s `Motion.View`). This over-tag is
//    accepted collateral: it only excludes a component from perf findings, and a
//    hardcoded denylist would be more fragile than the rare false positive it
//    removes.
const ANIMATED_PATTERN = /(?<![A-Z0-9])(Animated|Animation|Transition|Motion)(?=[A-Z0-9_(.]|$)/;
const RECYCLER_CHILD_PATTERN = /(ListItem|CellItem|Cell|Row|Item)$/i;
const RECYCLER_PARENT_PATTERN =
  /^(FlatList|SectionList|VirtualizedList|FlashList|RecyclerListView)/i;

export function tag(input: EnrichOutput): TagOutput {
  // Collect all component names for recycler-parent lookup
  const allNames = new Set(input.components.keys());

  // Check if any known recycler parent is in the active component set
  const hasRecyclerParent = Array.from(allNames).some((n) => RECYCLER_PARENT_PATTERN.test(n));

  const components = new Map<string, TaggedComponent>();

  for (const [name, comp] of input.components) {
    const isAnimated = ANIMATED_PATTERN.test(name);

    // Tag as recycler child if name matches the suffix pattern AND a recycler
    // parent is present in this recording (makes the heuristic more precise).
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
