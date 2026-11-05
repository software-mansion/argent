/**
 * Stage 05-render: HotCommitSummary[] + ComponentFinding[] -> markdown.
 *
 * Writes the full report to debugDir/react-profiler-report.md; returns a copy capped to
 * the top 10 hot commits by totalRenderMs for the inline response.
 *
 * Commits are labeled with the most recent prior annotation, with no time cutoff, so a
 * long gap still shows causality.
 */
import { promises as fs } from "fs";
import { join } from "path";
import type { HotCommitSummary, ComponentFinding } from "../types/output";
import type { SessionContext } from "../types/pipeline";
import { annotateComponentName } from "../component-names";
import {
  COMMIT_TIME_SHARE_FLOOR,
  commitTimeShare,
  formatCommitTime,
  formatCount,
  formatRenderSummaryReason,
  formatShare,
  hasUnnamedSlowCommit,
  isCommitTimeAboveFloor,
  selectFrequentRerenders,
  type FrequentRerenderRow,
  type RenderSummary,
} from "../render-summary";
import { createComponentOriginClassifier, type ComponentOriginResult } from "../component-origin";

const MAX_INLINE_COMMITS = 10;
const REPORT_FILENAME = "react-profiler-report.md";

interface RenderInput {
  hotCommitSummaries: HotCommitSummary[];
  componentFindings: ComponentFinding[];
  sessionContext: SessionContext;
  recordingMs: number;
  anyRuntimeCompilerDetected: boolean;
  reactCommits: number;
  annotations?: Array<{ offsetMs: number; label: string }>;
  debugDir: string;
  allClear?: boolean;
  maxCommitMs?: number;
  /** Counts over all commits; null/undefined for sessions saved before stop wrote it. */
  renderSummary?: RenderSummary | null;
  /** Library-vs-app guess for frequent re-render rows; name-only when omitted. */
  componentOrigin?: (rawName: string) => ComponentOriginResult;
}

interface RenderOutput {
  report: string;
  reportFile: string | null;
  hotCommitsTotal: number;
  hotCommitsShown: number;
}

export async function renderProfilingReport(input: RenderInput): Promise<RenderOutput> {
  const reportFile = join(input.debugDir, REPORT_FILENAME);

  if (input.allClear) {
    const maxMs = input.maxCommitMs ?? 0;
    const report = renderAllClear(input, maxMs);
    const wroteFile = await writeReport(reportFile, report);
    return {
      report,
      reportFile: wroteFile ? reportFile : null,
      hotCommitsTotal: 0,
      hotCommitsShown: 0,
    };
  }

  // Only non-margin commits count as "hot" for the cap and total
  const hotCommits = input.hotCommitSummaries.filter((s) => !s.isMargin);
  const hotCommitsTotal = hotCommits.length;

  if (hotCommitsTotal === 0) {
    const report = renderAllClear(input, 0);
    const wroteFile = await writeReport(reportFile, report);
    return {
      report,
      reportFile: wroteFile ? reportFile : null,
      hotCommitsTotal: 0,
      hotCommitsShown: 0,
    };
  }

  const annotations = (input.annotations ?? []).slice().sort((a, b) => a.offsetMs - b.offsetMs);

  const fullMarkdown = buildFullMarkdown(input, annotations, hotCommitsTotal);

  const topHotByMs = hotCommits
    .slice()
    .sort((a, b) => b.totalRenderMs - a.totalRenderMs)
    .slice(0, MAX_INLINE_COMMITS);
  const topHotIndices = new Set(topHotByMs.map((s) => s.commitIndex));

  // Keep a margin commit only when it neighbours a hot commit that is shown
  const cappedSummaries = input.hotCommitSummaries.filter((s) => {
    if (!s.isMargin) return topHotIndices.has(s.commitIndex);
    return topHotIndices.has(s.commitIndex - 1) || topHotIndices.has(s.commitIndex + 1);
  });

  const hotCommitsShown = Math.min(hotCommitsTotal, MAX_INLINE_COMMITS);
  const cappedMarkdown = buildFullMarkdown(
    { ...input, hotCommitSummaries: cappedSummaries },
    annotations,
    hotCommitsTotal
  );

  const wroteFile = await writeReport(reportFile, fullMarkdown);
  let report = cappedMarkdown;
  if (hotCommitsTotal > MAX_INLINE_COMMITS && wroteFile) {
    report += `\n\n> Full analysis: \`${reportFile}\` — use the Read tool to browse all ${hotCommitsTotal} hot commits.\n`;
  }

  return { report, reportFile: wroteFile ? reportFile : null, hotCommitsTotal, hotCommitsShown };
}

