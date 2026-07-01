/**
 * Stage 3: Tag Context
 *
 * Attaches false-positive flags to each component:
 *   isAnimated     — component is part of an animation subtree
 *   isRecyclerChild — component is a FlatList/VirtualizedList item
 *
 * These flags drive filtering in Stage 4. Components tagged here are
 * excluded from findings and recorded in IssueReport.excluded.
 */
import type { EnrichOutput, TagOutput, TaggedComponent } from "../types/pipeline";

// Match the animation tokens only as genuine PascalCase segments, not as
// lowercase substrings. Real RN animation component names are PascalCase and
// contain a capitalized token (`Animated`, `AnimatedView`, `MotionView`,
// `FadeTransition`), whereas ordinary names like `PromotionCard`,
// `EmotionThemeCard`, or `CommotionList` only contain a lowercase "motion" —
// case-sensitivity alone (no boundary needed) already rejects those, since the
// capitalized token literally doesn't appear as a substring.
//
// Two boundaries close the remaining gaps:
//  - TRAILING: without one, a capitalized token that merely trails into more
//    lowercase letters of the SAME word (`MotionlessIndicator`,
//    `AnimationsDisabledBanner`) still matches as a bare substring. Requiring
//    the token be followed by another capitalized word, a digit/underscore
//    (`Animated2`, `Animated_View`, `Motion360Player`), or end-of-string closes
//    that gap without losing real digit/underscore-suffixed names.
//  - LEADING: without one, an acronym prefix immediately followed by the
//    token (`CMMotionManager`, `CMMotionActivity` — real Apple CoreMotion SDK
//    class names, nothing to do with animation) reads as a match with no
//    boundary at all to reject it. Requiring the token be preceded by a
//    LOWERCASE letter (a genuine PascalCase word-start) or start-of-string
//    closes that off. Deliberately NOT digits here — unlike the trailing
//    side, a digit immediately before the token (`G2MotionSensor`,
//    `IMU2MotionTracker`) is itself the tail of an acronym/model-number
//    prefix, not a real word boundary, and allowing it reopened the same
//    false-positive class with a different-shaped acronym. The cost of the
//    leading boundary: a few acronym-prefixed *animation* names (e.g. a
//    hypothetical `SVGAnimatedPath`) also stop matching — accepted, since
//    silently excluding a real non-animation component (a false positive)
//    hides a real perf finding entirely with no trace, the more severe
//    failure mode of the two.
//
// Neither boundary can disambiguate a token that legitimately starts its own
// segment in a non-animation compound name where the PRECEDING char actually
// is lowercase (e.g. a sensor component like `DeviceMotionListener`, or
// `SubMotion`) — that would need a semantic allow/deny list, not a regex — so
// that narrower class of false positive remains a known, documented
// limitation.
const ANIMATED_PATTERN = /(?:^|(?<=[a-z]))(Animated|Animation|Transition|Motion)(?=[A-Z0-9_]|$)/;
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
