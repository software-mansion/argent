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
// `EmotionThemeCard`, or `CommotionList` only contain a lowercase "motion".
// Case-sensitivity alone isn't enough: without a boundary, a capitalized token
// that merely trails off into lowercase letters (`MotionlessIndicator`,
// `AnimationsDisabledBanner`) still matches. Anchor the token to a PascalCase
// segment boundary — start-of-string or preceded by a lowercase/digit (i.e. a
// new capitalized word starting), and followed by another capitalized word or
// end-of-string. This still can't disambiguate a token that legitimately
// starts its own segment in a non-animation compound name (e.g. a sensor
// component like `DeviceMotionListener`) — that would need a semantic
// allow/deny list, not a regex — but it closes the trailing-continuation gap
// the case-only fix left open.
const ANIMATED_PATTERN = /(?:^|(?<=[a-z0-9]))(Animated|Animation|Transition|Motion)(?=[A-Z]|$)/;
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
