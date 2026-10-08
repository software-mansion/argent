/**
 * How a flow file reference — a `run:` target, a `script:` path, or the flow a
 * caller named — is turned into the file it denotes on disk. Shared by the
 * tool-server (co-located runs) and the argent client (which collects a flow's
 * files for a call over a link), so both sides resolve a reference with one
 * implementation and the kernel semantics of the machine that has the files.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FLOW_FILE_NAME_PATTERN, FLOW_NAME_PATTERN } from "./file-inputs";

/**
 * The input must arrive with any `..` segments intact (no path.resolve/join
 * over the string): a `..` that follows a symlinked directory component names
 * the parent of the link's TARGET, which only the kernel can know, so a lexical
 * collapse first silently picks a different file than the spelling denotes on
 * disk. fs/promises' realpath keeps kernel semantics (realpath(3), unlike
 * callback fs.realpath, which path.resolve()s first). When realpath fails the
 * containing directory is still kernel-resolved before the basename is
 * re-appended, so the subsequent read opens — and its ENOENT names — the file
 * the spelling denotes rather than an existing impostor a collapse could have
 * named; when the directory chain itself is broken the spelling is returned
 * verbatim, for the same reason.
 *
 * Callers must pass an absolute path: every return value, the verbatim fallback
 * included, is consumed as absolute with no resolve step after this point.
 */
export async function canonicalFlowPath(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    try {
      return path.join(await fs.realpath(path.dirname(p)), path.basename(p));
    } catch {
      return p;
    }
  }
}

/**
 * Complete a `run:` target's optional `.yaml` extension: `run: login` means
 * `login.yaml` beside the containing flow file, exactly as the spelled-out form
 * does. This is the compatibility path for flows written when a `run:` target
 * was a saved-flow NAME looked up in `.argent/flows` — a bare name resolves to
 * the same file it always did, since those flows sit in that one directory.
 *
 * Completed when the tool-server parses a flow, rather than at resolution
 * time, so exactly one spelling reaches everything downstream:
 * canonicalFlowPath's read, the fragment's on-disk casing check, the report's
 * `target`, and runDisplayName — which slices a fixed `".yaml".length` off the
 * target and would truncate a real path segment given a bare one (see
 * flow-run.ts). Re-serializing a parsed flow therefore writes the completed
 * spelling back, which is the intended one-way migration. The argent client
 * completes a target the same way ({@link collectFlowRequests}) to know which
 * files to send with a flow.
 *
 * The test is the CANDIDATE's basename, not the supplied value's: basename()
 * strips a trailing slash, so testing `${basename(value)}.yaml` would complete
 * `shared/` to the unopenable `shared/.yaml`. Anything else the candidate cannot
 * name — a wrong extension (`login.yml`), a mis-cased one (`Login.YAML`), an
 * empty target — leaves the value untouched for the caller's extension
 * diagnostics, which name the real problem better than a silent completion to
 * `login.yml.yaml` could.
 */
export function completeRunExtension(value: string): string {
  if (value.endsWith(".yaml")) return value;
  const candidate = `${value}.yaml`;
  return FLOW_FILE_NAME_PATTERN.test(path.posix.basename(candidate)) ? candidate : value;
}

/**
 * Longest chain of `run:` fragments and nested `tool: flow-execute` runs a
 * flow may nest: the runner refuses the step that would push the chain past
 * it. The client sends the files of a flow's closure to this depth, the
 * deepest one the runner resolves.
 */
export const MAX_RUN_DEPTH = 20;