function commitTimeLine(summary: RenderSummary): string {
  return `**React commit time:** ${formatCommitTime(summary)}`;
}

const FLOOR_PCT = Math.round(COMMIT_TIME_SHARE_FLOOR * 100);

function renderAllClear(input: RenderInput, maxMs: number): string {
  const durationS = (input.recordingMs / 1000).toFixed(1);
  const compilerLine = renderCompilerStatus(
    input.sessionContext.reactCompilerEnabled,
    input.anyRuntimeCompilerDetected
  );
  const summary = input.renderSummary ?? null;
  const maxNote = maxMs > 0 ? ` (peak commit: ${maxMs.toFixed(1)}ms)` : "";
  const lines = [
    `# Profiling Analysis — ${durationS}s session`,
    `${compilerLine}  **Hot commits:** 0 of ${input.reactCommits} total`,
  ];
  if (summary) lines.push(commitTimeLine(summary));
  lines.push(``);

  if (summary && (isCommitTimeAboveFloor(summary) || hasUnnamedSlowCommit(summary))) {
    lines.push(...renderNoHotCommitsWarning(input, summary, maxNote));
    return lines.join("\n");
  }

  lines.push(`✅ **All clear** — all React commits were below 16ms${maxNote}.`);
  if (summary) {
    lines.push(
      `React spent ${formatShare(commitTimeShare(summary))} of the session in commits, below the ${FLOOR_PCT}% at which frequent cheap re-renders are worth chasing. No performance issues detected in this session.`
    );
  } else {
    lines.push(`No performance issues detected in this session.`);
    lines.push(``);
    lines.push(
      `> This session was saved without a render summary (an older tool-server), so commits under 16ms were not measured: many cheap re-renders can still add up. Re-profile to measure them.`
    );
  }
  lines.push(
    ``,
    `---`,
    `## Suggested Improvements`,
    ``,
    `No performance hotspots found. Consider these proactive checks:`,
    ``,
    `- Re-profile under heavier load (longer interaction, more data) to catch issues that don't appear in short sessions.`
  );
  if (summary && summary.totalCommits > 0) {
    lines.push(
      `- \`profiler-commit-query\` mode=\`render_counts\` lists each component's render count over all ${formatCount(summary.totalCommits)} commits. At this share, high counts alone are not worth optimizing.`
    );
  }
  return lines.join("\n");
}

/**
 * No hot commit, yet the session is not all clear: React spent at least
 * COMMIT_TIME_SHARE_FLOOR of it committing, or a commit reached 16ms with no
 * named component in it.
 */
