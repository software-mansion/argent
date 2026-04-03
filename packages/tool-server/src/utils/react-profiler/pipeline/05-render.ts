/**
 * Stage 05-render: Renders HotCommitSummary[] + ComponentFinding[] into markdown.
 *
 * Output is LLM-optimized: structured prose with emoji tier indicators.
 * Writes the full report to debugDir/react-profiler-report.md.
 * Returns a capped version (top 10 hot commits by totalRenderMs) for inline response.
 *
 * Annotation matching: for each commit, find the annotation with highest offsetMs
 * that is <= commit's relative timestamp. No time-limit cutoff — always show the
 * most recent prior annotation so the developer/LLM can reason about causality.
 */
import { promises as fs } from "fs";
import { join } from "path";
import type { HotCommitSummary, ComponentFinding } from "../types/output";
import type { SessionContext } from "../types/pipeline";

const MAX_INLINE_COMMITS = 10;
const REPORT_FILENAME = "react-profiler-report.md";

export interface RenderInput {
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
}

export interface RenderOutput {
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

  // Compute relative timestamps: use minimum timestamp across all summaries as t=0
  const minTs = Math.min(...input.hotCommitSummaries.map((s) => s.timestampMs));

  // Sort annotations by offsetMs for binary search
  const annotations = (input.annotations ?? []).slice().sort((a, b) => a.offsetMs - b.offsetMs);

  // Full report: all commits
  const fullMarkdown = buildFullMarkdown(input, minTs, annotations, hotCommitsTotal);

  // Capped report: top MAX_INLINE_COMMITS hot commits by totalRenderMs
  const topHotByMs = hotCommits
    .slice()
    .sort((a, b) => b.totalRenderMs - a.totalRenderMs)
    .slice(0, MAX_INLINE_COMMITS);
  const topHotIndices = new Set(topHotByMs.map((s) => s.commitIndex));

  // For the capped version, include margin commits adjacent to shown hot commits
  const cappedSummaries = input.hotCommitSummaries.filter((s) => {
    if (!s.isMargin) return topHotIndices.has(s.commitIndex);
    // Include margin if adjacent to a shown hot commit
    return topHotIndices.has(s.commitIndex - 1) || topHotIndices.has(s.commitIndex + 1);
  });

