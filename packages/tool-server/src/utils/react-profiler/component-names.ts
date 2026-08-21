/**
 * Component-name handling shared by the report renderer and the query tools.
 *
 * This codebase carries several component-name namespaces at once: React
 * DevTools display names in commit data (`Forget(Foo)`, `Memo(Foo)`), and bare
 * source identifiers in the tree-sitter AST index (`Foo`). The report prints
 * the stripped form for readability, so the name an agent reads is not the name
 * the commit data is keyed on — which is why the strip primitive and the
 * resolver that depends on it live together here rather than inside a render
 * stage. Two copies of the wrapper list is exactly how they drift apart.
 */

/** Wrappers React DevTools adds around a component's own name. */
const WRAPPER_PATTERNS = [/^Forget\((.+)\)$/, /^Memo\((.+)\)$/, /^ForwardRef\((.+)\)$/] as const;

/**
 * Deliberately NOT stripped: `Animated(View)`, `AnimatedComponent(View)`,
 * `Motion(View)`, `Context.Provider`, and the expo-router `Screen(./path.tsx)`
 * form. The report never displays those stripped, so no agent will ever hold a
 * stripped form of them — and stripping `Animated(View)` would make a query for
 * `View` ambiguous in almost every session.
 */
const MAX_WRAPPER_DEPTH = 4;

interface StrippedName {
  baseName: string;
  hasForget: boolean;
  hasMemo: boolean;
  hasForwardRef: boolean;
}

export function stripComponentWrappers(raw: string): StrippedName {
  let name = raw;
  let hasForget = false;
  let hasMemo = false;
  let hasForwardRef = false;

  for (let i = 0; i < MAX_WRAPPER_DEPTH; i++) {
    const m = WRAPPER_PATTERNS.map((re) => name.match(re)).find(Boolean);
    if (!m) break;
    if (name.startsWith("Forget(")) hasForget = true;
    else if (name.startsWith("Memo(")) hasMemo = true;
    else if (name.startsWith("ForwardRef(")) hasForwardRef = true;
    name = m[1]!;
  }

  return { baseName: name, hasForget, hasMemo, hasForwardRef };
}

interface ComponentAnnotation {
  displayName: string;
  tag: string;
  rawName: string;
}

/**
 * The display form used throughout the report. `rawName` is what commit data is
 * keyed on; `displayName` is what a reader sees — and therefore what they will
 * type back, which is why the resolver below accepts it.
 */
export function annotateComponentName(raw: string): ComponentAnnotation {
  const { baseName, hasForget, hasMemo, hasForwardRef } = stripComponentWrappers(raw);

  const parts: string[] = [];
  if (hasMemo) parts.push("React.memo");
  if (hasForget) parts.push("React Compiler");
  if (hasForwardRef) parts.push("forwardRef");
  const tag = parts.length > 0 ? ` [${parts.join(" + ")}]` : "";

  return { displayName: baseName, tag, rawName: raw };
}

type ComponentNameResolution =
  | { kind: "exact"; rawName: string; alsoMatching: string[] }
  | { kind: "display"; rawName: string; query: string }
  | { kind: "ambiguous"; query: string; candidates: string[] }
  | { kind: "missing"; query: string; suggestions: string[] };

/**
 * Resolve a user-supplied component name against the names actually recorded in
 * a session.
 *
 * Matching is against each recorded name's DISPLAY form, not a stripped form of
 * the query. Stripping both sides would quietly cross-resolve wrappers — a query
 * for `Forget(Foo)` would land on `Memo(Foo)` when only the latter exists — and
 * it would not even be reliable, because the display stripper stops after
 * MAX_WRAPPER_DEPTH, so a deeply wrapped name's display form still carries a
 * wrapper. Comparing against the display form compares against exactly the
 * string the report printed.
 *
 * Exact matches always win and are never widened.
 */
export function resolveComponentName(
  query: string,
  recordedNames: Iterable<string>
): ComponentNameResolution {
  const names = [...new Set(recordedNames)];

  const sharingDisplayName = (raw: string): string[] => {
    const display = annotateComponentName(raw).displayName;
    return names.filter((n) => n !== raw && annotateComponentName(n).displayName === display);
  };

  if (names.includes(query)) {
    // A wrapped sibling can share this display name (e.g. `StaticContainer` and
    // `Memo(StaticContainer)` both exist). Resolve to what was asked for, but
    // say the other one is there — otherwise the caller silently sees one of two.
    return { kind: "exact", rawName: query, alsoMatching: sharingDisplayName(query) };
  }

  const candidates = names.filter((n) => annotateComponentName(n).displayName === query);
  if (candidates.length === 1) {
    return { kind: "display", rawName: candidates[0]!, query };
  }
  if (candidates.length > 1) {
    return { kind: "ambiguous", query, candidates };
  }

  return { kind: "missing", query, suggestions: suggestNames(query, names) };
}