function renderNoHotCommitsWarning(
  input: RenderInput,
  summary: RenderSummary,
  maxNote: string
): string[] {
  const share = formatShare(commitTimeShare(summary));
  const lines = [
    hasUnnamedSlowCommit(summary)
      ? `⚠️ **Slow commit with no component names** — the slowest commit took ${summary.maxCommitMs.toFixed(1)}ms, but none of its components could be named, so it has no breakdown. React spent ${share} of the session in commits.`
      : `⚠️ **No slow commit, but React was busy** — every commit stayed below 16ms${maxNote}, yet React spent ${share} of the session in commits. Many cheap renders add up.`,
    ``,
  ];
  const aboveFloor = isCommitTimeAboveFloor(summary);
  const rows = aboveFloor
    ? selectFrequentRerenders(
        summary,
        input.componentOrigin ?? createComponentOriginClassifier(null)
      )
    : [];
  if (aboveFloor) {
    lines.push(`---`, `## Frequent Re-renders`, ``);
    if (rows.length > 0) {
      lines.push(
        `App components that re-rendered at least once per second, by self time per second, over all ${formatCount(summary.totalCommits)} commits. React Native primitives, list internals, animation wrappers, providers and dev-only components are left out; \`profiler-commit-query\` mode=\`render_counts\` lists every component.`,
        ``,
        `| Component | Re-renders | Per second | Self ms/s | Self total | Reason | File |`,
        `|---|---|---|---|---|---|---|`
      );
      for (const row of rows) lines.push(renderFrequentRow(row));
    } else if (summary.components.length > 0) {
      lines.push(
        `No app component re-rendered at least once per second at a measurable cost: the time is in mounts or in library components. \`profiler-commit-query\` mode=\`render_counts\` lists every component.`
      );
    } else {
      lines.push(`No component in this session could be named, so there is nothing to list.`);
    }
    lines.push(``);
  }
  lines.push(
    `---`,
    `## Next Steps`,
    ``,
    `Ask the user which path to take:`,
    ``,
    `1. **Investigate further** — \`profiler-commit-query\` mode=\`render_counts\` for every component's counts, or \`profiler-cpu-query\` mode=\`top_functions\` for the JS work behind them.`
  );
  if (rows.length > 0) {
    lines.push(
      `2. **Implement fixes** — cut how often the top rows re-render (the Reason column names what changes each time, e.g. a timer or animation kept in React state), then re-profile the same scenario and compare the React commit time.`,
      `3. **Done for now** — save the report for reference.`
    );
  } else {
    lines.push(`2. **Done for now** — save the report for reference.`);
  }
  return lines;
}

function renderFrequentRow(row: FrequentRerenderRow): string {
  const c = row.component;
  const ann = annotateComponentName(c.name);
  const file =
    row.origin.file !== undefined
      ? `\`${shortenPath(row.origin.file)}${row.origin.line !== undefined ? `:${row.origin.line}` : ""}\``
      : "—";
  return (
    `| \`${ann.displayName}\`${ann.tag} | ${formatCount(c.rerenders)} | ${row.perSecond.toFixed(1)} | ` +
    `${row.selfMsPerSecond.toFixed(1)} | ${c.rerenderSelfMs.toFixed(1)}ms | ${formatRenderSummaryReason(c)} | ${file} |`
  );
}

function renderCompilerStatus(enabled: boolean, detectedAtRuntime: boolean): string {
  if (enabled && detectedAtRuntime) return "**React Compiler:** ✓";
  if (enabled && !detectedAtRuntime)
    return "**React Compiler:** ⚠️ configured but not detected at runtime";
  if (!enabled && detectedAtRuntime) return "**React Compiler:** ✓ (detected at runtime)";
  return "**React Compiler:** ✗";
}

