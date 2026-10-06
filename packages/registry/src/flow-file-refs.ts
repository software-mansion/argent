/**
 * How a flow file reference — a `run:` target, a `script:` path, or the flow a
 * caller named — is turned into the file it denotes on disk. Shared by the
 * tool-server (co-located runs) and the argent client (client services over a
 * link), so both sides resolve a reference with one implementation and the
 * kernel semantics of the machine that has the files.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FLOW_FILE_NAME_PATTERN } from "./file-inputs";

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
 * the step kind before any step runs, or — over a link whose client offers
 * client services — sends the reference back to the client, which runs this
 * same function on its OWN files and fences the result to the roots it chose
 * to serve. A nested `tool: flow-execute` naming a flow already on the host is
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
