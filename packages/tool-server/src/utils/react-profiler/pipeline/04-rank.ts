/** Stage 4: filter, rank and serialize components to ComponentFinding[]. */
import type { TagOutput } from "../types/pipeline";
import type { ComponentFinding, ReRenderReason } from "../types/output";

const ACTIONABLE_REASONS = new Set<ReRenderReason>([
  "parent",
  "props",
  "hooks",
  "context",
  "state",
]);
const MAX_FINDINGS = 20;
const PARETO_THRESHOLD_PCT = 0.005; // 0.5% of recordingMs
const MIN_NORMALIZED_RENDERS = 3;
const MIN_MAX_DURATION_MS = 30;

export function rank(input: TagOutput): ComponentFinding[] {
  const { sessionContext, recordingMs } = input;

  type TaggedComp = typeof input.components extends Map<string, infer V> ? V : never;
  const candidates: Array<{ name: string; comp: TaggedComp }> = [];

  for (const [name, comp] of input.components) {
    if (comp.isAnimated) continue;
    if (comp.isRecyclerChild) continue;
    if (!ACTIONABLE_REASONS.has(comp.dominantReason)) continue;

    const passesRenderCount = comp.normalizedRenderCount >= MIN_NORMALIZED_RENDERS;
    const passesMaxDuration = comp.max >= MIN_MAX_DURATION_MS;
    if (!passesRenderCount && !passesMaxDuration) continue;

    candidates.push({ name, comp });
  }

  candidates.sort((a, b) => b.comp.totalRenderMs - a.comp.totalRenderMs);

  const paretoMin = recordingMs * PARETO_THRESHOLD_PCT;
  const ranked = candidates.filter((c, i) => c.comp.totalRenderMs >= paretoMin || i < MAX_FINDINGS);
  const topCandidates = ranked.slice(0, MAX_FINDINGS);

  const findings: ComponentFinding[] = topCandidates.map(({ name, comp }) => {
    const topChangedHookNames: string[] =
      comp.hookTypeNames !== undefined
        ? comp.topChangedHooks.map((idx) => comp.hookTypeNames![idx] ?? `hook[${idx}]`)
        : [];

    const finding: ComponentFinding = {
      component: name,
      renders: comp.normalizedRenderCount,
      totalMs: Math.round(comp.totalRenderMs * 10) / 10,
      avgMs: Math.round(comp.mean * 100) / 100,
      maxMs: Math.round(comp.max * 100) / 100,
      dominantReason: comp.dominantReason,
      topChangedProps: comp.topChangedProps,
      topChangedHookNames,
    };

    if (comp.isCompilerOptimized) finding.isCompilerOptimized = true;
    if (
      sessionContext.reactCompilerEnabled &&
      !comp.isCompilerOptimized &&
      comp.normalizedRenderCount > 5
    ) {
      finding.compilerBailoutSuspected = true;
    }
    if (comp.parentTrigger !== undefined) finding.parentTrigger = comp.parentTrigger;

    return finding;
  });

  return findings;
}