function buildFullMarkdown(
  input: RenderInput,
  annotations: Array<{ offsetMs: number; label: string }>,
  totalHotCommits: number
): string {
  const { sessionContext, recordingMs, anyRuntimeCompilerDetected } = input;
  const durationS = (recordingMs / 1000).toFixed(1);
  const compilerLine = renderCompilerStatus(
    sessionContext.reactCompilerEnabled,
    anyRuntimeCompilerDetected
  );
  const lines: string[] = [
    `# Profiling Analysis — ${durationS}s session`,
    `${compilerLine}  **Hot commits:** ${totalHotCommits} of ${input.reactCommits} total`,
    ...(input.renderSummary ? [commitTimeLine(input.renderSummary)] : []),
    ``,
    `> **Duration columns:** \`self\` = this component's own render work only (exclusive).`,
    `> \`w/children\` = self + the entire subtree it owns (inclusive).`,
    `> Do not sum the \`w/children\` column — a parent's inclusive time already contains its`,
    `> children's time. Use \`self\` for summing; use \`w/children\` to understand container cost.`,
    ``,
    `---`,
    `## Slow React Batches`,
    ``,
  ];

  for (const summary of input.hotCommitSummaries) {
    lines.push(...renderCommit(summary, annotations, sessionContext));
    lines.push("");
  }

  if (input.componentFindings.length > 0) {
    lines.push("---");
    lines.push("## Top Components by Total Render Cost");
    lines.push("");
    // Total/Avg/Max and the first count cover only the commits kept above; the
    // second count is from the all-commit summary, so a component re-rendering
    // cheaply between slow commits is not under-counted (6 of 50 on Bluesky).
    const renderSummary = input.renderSummary ?? null;
    const allRerenders = renderSummary
      ? new Map(renderSummary.components.map((c) => [c.name, c.rerenders]))
      : null;
    if (renderSummary) {
      lines.push(
        `> \`Renders\` = re-renders in the commits above (hot and ±1 neighbours, which Total/Avg/Max cover) / re-renders in all ${formatCount(renderSummary.totalCommits)} commits.`
      );
      lines.push("");
    }
    lines.push("| Component | Renders | Total | Avg | Max | Reason | File |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const f of input.componentFindings) {
      const file = f.sourceLocation
        ? `\`${shortenPath(f.sourceLocation.file)}:${f.sourceLocation.line}\``
        : "—";
      const reasonStr = formatReason(f.dominantReason, f.topChangedProps, f.topChangedHookNames);
      const compilerFlag = f.compilerBailoutSuspected ? " ⚠️" : f.isCompilerOptimized ? " ✓" : "";
      const ann = annotateComponentName(f.component);
      const all = allRerenders?.get(f.component);
      const renders = all !== undefined ? `${f.renders} / ${formatCount(all)}` : `${f.renders}`;
      lines.push(
        `| \`${ann.displayName}\`${ann.tag}${compilerFlag} | ${renders} | ${f.totalMs}ms | ${f.avgMs}ms | ${f.maxMs}ms | ${reasonStr} | ${file} |`
      );
    }

    if (sessionContext.reactCompilerEnabled && !anyRuntimeCompilerDetected) {
      lines.push("");
      lines.push(
        "> ⚠️ React Compiler configured but no compiled components found at runtime. " +
          "Check babel plugin ordering, React version compatibility, or run `npx react-compiler-healthcheck`."
      );
    }
  }

  const suggestionsSection = renderSuggestedImprovements(
    input.componentFindings,
    sessionContext.reactCompilerEnabled
  );
  if (suggestionsSection) {
    lines.push(suggestionsSection);
  }

  if (sessionContext.buildMode === "dev") {
    lines.push("");
    lines.push(
      "> 📝 Dev mode renders are ~3× slower than production. Divide ms values by ~3 for a rough production estimate."
    );
  }

  lines.push("");
  lines.push("---");
  lines.push("## Next Steps");
  lines.push("");
  lines.push("Ask the user which path to take:");
  lines.push("");
  lines.push(
    "1. **Investigate further** — use query tools to drill into specific findings before making changes:"
  );
  if (input.hotCommitSummaries.length > 0) {
    const worstCommit = input.hotCommitSummaries
      .filter((s) => !s.isMargin)
      .sort((a, b) => b.totalRenderMs - a.totalRenderMs)[0];
    if (worstCommit) {
      lines.push(
        `   - \`profiler-commit-query\` mode=\`by_index\` commit_index=${worstCommit.commitIndex} — full breakdown of the slowest commit`
      );
    }
  }
  if (input.componentFindings.length > 0) {
    const topComp = input.componentFindings[0]!;
    lines.push(
      `   - \`profiler-cpu-query\` mode=\`component_cpu\` component_name=\`${topComp.component}\` — CPU activity during this component's renders`
    );
    lines.push(
      `   - \`profiler-cpu-query\` mode=\`call_tree\` — trace callers/callees of hot functions`
    );
  }
  lines.push(
    "2. **Implement fixes** — apply changes to the top offenders identified above, then re-profile the same scenario to measure improvement."
  );
  lines.push("3. **Done for now** — save the report for reference.");

  return lines.join("\n");
}

