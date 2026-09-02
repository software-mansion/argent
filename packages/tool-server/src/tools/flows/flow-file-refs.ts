import * as fs from "node:fs/promises";
import * as path from "node:path";
import { classifyOnDiskSpelling, type OnDiskSpelling } from "./flow-utils";

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

interface ResolvedFlowRelativeFile {
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
 * There is deliberately NO path fence here. A target is reachable exactly when
 * the tool-server user can read it, which is the reach the front door already
 * grants: an operator can point `flow_path` at any YAML on the host.
 *
 * An uploaded flow — the one route that carries untrusted content — cannot name
 * a target of its OWN: `assertUploadSelfContained` rejects every `run:` and
 * `script:` step it declares, and a recording whose files are not on this host
 * is refused by `flow-add-script` before it gets here. It does still ARRIVE
 * here, through a nested `tool: flow-execute` naming a flow already on this
 * host — `invokeSubTool` forwards no `fileInputs`, so the inner run is an
 * ordinary `name` run with `viaUpload` false and that flow's own targets
 * resolve through this function. The decision above does not rest on uploads
 * being absent: it rests on the reach being unchanged, since a caller who can
 * send the wrapping upload can call `flow-execute` with that same `name`
 * directly and get the same result.
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
