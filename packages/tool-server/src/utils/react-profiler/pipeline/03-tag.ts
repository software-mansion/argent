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
// Case-sensitivity alone isn't enough on its own, though: without a trailing
// boundary, a capitalized token that merely trails off into more lowercase
// letters of the SAME word (`MotionlessIndicator`, `AnimationsDisabledBanner`)
// still matches as a bare substring. The lookahead below requires the token be
// followed by another capitalized word, a digit/underscore (`Animated2`,
// `Animated_View`), or end-of-string — closing that gap.
// Deliberately NO leading-boundary requirement: real animation wrapper names
// are routinely acronym-prefixed (`SVGAnimatedPath`, `HTTPTransitionHandler`,
// `IOSMotionView`) where the token is preceded by another capital letter, not
// a lowercase-to-uppercase transition — requiring one caused exactly these to
// stop matching (a false-negative regression caught in review) with no
// corresponding false-positive to justify it.
// This still can't disambiguate a token that legitimately starts its own
// segment in a non-animation compound name (e.g. a sensor component like
// `DeviceMotionListener`) — that would need a semantic allow/deny list, not a
// regex — so that class of false positive remains a known, documented
// limitation.
const ANIMATED_PATTERN = /(Animated|Animation|Transition|Motion)(?=[A-Z0-9_]|$)/;
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