  const hotCommitsShown = Math.min(hotCommitsTotal, MAX_INLINE_COMMITS);
  const cappedMarkdown = buildFullMarkdown(
    { ...input, hotCommitSummaries: cappedSummaries },
    minTs,
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderAllClear(input: RenderInput, maxMs: number): string {
  const durationS = (input.recordingMs / 1000).toFixed(1);
  const compilerLine = renderCompilerStatus(
    input.sessionContext.reactCompilerEnabled,
    input.anyRuntimeCompilerDetected
  );
  const maxNote = maxMs > 0 ? ` (peak commit: ${maxMs.toFixed(1)}ms)` : "";
  const lines = [
    `# Profiling Analysis — ${durationS}s session`,
    `${compilerLine}  **Hot commits:** 0 of ${input.reactCommits} total`,
    ``,
    `✅ **All clear** — all React commits were below 16ms${maxNote}.`,
    `No performance issues detected in this session.`,
    ``,
    `---`,
    `## Suggested Improvements`,
    ``,
    `No performance hotspots found. Consider these proactive checks:`,
    ``,
    `- Run \`react-profiler-component-source\` on your most-rendered components to verify memoization is in place.`,
    `- Run \`react-profiler-renders\` for a live view of render counts — components with high counts may benefit from \`React.memo\`${input.sessionContext.reactCompilerEnabled ? " or compiler-compatible patterns" : ""}.`,
    `- Re-profile under heavier load (longer interaction, more data) to catch issues that don't appear in short sessions.`,
  ];
  return lines.join("\n");
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
  minTs: number,
  annotations: Array<{ offsetMs: number; label: string }>,
  totalHotCommits: number
): string {
  const { sessionContext, recordingMs, anyRuntimeCompilerDetected } = input;
  const durationS = (recordingMs / 1000).toFixed(1);
  const compilerLine = renderCompilerStatus(
    sessionContext.reactCompilerEnabled,
    anyRuntimeCompilerDetected
  );
  const hotCount = input.hotCommitSummaries.filter((s) => !s.isMargin).length;

  const lines: string[] = [
    `# Profiling Analysis — ${durationS}s session`,
    `${compilerLine}  **Hot commits:** ${totalHotCommits} of ${input.reactCommits} total`,
    ``,
    `---`,
    `## Slow React Batches`,
    ``,
  ];

  for (const summary of input.hotCommitSummaries) {
    lines.push(...renderCommit(summary, minTs, annotations, sessionContext));
    lines.push("");
  }

  // Top components table
  if (input.componentFindings.length > 0) {
    lines.push("---");
    lines.push("## Top Components by Total Render Cost");
    lines.push("");
    lines.push("| Component | Renders | Total | Avg | Max | Reason | File |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const f of input.componentFindings) {
      const file = f.sourceLocation
        ? `\`${shortenPath(f.sourceLocation.file)}:${f.sourceLocation.line}\``
        : "—";
      const reasonStr = formatReason(f.dominantReason, f.topChangedProps, f.topChangedHookNames);
      const compilerFlag = f.compilerBailoutSuspected ? " ⚠️" : f.isCompilerOptimized ? " ✓" : "";
      lines.push(
        `| \`${f.component}\`${compilerFlag} | ${f.renders} | ${f.totalMs}ms | ${f.avgMs}ms | ${f.maxMs}ms | ${reasonStr} | ${file} |`
      );
    }

    // Compiler note (only if static detection says yes but runtime didn't detect)
    if (sessionContext.reactCompilerEnabled && !anyRuntimeCompilerDetected) {
      lines.push("");
      lines.push(
        "> ⚠️ React Compiler configured but no compiled components found at runtime. " +
          "Check babel plugin ordering, React version compatibility, or run `npx react-compiler-healthcheck`."
      );
    }
  }

  // Suggested improvements
  const suggestionsSection = renderSuggestedImprovements(
    input.componentFindings,
    sessionContext.reactCompilerEnabled
  );
  if (suggestionsSection) {
    lines.push(suggestionsSection);
  }

  // Dev mode note
  if (sessionContext.buildMode === "dev") {
    lines.push("");
    lines.push(
      "> 📝 Dev mode renders are ~3× slower than production. Divide ms values by ~3 for a rough production estimate."
    );
  }

  // Next steps guidance for the agent
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
  minTs: number,
  annotations: Array<{ offsetMs: number; label: string }>,
  sessionContext: SessionContext
): string[] {
  const relativeMs = summary.timestampMs - minTs;
  const relativeS = (relativeMs / 1000).toFixed(1);
  const tierEmoji = summary.tier === "hot" ? "🔴" : summary.tier === "warm" ? "🟡" : "🔵";

  let header: string;
  if (summary.isMargin) {
    header = `### Commit #${summary.commitIndex} — ${summary.totalRenderMs}ms ${tierEmoji} (t=${relativeS}s, margin)`;
  } else {
    header = `### Commit #${summary.commitIndex} — ${summary.totalRenderMs}ms ${tierEmoji} (t=${relativeS}s)`;
  }

  const lines: string[] = [header];

  // Annotation: find the annotation with highest offsetMs <= commit relative timestamp
  const annotation = findPriorAnnotation(annotations, relativeMs);
  if (annotation) {
    const deltaSec = ((relativeMs - annotation.offsetMs) / 1000).toFixed(1);
    lines.push(`> After: "${annotation.label}" (${deltaSec}s prior)`);
  }

  // Warm tier note
  if (summary.tier === "warm" && !summary.isMargin) {
    lines.push("> 🟡 May be acceptable in production (dev mode is ~3× slower)");
  }

  lines.push("");

  // Header line: root cause for re-renders, initial render label for mount-dominated commits
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

  // Render component entries (mix of re-renders and mounts)
  for (const comp of summary.components) {
    const countSuffix = comp.count > 1 ? ` ×${comp.count}` : "";
    let reasonStr: string;
    if (comp.isFirstMount) {
      reasonStr = " — (mount)";
    } else if (comp.reason) {
      reasonStr = ` — ${formatReason(comp.reason, comp.topChangedProps, comp.topChangedHookNames)}`;
    } else {
      reasonStr = "";
    }
    lines.push(`- \`${comp.name}\`${countSuffix} ${comp.selfDurationMs}ms${reasonStr}`);
  }

  // "... and N more" if component list was capped
  if (summary.totalComponentCount > summary.components.length) {
    const remaining = summary.totalComponentCount - summary.components.length;
    lines.push(`- _... and ${remaining} more_`);
  }

  // CPU hotspots during this commit (from Hermes CPU profile correlation)
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
  const parts: string[] = [`\`${summary.rootCauseComponent}\` re-rendered`];
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
  // Annotations are sorted by offsetMs. Find the last one with offsetMs <= relativeMs.
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
    lines.push(loc ? `### \`${f.component}\` — ${loc}` : `### \`${f.component}\``);
    lines.push("");

    if (f.isCompilerOptimized) {
      lines.push(
        `> React Compiler has already optimized this component. ` +
          `Re-render cost may originate at the callsite — check that props passed to \`${f.component}\` are stable (no inline objects/functions).`
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
            lines.push(
              `**Parent trigger:** \`${f.parentTrigger.component}\` is re-rendering unnecessarily. ` +
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
            `**Review render triggers** for \`${f.component}\` — dominant reason: \`${f.dominantReason}\`.`
          );
      }
    }

    // Embed source snippet in a collapsible block if available
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
  // Keep last 2 path segments for readability
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
