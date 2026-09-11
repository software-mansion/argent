/** Resolve and write a caller's `out` path, on the client that keeps the file. */

import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

/** An absolute path to write to, or the reason the request cannot be honored. */
export type OutPathResolution = { path: string } | { refusal: string };

/** Where the bytes landed, or why they did not. */
export type OutWriteResult = { wrote: string } | { failure: string };

/**
 * `~` never reaches an argument through a shell — an MCP arg is JSON, and the
 * CLI's only route to a tool's own `out` is JSON inside `--args`/`--out-json` —
 * so expand it here rather than creating a directory literally named `~` in the
 * agent's project.
 */
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  return p.startsWith("~/") || p.startsWith(`~${sep}`) ? join(homedir(), p.slice(2)) : p;
}

/**
 * Whether `p` names a directory by its spelling: `resolve` collapses a trailing
 * separator, `.` and `..`, so each of those would otherwise land as a regular
 * FILE of that name and block every later write underneath it.
 */
function namesADirectory(p: string): boolean {
  const last = p.split(sep).pop()!.split("/").pop()!;
  return last === "" || last === "." || last === "..";
}

/**
 * Where an image result's `out` should be written, on THIS host.
 *
 * Both clients that honor `out` share it so one parameter cannot mean two
 * things: `argent-mcp` writes it into a content block, `argent-cli` writes it
 * for `--out` and for a tool's own `out` property. It returns an absolute path
 * because that is the spelling the caller has to be able to hand onward —
 * `screenshot-diff` resolves a relative `baselinePath` against the tool-server's
 * working directory, not the client's.
 */
export function resolveOutPath(out: string): OutPathResolution {
  const trimmed = out.trim();
  if (!trimmed) return { refusal: "out names no path." };
  // Judged on the spelling the caller typed, because `join` inside the tilde
  // expansion normalizes the directory spellings away: `~/` and `~/shots/.`
  // arrive at a plain directory path that reads as a filename. A bare `~` never
  // looks like one at all, so it is named here.
  if (trimmed === "~" || namesADirectory(trimmed)) {
    return { refusal: "out names the file to write, not a directory." };
  }
  return { path: resolve(expandTilde(trimmed)) };
}

/**
 * What already sits at `target`, in the words of a refusal — or null when the
 * write may go ahead.
 *
 * Only a regular file is replaceable, because `rename` does not follow symlinks
 * and does not care what it unlinks: pointing `out` at a symlink to a directory
 * would destroy the link and report a save. Checked here rather than left to
 * `rename`'s errno, which names the `.part` sibling the caller never mentioned
 * (`EROFS ... open '/tmp.1234-ab.part'` for `out: /tmp`).
 */
async function occupantRefusal(target: string): Promise<string | null> {
  const st = await lstat(target).catch(() => null);
  if (!st || st.isFile()) return null;
  const kind = st.isSymbolicLink()
    ? "symbolic link"
    : st.isDirectory()
      ? "directory"
      : "special file";
  return `a ${kind} is already there, and only a regular file is replaced.`;
}

/**
 * A staging path beside `target` that cannot itself exceed NAME_MAX: the suffix
 * would otherwise push a filename the caller may legally use (up to 255 bytes)
 * over the limit, failing a write that the target path alone permits.
 */
function stagingPath(target: string): string {
  const suffix = `.${process.pid}-${Math.random().toString(36).slice(2, 8)}.part`;
  const base = basename(target);
  const room = 255 - Buffer.byteLength(suffix);
  const trimmed =
    Buffer.byteLength(base) <= room ? base : Buffer.from(base).subarray(0, room).toString();
  return join(dirname(target), `${trimmed}${suffix}`);
}

/**
 * Write `data` to the caller's `out`, creating missing parents.
 *
 * Staged through a sibling temp file and renamed into place, so `out` only ever
 * holds a whole capture: a truncating write leaves a half-written PNG there when
 * it fails midway, and the destination is a file the caller intends to hand to
 * `screenshot-diff` a run later, by which time nothing recalls that the write
 * failed. Rename also makes two clients racing one `out` resolve to one capture
 * or the other instead of a byte-level mix of both.
 */
export async function writeOutFile(out: string, data: Buffer): Promise<OutWriteResult> {
  const resolved = resolveOutPath(out);
  if ("refusal" in resolved) return { failure: `Could not save to ${out}: ${resolved.refusal}` };
  const target = resolved.path;
  const occupied = await occupantRefusal(target);
  if (occupied) return { failure: `Could not save to ${target}: ${occupied}` };
  const staged = stagingPath(target);
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(staged, data);
    await rename(staged, target);
    return { wrote: target };
  } catch (err) {
    await rm(staged, { force: true }).catch(() => {});
    return {
      failure: `Could not save to ${target}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