function renderCommit(
  summary: HotCommitSummary,
  annotations: Array<{ offsetMs: number; label: string }>,
  _sessionContext: SessionContext
): string[] {
  const relativeMs = Math.max(0, summary.timestampMs);
  const relativeS = (relativeMs / 1000).toFixed(1);
  const tierEmoji = summary.tier === "hot" ? "🔴" : summary.tier === "warm" ? "🟡" : "🔵";

  let header: string;
  if (summary.isMargin) {
    header = `### Commit #${summary.commitIndex} — ${summary.totalRenderMs}ms ${tierEmoji} (t=${relativeS}s, margin)`;
  } else {
    header = `### Commit #${summary.commitIndex} — ${summary.totalRenderMs}ms ${tierEmoji} (t=${relativeS}s)`;
  }

  const lines: string[] = [header];

  const annotation = findPriorAnnotation(annotations, relativeMs);
  if (annotation) {
    const deltaSec = ((relativeMs - annotation.offsetMs) / 1000).toFixed(1);
    lines.push(`> After: "${annotation.label}" (${deltaSec}s prior)`);
  }

  if (summary.tier === "warm" && !summary.isMargin) {
    lines.push("> 🟡 May be acceptable in production (dev mode is ~3× slower)");
  }

  lines.push("");

  if (!summary.isMargin) {
    if (summary.isInitialRender) {
      const mountCount = summary.components.filter((c) => c.isFirstMount).length;
      const totalMount =
        summary.totalComponentCount > summary.components.length
          ? summary.totalComponentCount
          : mountCount;
      lines.push(
        `**Initial render:** ${totalMount} component${totalMount !== 1 ? "s" : ""} mounted`
      );
      lines.push("");
      lines.push("Mount cascade:");
    } else if (summary.rootCauseComponent) {
      const rootLine = formatRootCauseLine(summary);
      lines.push(`**Root cause:** ${rootLine}`);
      lines.push("");
      lines.push("Render cascade:");
    }
  }

  for (const comp of summary.components) {
    const ann = annotateComponentName(comp.name);
    const countSuffix = comp.count > 1 ? ` ×${comp.count}` : "";
    let reasonStr: string;
    if (comp.isFirstMount) {
      reasonStr = " — (mount)";
    } else if (comp.reason) {
      reasonStr = ` — ${formatReason(comp.reason, comp.topChangedProps, comp.topChangedHookNames)}`;
    } else {
      reasonStr = "";
    }
    lines.push(
      `- \`${ann.displayName}\`${ann.tag}${countSuffix} — ${comp.selfDurationMs}ms self, ${comp.actualDurationMs}ms w/children${reasonStr}`
    );
  }

  if (summary.totalComponentCount > summary.components.length) {
    const remaining = summary.totalComponentCount - summary.components.length;
    lines.push(`- _... and ${remaining} more_`);
  }

  // Coverage tells the agent whether the truncated tail is worth drilling into
  const shownSelfMs = summary.components.reduce((s, c) => s + c.selfDurationMs, 0);
  const roundedShown = Math.round(shownSelfMs * 10) / 10;
  const coveragePct =
    summary.totalRenderMs > 0 ? Math.round((shownSelfMs / summary.totalRenderMs) * 100) : 0;
  const hiddenCount =
    (summary.totalComponentCount ?? summary.components.length) - summary.components.length;

  if (hiddenCount > 0) {
    lines.push(
      `- _Shown: ${roundedShown}ms self / ${summary.totalRenderMs}ms commit (${coveragePct}%) — ` +
        `${hiddenCount} more components not shown. Use ` +
        `\`profiler-commit-query mode=by_index commit_index=${summary.commitIndex}\` to see all._`
    );
  } else if (coveragePct < 80) {
    lines.push(
      `- _Shown: ${roundedShown}ms self / ${summary.totalRenderMs}ms commit (${coveragePct}% explained by self-time — remainder is native/layout work outside JS)_`
    );
  }

  if (summary.unattributedMs !== undefined && summary.unattributedMs >= 1) {
    const fiberCount = summary.unattributedFiberCount ?? 0;
    const fiberLabel = fiberCount === 1 ? "fiber" : "fibers";
    lines.push(
      `- _⚠️ ${summary.unattributedMs}ms unattributed — ${fiberCount} ${fiberLabel} unmounted before stop (likely transient: modal/tooltip/animation)_`
    );
  }

  // Correlated from the Hermes CPU profile in stage 00-cpu-correlate
  if (summary.cpuHotspots && summary.cpuHotspots.length > 0) {
    lines.push("");
    lines.push("**CPU during this commit:**");
    for (const hs of summary.cpuHotspots) {
      const loc = hs.url
        ? ` (${shortenPath(hs.url)}${hs.lineNumber != null ? `:${hs.lineNumber}` : ""})`
        : "";
      lines.push(`- \`${hs.name}\` self=${hs.selfMs}ms total=${hs.totalMs}ms${loc}`);
    }
  }

  return lines;
}

