/**
 * Shared archive helpers for the file boundary: a bundle (an iOS `.app`, an
 * `.apk`/`.vpkg`, a `.trace`) moves between client and tool-server as a tar
 * compressed with zstd or gzip. The system `tar` (present on macOS/Linux and
 * Windows 10+) only packs and unpacks; compression runs in `node:zlib`, since
 * stock `tar` builds can't read zstd.
 *
 * The archive carries the source's basename as its single top-level member, so
 * extraction recreates `<destDir>/<basename>`. Extraction is tar-slip hardened
 * in both directions — a hostile tar can come from a compromised client
 * uploading or a compromised tool-server serving an artifact.
 */

import { execFile, spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { open, rm, readdir } from "node:fs/promises";
import { basename, dirname, join, posix, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import zlib from "node:zlib";

const execFileAsync = promisify(execFile);

/** Thrown when an archive is empty, unreadable, or holds an unsafe (tar-slip / bad-type) member. */
export class ArchiveError extends Error {}

export type ArchiveFormat = "zstd" | "gzip";

/**
 * Formats this runtime can write and read, preferred first. zstd is missing
 * from Node 23.0-23.7, which `engines` still admits.
 */
export const ARCHIVE_FORMATS: readonly ArchiveFormat[] =
  typeof zlib.createZstdCompress === "function" ? ["zstd", "gzip"] : ["gzip"];

export const ARCHIVE_CONTENT_TYPES: Readonly<Record<ArchiveFormat, string>> = {
  zstd: "application/zstd",
  gzip: "application/gzip",
};

/**
 * The format to send a peer that can read `peerFormats`: the first of ours it
 * lists, else gzip, which every argent version reads.
 */
export function pickArchiveFormat(peerFormats: readonly string[] | undefined): ArchiveFormat {
  return ARCHIVE_FORMATS.find((f) => peerFormats?.includes(f)) ?? "gzip";
}

/** The archive formats an HTTP `Accept` header lists by content type. */
export function archiveFormatsFromAccept(accept: string | undefined): ArchiveFormat[] {
  const types = (accept ?? "").split(",").map((t) => t.split(";")[0]!.trim().toLowerCase());
  return ARCHIVE_FORMATS.filter((f) => types.includes(ARCHIVE_CONTENT_TYPES[f]));
}

export function createCompressor(format: ArchiveFormat): zlib.Gzip | zlib.ZstdCompress {
  return format === "zstd" ? zlib.createZstdCompress() : zlib.createGzip();
}

/**
 * `tar` argv that writes an uncompressed tar of `sourcePath`'s basename, as the
 * archive's single top-level member, to stdout.
 */
export function createTarArgs(sourcePath: string): string[] {
  return ["-cf", "-", "-C", dirname(sourcePath), basename(sourcePath)];
}

/**
 * Archive `sourcePath` (file or directory) into `archivePath`. Removes the
 * partial archive on failure, so a mid-write failure doesn't leak it.
 */
export async function createArchiveFile(
  sourcePath: string,
  archivePath: string,
  format: ArchiveFormat
): Promise<void> {
  try {
    const child = spawn("tar", createTarArgs(sourcePath), { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const exited = new Promise<number | null>((res, rej) => {
      child.on("error", rej);
      child.on("close", res);
    });
    const [, code] = await Promise.all([
      pipeline(child.stdout, createCompressor(format), createWriteStream(archivePath)),
      exited,
    ]);
    if (code !== 0) throw new Error(`tar exited with code ${code}: ${stderr.trim()}`);
  } catch (err) {
    await rm(archivePath, { force: true }).catch(() => {});
    throw err;
  }
}

/** Identify the compression by its magic bytes; the sender's label isn't trusted. */
async function sniffFormat(archivePath: string): Promise<ArchiveFormat> {
  const fh = await open(archivePath, "r");
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(4), 0, 4, 0);
    const magic = buffer.subarray(0, bytesRead).toString("hex");
    if (magic.startsWith("1f8b")) return "gzip";
    if (magic === "28b52ffd" && ARCHIVE_FORMATS.includes("zstd")) return "zstd";
    throw new ArchiveError("unrecognized compression");
  } finally {
    await fh.close();
  }
}

const ZSTD_FRAME_MAGIC = 0xfd2fb528;

/**
 * Throw unless `archivePath` is complete zstd frames with data in at most the
 * first, by walking frame and block headers (RFC 8878 §3.1.1). Node's decoder
 * silently accepts a truncated frame (nodejs/node#64592, fixed in 24.21) and
 * drops a later frame (nodejs/node#64741, fixed in 26.11); gzip's reports both.
 */
async function assertSingleCompleteZstdFrame(archivePath: string): Promise<void> {
  const fh = await open(archivePath, "r");
  try {
    const { size } = await fh.stat();
    const buf = Buffer.alloc(5);
    let pos = 0;
    const read = async (n: number): Promise<Buffer> => {
      const { bytesRead } = await fh.read(buf, 0, n, pos);
      if (bytesRead < n) throw new ArchiveError("truncated zstd frame");
      return buf;
    };
    let framesWithData = 0;
    while (pos < size) {
      const header = await read(5);
      if (header.readUInt32LE(0) !== ZSTD_FRAME_MAGIC) throw new ArchiveError("bad zstd frame");
      const descriptor = header[4]!;
      const singleSegment = (descriptor >> 5) & 1;
      pos +=
        5 +
        (singleSegment ? 0 : 1) + // window descriptor
        [0, 1, 2, 4][descriptor & 3]! + // dictionary id
        [singleSegment, 2, 4, 8][descriptor >> 6]!; // frame content size
      let hasData = false;
      for (let last = 0; !last; ) {
        const block = (await read(3)).readUIntLE(0, 3);
        last = block & 1;
        const type = (block >> 1) & 3;
        const blockSize = block >> 3;
        if (type === 3) throw new ArchiveError("bad zstd block");
        if (blockSize > 0) hasData = true;
        pos += 3 + (type === 1 ? 1 : blockSize); // an RLE block stores one byte
      }
      if ((descriptor >> 2) & 1) pos += 4; // content checksum
      if (hasData && ++framesWithData > 1) throw new ArchiveError("multi-frame zstd");
    }
    if (pos !== size) throw new ArchiveError("truncated zstd frame");
  } finally {
    await fh.close();
  }
}

/** Decompress `archivePath` into a plain tar at `tarPath`. */
async function decompressToTar(archivePath: string, tarPath: string): Promise<void> {
  const format = await sniffFormat(archivePath);
  if (format === "zstd") await assertSingleCompleteZstdFrame(archivePath);
  await pipeline(
    createReadStream(archivePath),
    format === "zstd" ? zlib.createZstdDecompress() : zlib.createGunzip(),
    createWriteStream(tarPath)
  );
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
  const { stdout } = await execFileAsync("tar", ["-tf", tarPath]);
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
 * Reject members that could write or link outside `destDir`. Regular files and
 * directories pass; symlinks pass only when their target stays inside (a `.app`
 * carries internal ones like `Current -> A`); every other type (hardlink,
 * device, fifo, …) is refused. Only `tar -tvf`'s type char and ` -> <target>`
 * are read — the column-formatted name is not stable across tar variants.
 */
async function assertSafeMemberTypes(tarPath: string): Promise<void> {
  const { stdout } = await execFileAsync("tar", ["-tvf", tarPath]);
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const type = line[0];
    if (type === "-" || type === "d") continue; // regular file or directory
    if (type === "l") {
      // More than one ` -> ` means the name or target itself contains it, so
      // the real target can't be read — refuse rather than trust a name like
      // `x -> safe` that hides an escaping target.
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
 * Path to the extracted bundle. Prefers the entry named `expectedName` —
 * required on the download path, where `destDir` is a shared cache holding
 * other artifacts. Otherwise falls back to the sole real entry, erroring rather
 * than handing back an arbitrary one.
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
 * Vet a zstd or gzip compressed tar (no path or symlink escaping `destDir`),
 * extract it into `destDir`, and return its top-level member path. Used in both
 * directions — neither the uploading client nor the serving tool-server is
 * trusted. Throws {@link ArchiveError}; callers map it to their own contract
 * (upload path → a 4xx, download path → null).
 */
export async function safeExtractArchive(
  archivePath: string,
  destDir: string,
  expectedName: string
): Promise<string> {
  // Decompressed once, then listed twice and extracted, rather than three
  // decompressions through `tar`.
  const tarPath = `${archivePath}.tar`;
  try {
    try {
      await decompressToTar(archivePath, tarPath);
    } catch (err) {
      throw new ArchiveError(
        `Could not read archive: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    await assertSafeArchive(tarPath, destDir);
    await execFileAsync("tar", ["-xf", tarPath, "-C", destDir]);
  } finally {
    await rm(tarPath, { force: true }).catch(() => {});
  }
  return resolveMember(destDir, expectedName);
}