/** Deeper than any block nesting the runner parses; also ends a cyclic YAML alias. */
const MAX_BLOCK_NESTING = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The project files a parsed flow document makes the runner read: the `run:`
 * targets of its steps and of the steps of its block directives (`when:`),
 * taken or not, spelled as the runner keeps them (extension completed), the
 * names of its `snapshot` steps, whose baselines the run reads or writes, and
 * its `tool:` steps, whose file arguments the run reads (which arguments are
 * files depends on the tool's declaration: {@link toolStepFiles}). `nested`:
 * the flow each `tool: flow-execute` step among them names
 * ({@link nestedFlowTarget}), with the step's args, which say whether its run
 * updates baselines. A value the runner's parse refuses names nothing. Pure: it walks a document the caller
 * parsed, so the client and the tool-server's parity test share it without a
 * YAML or file-system dependency.
 */
export function collectFlowRequests(doc: unknown): {
  runTargets: string[];
  snapshots: string[];
  toolSteps: { tool: string; args: Record<string, unknown> }[];
  nested: { target: NestedFlowTarget; args: Record<string, unknown> }[];
} {
  const runTargets = new Set<string>();
  const snapshots = new Set<string>();
  const toolSteps: { tool: string; args: Record<string, unknown> }[] = [];
  const nested: { target: NestedFlowTarget; args: Record<string, unknown> }[] = [];
  const seen = new Set<unknown>();
  const visit = (steps: unknown, depth: number): void => {
    if (!Array.isArray(steps) || depth > MAX_BLOCK_NESTING || seen.has(steps)) return;
    seen.add(steps);
    for (const step of steps) {
      if (!isRecord(step)) continue;
      const run = step.run;
      if (
        typeof run === "string" &&
        !run.includes("\\") &&
        !path.posix.isAbsolute(run) &&
        !/^[A-Za-z]:/.test(run)
      ) {
        const target = completeRunExtension(run);
        if (FLOW_FILE_NAME_PATTERN.test(path.posix.basename(target))) runTargets.add(target);
      }
      const snapshot = isRecord(step.snapshot) ? step.snapshot.name : step.snapshot;
      if (typeof snapshot === "string" && FLOW_NAME_PATTERN.test(snapshot)) snapshots.add(snapshot);
      if (typeof step.tool === "string") {
        const args = isRecord(step.args) ? step.args : {};
        toolSteps.push({ tool: step.tool, args });
        const target = step.tool === "flow-execute" ? nestedFlowTarget(args) : undefined;
        if (target !== undefined) nested.push({ target, args });
      }
      visit(step.steps, depth + 1);
    }
  };
  if (isRecord(doc)) visit(doc.steps, 0);
  return { runTargets: [...runTargets], snapshots: [...snapshots], toolSteps, nested };
}

/**
 * The `__baselines__/<segment>` a run's snapshots key their baseline store
 * under. The store is `<dir>/__baselines__/<key>` beside the CANONICAL root
 * flow, so the key must name the canonical file too. With the as-written stem
 * it does not, and the disagreement merges distinct flows: two projects whose
 * `.argent/flows/smoke.yaml` are symlinks into one shared vault
 * (`vault/a-smoke.yaml`, `vault/b-smoke.yaml`) both anchor at `vault/` and
 * both key "smoke", so a single `vault/__baselines__/smoke/` holds one PNG the
 * two flows silently overwrite in turn while each `--update-baselines` run
 * reports "baseline updated". For a root flow that is a regular file the
 * canonical stem IS the as-written one, so only symlinked roots move.
 *
 * The canonical stem is the symlink TARGET's filename, which nothing
 * validates: a vault file may legitimately be called `...yaml`, whose stem
 * after `.yaml` is `..`, and `<dir>/__baselines__/..` IS the flow directory,
 * so every baseline would land beside the flow files themselves (the escape
 * `flow-path-baseline-escape.test.ts` pins for the as-written spelling). Hence
 * the pattern check, against the same charset every other flow name is held
 * to. An unsafe stem falls back to the always-validated `flowName` rather than
 * throwing: an unusually named vault file is not the caller's error to fix
 * mid-run. Shared by the runner and the argent client, which sends a linked
 * run's baselines from the same directory.
 */
export function baselineKeyFor(canonicalPath: string, flowName: string): string {
  // path.basename leaves a bare ".yaml" intact (stripping it would leave
  // nothing) — the pattern rejects that spelling too, so it falls back as well.
  const stem = path.basename(canonicalPath, ".yaml");
  return FLOW_NAME_PATTERN.test(stem) ? stem : flowName;
}

/** The key of a `run:` resolution: the directory the target resolves against, and the target as written. */
export function flowMemberKey(anchorDir: string, target: string): string {
  return `${anchorDir}\0${target}`;
}

/**
 * How the flow file a caller addressed is spelled in its own directory.
 * `listed`: the directory carries that basename byte-for-byte — or its listing
 * could not be read at all (an execute-only parent lets stat through while
 * refusing readdir), which vouches for nothing and so must refuse nothing.
 * `case_folded`: no entry carries it, but one differs only by case — what a
 * case-insensitive filesystem (APFS, NTFS) opens for a spelling nothing on disk
 * has. `absent`: nothing matches even case-insensitively. `addressable` says
 * whether the on-disk spelling is one the flow layer's own ladders accept, so a
 * caller can be pointed at it instead of at a rename.
 */
export type OnDiskSpelling =
  | { state: "listed" }
  | { state: "case_folded"; actual: string; addressable: boolean }
  | { state: "absent" };

/**
 * Classify the supplied basename against `dir`'s listing. One classifier serves
 * every route that turns a caller's spelling into a file it will open — a flow,
 * or since the `script:` step a plain `.mjs` — so they can never drift apart in
 * which spellings they accept.
 *
 * readdir, not realpath: realpath rewrites a symlinked flow to its target's
 * name, and a flow deliberately runs — and composes — under the link's own
 * name. Every call site hands a pure-ASCII basename (the flow-name charset,
 * plus ".yaml" or ".mjs"), so Unicode-normalizing filesystems cannot make the
 * comparison lie.
 *
 * What an `absent` verdict means is the caller's to decide, and they differ:
 * `flow_path` arrives with the boundary's stat already vouching for the file,
 * so a listing that lacks it is itself the phantom-spelling bug, while a `name`
 * may simply not name a saved flow — an ordinary missing-flow error the later
 * read reports far better than a casing complaint could.
 */
export async function classifyOnDiskSpelling(
  dir: string,
  base: string,
  addressable: RegExp = FLOW_FILE_NAME_PATTERN
): Promise<OnDiskSpelling> {
  const entries = await fs.readdir(dir).catch(() => null);
  if (entries === null || entries.includes(base)) return { state: "listed" };
  const actual = entries.find((entry) => entry.toLowerCase() === base.toLowerCase());
  if (actual === undefined) return { state: "absent" };
  return { state: "case_folded", actual, addressable: addressable.test(actual) };
}

export interface ResolvedFlowRelativeFile {
  canonical: string;
  spelling: OnDiskSpelling;
}

/**
 * Three things here are load-bearing:
 *
 * - **The anchor is the CONTAINING file's canonical directory**, never the root
 *   flow's. A root anchor would make a fragment resolve a different file
 *   depending on which flow composed it, so a shared fragment would stop being
 *   self-contained — the one property `run:` composition exists to have.
 * - **The join is string concatenation, not `path.resolve`/`path.join`.** Those
 *   collapse a `..` lexically before the kernel ever sees the spelling, and
 *   after a symlinked directory component the collapse names a different file
 *   than the one on disk. Both name kinds deliberately admit `..` (shared
 *   fragments and shared scripts may live outside the referencing file's
 *   directory), so the spelling has to reach the kernel intact. The anchor is
 *   absolute and the target relative — parse rejects an absolute or
 *   drive-prefixed target — so the concatenation is well-formed.
 * - **The casing check lists the directory the target is SPELLED in**, not
 *   `path.dirname(canonical)`. The basename compared is always the SUPPLIED one
 *   (`path.posix.basename(target)`), and only the spelled directory is
 *   guaranteed to hold an entry under that name: for a symlink whose target
 *   lives elsewhere, the canonical directory holds the target's name instead,
 *   so a mis-cased spelling of the link's own name would go unjudged.
 *   `path.dirname` removes a segment without collapsing `..`, so a `..` still
 *   reaches readdir intact.
 *
 * There is deliberately NO path fence here on the tool-server. A target is
 * reachable exactly when the tool-server user can read it, which is the reach
 * the front door already grants: an operator can point `flow_path` at any YAML
 * on the host. The one route that carries untrusted content, an uploaded flow,
 * never resolves a target of its own on the host: the runner either refuses
 * the step kind before any step runs, or looks the reference up in the files
 * the client sent with the call, which the client resolved with this same
 * function on its OWN files and fenced to the roots it chose to send. A nested `tool: flow-execute` naming a flow already on the host is
 * an ordinary `name` run and resolves here as one, with the reach a direct
 * `flow-execute` call for that same `name` already has.
 */
export async function resolveFlowRelativeFile(
  anchorDir: string,
  target: string,
  addressable: RegExp
): Promise<ResolvedFlowRelativeFile> {
  const spelled = anchorDir + path.sep + target;
  const canonical = await canonicalFlowPath(spelled);
  const spelling = await classifyOnDiskSpelling(
    path.dirname(spelled),
    path.posix.basename(target),
    addressable
  );
  return { canonical, spelling };
}

/**
 * The flow a nested `tool: flow-execute` step names, in a form both sides of a
 * link accept, or undefined. `name`: a flow name with an absolute
 * `project_root` that has no `..` segment, and no `flow_path`; `path` is the
 * saved flow `<project_root>/.argent/flows/<name>.yaml`. `flow_path`: an
 * absolute path with no `..` segment to a `<flow-name>.yaml` file, and no
 * `name`. The argent client sends the flow of a `name` step with the call,
 * and the tool-server runs a nested step over a link only in that form, so the
 * two decide with this one function.
 */
export type NestedFlowTarget =
  | { kind: "name"; projectRoot: string; name: string; path: string }
  | { kind: "flow_path"; path: string };

export function nestedFlowTarget(args: unknown): NestedFlowTarget | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const { name, project_root: projectRoot, flow_path: flowPath } = args as Record<string, unknown>;
  if (flowPath === undefined) {
    if (typeof name !== "string" || !FLOW_NAME_PATTERN.test(name)) return undefined;
    if (!isResolvedAbsolute(projectRoot)) return undefined;
    return {
      kind: "name",
      projectRoot,
      name,
      path: path.join(projectRoot, ".argent", "flows", `${name}.yaml`),
    };
  }
  if (name !== undefined || !isResolvedAbsolute(flowPath)) return undefined;
  if (!FLOW_FILE_NAME_PATTERN.test(path.basename(flowPath))) return undefined;
  return { kind: "flow_path", path: flowPath };
}

function isResolvedAbsolute(value: unknown): value is string {
  return (
    typeof value === "string" && path.isAbsolute(value) && !value.split(/[\\/]+/).includes("..")
  );
}