function formatRootCauseLine(summary: HotCommitSummary): string {
  if (!summary.rootCauseComponent) return "";
  const ann = annotateComponentName(summary.rootCauseComponent);
  const parts: string[] = [`\`${ann.displayName}\`${ann.tag} re-rendered`];
  if (summary.rootCauseReason && summary.rootCauseReason !== "unknown") {
    const detail = formatReasonDetail(
      summary.rootCauseReason,
      summary.rootCauseChangedProps,
      summary.rootCauseChangedHookNames
    );
    if (detail) parts.push(`— ${detail}`);
  }
  return parts.join(" ");
}

function formatReason(reason: string, props?: string[], hookNames?: string[]): string {
  const detail = formatReasonDetail(reason, props, hookNames);
  return detail ? detail : reason;
}

function formatReasonDetail(reason: string, props?: string[], hookNames?: string[]): string {
  switch (reason) {
    case "props":
      return props && props.length > 0 ? `props: ${props.join(", ")}` : "props changed";
    case "hooks":
    case "state":
      return hookNames && hookNames.length > 0 ? `${reason}: ${hookNames.join(", ")}` : reason;
    case "context":
      return "context changed";
    case "parent":
      return "parent re-render";
    case "force_update":
      return "forceUpdate()";
    default:
      return reason;
  }
}

function findPriorAnnotation(
  annotations: Array<{ offsetMs: number; label: string }>,
  relativeMs: number
): { offsetMs: number; label: string } | undefined {
  // Requires annotations sorted by offsetMs
  let result: { offsetMs: number; label: string } | undefined;
  for (const ann of annotations) {
    if (ann.offsetMs <= relativeMs) {
      result = ann;
    } else {
      break;
    }
  }
  return result;
}

