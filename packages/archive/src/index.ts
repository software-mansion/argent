/**
 * Shared `tar.gz` helpers for the file boundary — the one place that knows how
 * argent packs a bundle and how it *safely* unpacks one. Both directions move a
 * bundle (an iOS `.app` directory, an `.apk`/`.vpkg` file, a `.trace`) between
 * the client and the tool-server as a gzipped tar via the system `tar` (present
 * on macOS/Linux and Windows 10+):
 *
 * - server → client: an artifact is streamed out and unpacked on the client.
 * - client → server: an upload is streamed in and unpacked on the server.
 *
 * The archive always carries the source's basename as its single top-level
 * member, so extraction recreates `<destDir>/<basename>`. Extraction is
 * tar-slip hardened regardless of direction — a hostile tar can arrive either
 * way (a compromised client uploading, or a compromised tool-server serving an
 * artifact).
 */

import { execFile } from "node:child_process";
import { rm, readdir } from "node:fs/promises";
import { basename, dirname, join, posix, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Thrown when an archive is empty or holds an unsafe (tar-slip / bad-type) member. */
export class ArchiveError extends Error {}

/**
 * `tar` argv that gzips `sourcePath`'s basename as the archive's single
 * top-level member. `target` is an output file path, or `"-"` to stream to
 * stdout (for a spawned child piped to an HTTP response).
 */
export function createTarGzArgs(sourcePath: string, target: string): string[] {
  return ["-czf", target, "-C", dirname(sourcePath), basename(sourcePath)];
}

/**
 * Gzip `sourcePath` (file or directory) into the tar file at `tarPath`. Removes
 * the partial archive if `tar` fails so a mid-write failure doesn't leak it.
 */
export async function createTarGzFile(sourcePath: string, tarPath: string): Promise<void> {
  try {
    await execFileAsync("tar", createTarGzArgs(sourcePath, tarPath));
  } catch (err) {
    await rm(tarPath, { force: true }).catch(() => {});
    throw err;
  }
}

function normalizeTarMemberPath(memberPath: string): string {
  return memberPath.replace(/^\.\//, "").replace(/\\/g, "/");
}

/** Reject tar-slip paths (absolute, `..`, or resolving outside `destDir`). */
function isSafeTarMember(memberPath: string, destDir: string): boolean {
  const normalized = normalizeTarMemberPath(memberPath);
  if (!normalized || normalized === "." || normalized === "./") return false;
  if (normalized.startsWith("/") || /^[A-Za-z]:[\\/]/.test(normalized)) return false;
  const relative = posix.normalize(normalized);
  if (relative === ".." || relative.startsWith("../") || relative.split("/").includes("..")) {
    return false;
  }
  const root = resolve(destDir);
  const resolved = resolve(destDir, relative);
  return resolved === root || resolved.startsWith(root + sep);
}

/** List an archive's members without extracting, so they can be vetted first. */
async function listTarMembers(tarPath: string): Promise<string[]> {
  const { stdout } = await execFileAsync("tar", ["-tzf", tarPath]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** True when a symlink target would resolve outside the extract dir (absolute or `..`). */
function isEscapingLinkTarget(target: string): boolean {
  if (target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target)) return true;
  return posix.normalize(target.replace(/\\/g, "/")).split("/").includes("..");
}

/**
 * Reject members that could write or link outside `destDir`. Only regular files
 * and directories are unconditionally allowed. Bundles like a `.app` also carry
 * *internal* symlinks (e.g. `Current -> A`), so those are allowed when their
 * target stays inside — but absolute/`..` symlink targets, and every other type
 * (hardlink, device, fifo, …), are refused. `tar -tzvf`'s first column is the
 * type char and ` -> <target>` the symlink target across tar variants, so we
 * read only those two, never the fragile column-formatted name.
 */
async function assertSafeMemberTypes(tarPath: string): Promise<void> {
  const { stdout } = await execFileAsync("tar", ["-tzvf", tarPath]);
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const type = line[0];
    if (type === "-" || type === "d") continue; // regular file or directory
    if (type === "l") {
      // `tar -tzvf` prints "<name> -> <target>". Split on ` -> `: a clean
      // symlink yields exactly two parts. More than one ` -> ` means the name
      // or target itself contains it — unparseable, so refuse rather than risk
      // mis-reading the target (a name like `x -> safe` could otherwise hide a
      // real escaping target). Legit `.app` symlinks never contain ` -> `.
      const parts = line.split(" -> ");
      const target = parts.length === 2 ? parts[1]!.trim() : "";
      if (parts.length !== 2 || !target || isEscapingLinkTarget(target)) {
        throw new ArchiveError(
          `Archive contains a symlink whose target could not be confirmed safe: "${line.trim()}".`
        );
      }
      continue;
    }
    throw new ArchiveError(
      `Archive contains an unsupported member type "${type}" (hardlink/device/…) — refusing extraction.`
    );
  }
}

/** Throw {@link ArchiveError} unless every member is safe to extract into `destDir`. */
async function assertSafeArchive(tarPath: string, destDir: string): Promise<void> {
  let members: string[];
  try {
    members = await listTarMembers(tarPath);
  } catch (err) {
    throw new ArchiveError(
      `Could not read archive: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (members.length === 0) {
    throw new ArchiveError("Archive is empty.");
  }
  for (const member of members) {
    if (!isSafeTarMember(member, destDir)) {
      throw new ArchiveError(`Archive contains an unsafe path "${member}" — refusing extraction.`);
    }
  }
  await assertSafeMemberTypes(tarPath);
}

/**
 * Return the path to the extracted bundle. Prefers the entry named
 * `expectedName` — required on the download path, where `destDir` is a shared
 * cache holding other artifacts. When the exact name is absent (e.g. unicode
 * normalization changed it) it falls back to the sole real entry, and errors
 * rather than guessing if there's more than one — we never hand an arbitrary
 * member to the tool.
 */
async function resolveMember(destDir: string, expectedName: string): Promise<string> {
  const entries = await readdir(destDir);
  if (entries.includes(expectedName)) {
    return join(destDir, expectedName);
  }
  const real = entries.filter((e) => !e.startsWith("._"));
  if (real.length !== 1) {
    throw new ArchiveError(
      `Could not identify the extracted member (expected "${expectedName}", found ${real.length} entries).`
    );
  }
  return join(destDir, real[0]!);
}

/**
 * Vet a gzipped tar (no path or symlink escaping `destDir`), extract it into
 * `destDir`, and return its top-level member path. Used by both directions —
 * neither the uploading client nor the serving tool-server is unconditionally
 * trusted. Throws {@link ArchiveError} for a bad archive; callers map that to
 * their own contract (the upload path → a 4xx, the download path → null).
 */
export async function safeExtractTarGz(
  tarPath: string,
  destDir: string,
  expectedName: string
): Promise<string> {
  await assertSafeArchive(tarPath, destDir);
  await execFileAsync("tar", ["-xzf", tarPath, "-C", destDir]);
  return resolveMember(destDir, expectedName);
}