/**
 * Loose, display-aware suggestions for a miss. Deliberately looser than the
 * matcher: a suggestion only costs a retry, whereas loose matching would return
 * data for a component nobody asked about.
 */
function suggestNames(query: string, names: string[], limit = 5): string[] {
  const needle = query.toLowerCase();
  if (needle.length < 2) return [];
  return names
    .filter((n) => {
      const hay = `${n} ${annotateComponentName(n).displayName}`.toLowerCase();
      return (
        hay.includes(needle) || needle.includes(annotateComponentName(n).displayName.toLowerCase())
      );
    })
    .slice(0, limit);
}

/**
 * One-line note explaining a resolution that was not a plain exact hit, so the
 * numbers below it are attributable to a specific recorded name.
 */
export function describeResolution(
  resolution: Extract<ComponentNameResolution, { kind: "exact" | "display" }>
): string {
  if (resolution.kind === "display") {
    const { tag } = annotateComponentName(resolution.rawName);
    const why = tag ? ` (${tag.trim().slice(1, -1)})` : "";
    return (
      `> Resolved \`${resolution.query}\` to the recorded component ` +
      `\`${resolution.rawName}\`${why}. Either name works here.`
    );
  }
  if (resolution.alsoMatching.length > 0) {
    const others = resolution.alsoMatching.map((n) => `\`${n}\``).join(", ");
    return (
      `> Showing \`${resolution.rawName}\` only. ${others} also appear${resolution.alsoMatching.length === 1 ? "s" : ""} ` +
      `under this name once wrappers are stripped; they are separate fibers, so pass the exact name to target one.`
    );
  }
  return "";
}

/** Shared markdown for the two non-resolving outcomes, so the tools cannot drift. */
export function renderComponentNameMiss(
  resolution: Extract<ComponentNameResolution, { kind: "ambiguous" | "missing" }>,
  context: { fiberRenders?: number; commits?: number } = {}
): string {
  if (resolution.kind === "ambiguous") {
    const list = resolution.candidates.map((c) => `- \`${c}\``).join("\n");
    return (
      `_Component \`${resolution.query}\` is ambiguous: ${resolution.candidates.length} recorded ` +
      `components share this name once \`Memo(...)\` / \`ForwardRef(...)\` / \`Forget(...)\` wrappers ` +
      `are stripped. They are separate fibers and are not merged, because a combined total would not ` +
      `describe any real component. Re-run with one of these exact \`component_name\` values:_\n\n${list}`
    );
  }

  const recorded =
    context.fiberRenders != null && context.commits != null
      ? ` The session recorded ${context.fiberRenders} fiber renders across ${context.commits} commits.`
      : "";
  const suggestions =
    resolution.suggestions.length > 0
      ? `\n\nClosest recorded names — pass one verbatim as \`component_name\`:\n` +
        resolution.suggestions.map((s) => `- \`${s}\``).join("\n")
      : "";

  return (
    `_Component \`${resolution.query}\` not found in this profiling session — no exact match, and no ` +
    `component whose displayed name is \`${resolution.query}\` once \`Memo(...)\` / \`ForwardRef(...)\` / ` +
    `\`Forget(...)\` wrappers are stripped.${recorded}_${suggestions}\n\n` +
    `To list every component in a commit instead, run \`profiler-commit-query mode=by_index commit_index=<n>\`.`
  );
}

/**
 * Candidate keys for the tree-sitter AST index, which is keyed on bare source
 * identifiers. Ordered most- to least-specific; callers take the first hit.
 *
 * The third form drops an expo-router style file suffix — the report shows
 * `TabTwoScreen(./(tabs)/explore.tsx)` but the source declares `TabTwoScreen`.
 * Loosening is safe here in a way it is not for commit-data matching: a wrong
 * guess against the AST index simply misses and returns `found: false`.
 */
export function astLookupCandidates(raw: string): string[] {
  const keys = [raw];
  const { baseName } = stripComponentWrappers(raw);
  if (baseName !== raw) keys.push(baseName);

  const withoutSuffix = baseName.replace(/\(.*\)$/, "");
  if (withoutSuffix !== baseName && /^[A-Za-z_$][\w$]*$/.test(withoutSuffix)) {
    keys.push(withoutSuffix);
  }
  return keys;
}