function renderSuggestedImprovements(
  findings: ComponentFinding[],
  compilerEnabled: boolean
): string {
  if (findings.length === 0) return "";

  const topFindings = findings
    .slice()
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 5);

  const lines: string[] = ["", "---", "## Suggested Improvements", ""];

  for (const f of topFindings) {
    const loc = f.sourceLocation
      ? `\`${shortenPath(f.sourceLocation.file)}:${f.sourceLocation.line}\``
      : null;
    const ann = annotateComponentName(f.component);
    const heading = `\`${ann.displayName}\`${ann.tag}`;
    lines.push(loc ? `### ${heading} — ${loc}` : `### ${heading}`);
    lines.push("");

    if (f.isCompilerOptimized) {
      lines.push(
        `> React Compiler has already optimized this component. ` +
          `Re-render cost may originate at the callsite — check that props passed to \`${ann.displayName}\` are stable (no inline objects/functions).`
      );
    } else if (f.compilerBailoutSuspected) {
      lines.push(
        `⚠️ **React Compiler should have optimized this** — check for patterns that prevent compilation ` +
          `(conditionally called hooks, mutations of props/state). Run \`npx react-compiler-healthcheck\`.`
      );
    } else {
      switch (f.dominantReason) {
        case "props": {
          const propList =
            f.topChangedProps.length > 0
              ? f.topChangedProps.map((p) => `\`${p}\``).join(", ")
              : "unknown props";
          lines.push(
            `**Stabilize props:** ${propList}. ` +
              `Likely inline objects/functions at the callsite — extract to constants or wrap with \`useMemo\`/\`useCallback\`` +
              `${compilerEnabled ? " (or fix the React Compiler bailout causing this)" : ""}.`
          );
          break;
        }
        case "hooks":
        case "state": {
          const hookList =
            f.topChangedHookNames.length > 0
              ? f.topChangedHookNames.map((h) => `\`${h}\``).join(", ")
              : "unknown hooks";
          lines.push(
            `**Unstable hook deps:** ${hookList}. ` +
              `Check dependency arrays in \`useEffect\`/\`useMemo\` — a dependency may be recreated on every render.`
          );
          break;
        }
        case "context":
          if (!f.sourceLocation) {
            lines.push(
              `**Context re-renders** — source not resolved, suggestion is pattern-based. Check the Provider component for an unmemoized value object.`
            );
          } else if (f.sourceLocation.hasUseMemo) {
            lines.push(
              `**Context re-renders — \`useMemo\` already present.** The context value reference is still changing. Investigate the Provider component: check whether its own dependencies are stable, or whether the Provider itself is remounting.`
            );
          } else {
            lines.push(
              `**Context value recreated every render.** Memoize the value object at the Provider with \`useMemo\`.`
            );
          }
          break;
        case "parent":
          if (f.parentTrigger) {
            const parentAnn = annotateComponentName(f.parentTrigger.component);
            lines.push(
              `**Parent trigger:** \`${parentAnn.displayName}\`${parentAnn.tag} is re-rendering unnecessarily. ` +
                `Fix the root cause in the parent first; this component will stop re-rendering as a side effect.`
            );
          } else {
            lines.push(
              compilerEnabled
                ? `**Unnecessary parent re-render** — check for a React Compiler bailout in the parent, or wrap with \`React.memo\` if the parent can't be fixed.`
                : `**Wrap with \`React.memo\`** to prevent re-renders driven by parent state/props that don't affect this component.`
            );
          }
          break;
        default:
          lines.push(
            `**Review render triggers** for \`${ann.displayName}\` — dominant reason: \`${f.dominantReason}\`.`
          );
      }
    }

    if (f.sourceSnippet && f.sourceLocation) {
      const snippetPath = `${shortenPath(f.sourceLocation.file)}:${f.sourceLocation.line}`;
      lines.push("");
      lines.push(`<details><summary>Source — \`${snippetPath}\`</summary>`);
      lines.push("");
      lines.push("```tsx");
      lines.push(f.sourceSnippet);
      lines.push("```");
      lines.push("");
      lines.push("</details>");
    }

    lines.push("");
  }

  return lines.join("\n");
}

function shortenPath(file: string): string {
  const parts = file.replace(/\\/g, "/").split("/");
  return parts.slice(-2).join("/");
}

async function writeReport(path: string, content: string): Promise<boolean> {
  try {
    await fs.writeFile(path, content, "utf8");
    return true;
  } catch {
    // non-fatal
    return false;
  }
}
