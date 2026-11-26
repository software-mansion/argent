/**
 * Shared archive helpers for the file boundary: a bundle (an iOS `.app`, an
 * `.apk`/`.vpkg`, a `.trace`) moves between client and tool-server as a tar
 * compressed with zstd or gzip. The system `tar` (present on macOS/Linux and
 * Windows 10+) packs and unpacks; compression runs in `node:zlib`, since stock
 * `tar` builds can't read zstd and bsdtar skips gzip's CRC.
 *
 * The archive carries the source's basename as its single top-level member, so
 * extraction recreates `<destDir>/<basename>`. Extraction is tar-slip hardened
 * in both directions — a hostile tar can come from a compromised client
 * uploading or a compromised tool-server serving an artifact.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { open, rm, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { Writable, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

/** Thrown when an archive is empty, unreadable, or holds an unsafe (tar-slip / bad-type) member. */
export class ArchiveError extends Error {}

export type ArchiveFormat = "zstd" | "gzip";

/**
 * Formats this runtime can write and read, preferred first. zstd is missing
 * before Node 22.15 and from 23.0-23.7, which `engines` excludes but npm only
 * warns about.
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

/**
 * The formats an `Accept` header names by their exact content type. A type
 * with `q=0` is one the sender refuses.
 */
export function archiveFormatsFromAccept(accept: string | undefined): ArchiveFormat[] {
  const accepted = new Set<string>();
  for (const range of accept?.split(",") ?? []) {
    const [type = "", ...params] = range.split(";").map((part) => part.trim().toLowerCase());
    const q = params.find((param) => param.startsWith("q="));
    if (q === undefined || Number(q.slice(2)) > 0) accepted.add(type);
  }
  return ARCHIVE_FORMATS.filter((f) => accepted.has(ARCHIVE_CONTENT_TYPES[f]));
}

// zlib's default 16 KiB chunks slow zstd decompression up to 2x.
const CHUNK_BYTES = 1 << 20;

export function createCompressor(format: ArchiveFormat): zlib.Gzip | zlib.ZstdCompress {
  return format === "zstd"
    ? zlib.createZstdCompress({
        chunkSize: CHUNK_BYTES,
        // Lets the decoder detect corruption.
        params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
      })
    : zlib.createGzip({ chunkSize: CHUNK_BYTES });
}

/**
 * `tar` argv that writes an uncompressed tar of `sourcePath`'s basename, as the
 * archive's single top-level member, to stdout.
 */
export function createTarArgs(sourcePath: string): string[] {
  const name = basename(sourcePath);
  // `./` keeps `-x` or `@list` from reading as an option or a bsdtar archive to
  // copy. Only there: the root's empty name would become `./`, the whole disk.
  return ["-cf", "-", "-C", dirname(sourcePath), /^[-@]/.test(name) ? `./${name}` : name];
}

// iMovie.app's 59k members list in 24 MB under GNU tar, which counts bsdtar's
// `._` metadata as members. Vetting costs grow with both limits.
const MAX_LISTING_BYTES = 32 << 20;
const MAX_LISTING_LINES = 1 << 18;
// tar prints a line per failed member; the first ones say what went wrong.
const MAX_STDERR_BYTES = 16 << 10;
// Decoded after tar stops reading, to reach the checksum. A real archive ends
// within a record of its end-of-archive marker.
const MAX_UNREAD_BYTES = 16 << 20;

/**
 * Keep the first `maxBytes` of `stream`. Past them, or past `maxLines` lines,
 * `onOverflow` runs once and `text()` ends in `…`.
 */
function collect(
  stream: Readable | undefined,
  maxBytes: number,
  { maxLines = Infinity, onOverflow }: { maxLines?: number; onOverflow?: () => void } = {}
) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let lines = 0;
  let overflowed = false;
  // Undefined when spawn fails with EMFILE, which the child's `error` reports.
  stream?.on("data", (chunk: Buffer) => {
    if (overflowed) return;
    chunks.push(chunk.subarray(0, maxBytes - bytes));
    bytes += chunk.length;
    for (let i = chunk.indexOf(10); i !== -1 && lines <= maxLines; i = chunk.indexOf(10, i + 1)) {
      lines++;
    }
    if (bytes > maxBytes || lines > maxLines) {
      overflowed = true;
      onOverflow?.();
    }
  });
  return {
    overflowed: () => overflowed,
    text: () => Buffer.concat(chunks).toString("utf8") + (overflowed ? "…" : ""),
  };
}

/**
 * Archive `sourcePath` (file or directory) into `archivePath`. Removes the
 * partial archive on failure. An abort through `signal` rejects with its
 * reason, as `fetch` does.
 */
export async function createArchiveFile(
  sourcePath: string,
  archivePath: string,
  format: ArchiveFormat,
  signal?: AbortSignal
): Promise<void> {
  // Opened before tar starts, so nothing can recreate the archive after the rm below.
  const out = createWriteStream(archivePath);
  await once(out, "ready");
  try {
    await archiveInto(out, sourcePath, format, signal);
  } catch (err) {
    // Still open when tar never started.
    out.destroy();
    await rm(archivePath, { force: true }).catch(() => {});
    signal?.throwIfAborted();
    throw err;
  }
}

/**
 * Write tar's archive of `sourcePath`, compressed, to `out`. A failed spawn or
 * an abort outranks a failed write, which outranks the tar exit it causes.
 */
async function archiveInto(
  out: Writable,
  sourcePath: string,
  format: ArchiveFormat,
  signal?: AbortSignal
): Promise<void> {
  const child = spawn("tar", createTarArgs(sourcePath), {
    stdio: ["ignore", "pipe", "pipe"],
    signal,
  });
  const exited = new Promise<number | null>((res, rej) => {
    child.on("error", rej);
    child.on("close", res);
  });
  const stderr = collect(child.stderr, MAX_STDERR_BYTES);
  const [written, closed] = await Promise.allSettled([
    pipeline(child.stdout, createCompressor(format), out),
    exited,
  ]);
  if (closed.status === "rejected") throw closed.reason;
  if (written.status === "rejected") throw written.reason;
  if (closed.value !== 0) {
    throw new Error(`tar exited with code ${closed.value}: ${stderr.text().trim()}`);
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
 * Throw unless `archivePath` is complete zstd frames of which only the first
 * carries data, by walking frame and block headers (RFC 8878 §3.1.1). Node's
 * decoder can accept a truncated frame (nodejs/node#64592) and drop a later one
 * (nodejs/node#64741).
 */
async function assertSingleCompleteZstdFrame(
  archivePath: string,
  signal?: AbortSignal
): Promise<void> {
  const fh = await open(archivePath, "r");
  try {
    const { size } = await fh.stat();
    // One read per header would let a frame of tiny blocks cost seconds per MB.
    const window = Buffer.alloc(4096);
    let windowStart = 0;
    let windowEnd = 0;
    let pos = 0;
    const read = async (n: number): Promise<Buffer> => {
      if (pos < windowStart || pos + n > windowEnd) {
        signal?.throwIfAborted();
        const { bytesRead } = await fh.read(window, 0, window.length, pos);
        windowStart = pos;
        windowEnd = pos + bytesRead;
        if (bytesRead < n) throw new ArchiveError("truncated zstd frame");
      }
      return window.subarray(pos - windowStart, pos - windowStart + n);
    };
    for (let frame = 0; pos < size; frame++) {
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
      for (let last = 0; !last;) {
        const block = (await read(3)).readUIntLE(0, 3);
        last = block & 1;
        const type = (block >> 1) & 3;
        const blockSize = block >> 3;
        if (blockSize > 0) hasData = true;
        pos += 3 + (type === 1 ? 1 : blockSize); // an RLE block stores one byte
      }
      if ((descriptor >> 2) & 1) pos += 4; // content checksum
      if (hasData && frame > 0) throw new ArchiveError("multi-frame zstd");
    }
    if (pos !== size) throw new ArchiveError("truncated zstd frame");
  } finally {
    await fh.close();
  }
}

interface Archive {
  path: string;
  format: ArchiveFormat;
}

// Outside a UTF-8 locale tar lists a name like `日記.app` as `\346\227...`,
// which reads as absolute. macOS ships en_US.UTF-8, Linux C.UTF-8.
const TAR_LOCALE = process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";

/**
 * The environment `tar` runs in: `env` as it is when its character type is
 * already UTF-8, else with {@link TAR_LOCALE}. An older Linux has no `C.UTF-8`,
 * and forcing it there would take tar out of a UTF-8 locale that works.
 */
export function tarEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // The order in which the C library reads them.
  const characterType = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  return /utf-?8/i.test(characterType) ? env : { ...env, LC_ALL: TAR_LOCALE };
}

/**
 * Run `tar <args>` over `archive`, decompressed here and piped in, returning
 * stdout. A listing past {@link MAX_LISTING_BYTES} or {@link MAX_LISTING_LINES}
 * stops tar and throws.
 */
async function runTar(archive: Archive, args: string[], signal?: AbortSignal): Promise<string> {
  const child = spawn("tar", [...args, "-f", "-"], {
    signal,
    env: tarEnv(process.env),
    // tar.exe (Windows 10+) is a console-subsystem binary: without windowsHide
    // every run pops a console window on Windows — the tool-server, a console-less
    // process, reaches this for each file-input archive it extracts. No-op elsewhere.
    windowsHide: true,
  });
  // An abort emits "error" as soon as SIGTERM is sent. Tar can still be writing
  // until "close", so remember the error and wait before releasing the destination.
  let childError: Error | undefined;
  child.on("error", (err) => {
    childError = err;
  });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  const stdout = collect(child.stdout, MAX_LISTING_BYTES, {
    maxLines: MAX_LISTING_LINES,
    onOverflow: () => child.kill(),
  });
  const stderr = collect(child.stderr, MAX_STDERR_BYTES);
  // Once tar stops reading, its stdin fails with EPIPE (ENOTCONN from GNU tar on macOS).
  child.stdin?.on("error", () => {});
  // Past MAX_UNREAD_BYTES the rest isn't decoded, so its checksum goes unchecked.
  const unreadLimit = new Error("unread limit");
  let unread = 0;
  const fed = pipeline(
    createReadStream(archive.path, { highWaterMark: CHUNK_BYTES }),
    archive.format === "zstd"
      ? zlib.createZstdDecompress({ chunkSize: CHUNK_BYTES })
      : zlib.createGunzip({ chunkSize: CHUNK_BYTES }),
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        if (child.stdin?.writable) return void child.stdin.write(chunk, () => done());
        unread += chunk.length;
        done(unread > MAX_UNREAD_BYTES ? unreadLimit : null);
      },
      final(done) {
        child.stdin?.end();
        done();
      },
      destroy(err, done) {
        if (err) child.stdin?.destroy();
        done(err);
      },
    }),
    { signal }
  ).then(
    () => null,
    (err: Error) => err
  );
  const [code, feedError] = await Promise.all([closed, fed]);
  signal?.throwIfAborted();
  if (childError) throw childError;
  if (stdout.overflowed()) {
    throw new Error(
      `tar ${args.join(" ")} listed more than ${MAX_LISTING_LINES} members or ${MAX_LISTING_BYTES >> 20} MiB`
    );
  }
  if (feedError && feedError !== unreadLimit) throw feedError;
  if (code !== 0)
    throw new Error(`tar ${args.join(" ")} exited with code ${code}: ${stderr.text().trim()}`);
  return stdout.text();
}

function normalizeTarMemberPath(memberPath: string): string {
  return memberPath.replace(/^\.\//, "").replace(/\\/g, "/");
}

/**
 * True for a relative path with no `..` segment, reading `\` as a separator
 * and `C:/` as a drive. Not normalized: in `a/..`, `..` applies where a link
 * `a` points.
 *
 * `C:x` with no separator is a path on drive C only to Windows, so only a
 * Windows receiver refuses it. Elsewhere it is a file name: macOS stores the
 * Finder name `A/B.app` as `A:B.app`. bsdtar extracts such a member without
 * the two characters, which leaves it inside the extract dir.
 *
 * Exported for its test, which asks for both receivers.
 */
export function isContainedPath(path: string, windows = process.platform === "win32"): boolean {
  const slashed = path.replace(/\\/g, "/");
  const drive = windows ? /^[A-Za-z]:/ : /^[A-Za-z]:\//;
  return !slashed.startsWith("/") && !drive.test(slashed) && !slashed.split("/").includes("..");
}

/** Reject tar-slip paths, and an entry for `destDir` itself, which would set its mode. */
function isSafeTarMember(memberPath: string, destDir: string): boolean {
  const normalized = normalizeTarMemberPath(memberPath);
  if (!isContainedPath(normalized)) return false;
  const root = resolve(destDir);
  return resolve(destDir, normalized).startsWith(root + sep);
}

/** {@link runTar} for a vetting pass, whose failure means the archive can't be read. */
async function readListing(
  archive: Archive,
  args: string[],
  signal?: AbortSignal
): Promise<string> {
  try {
    return await runTar(archive, args, signal);
  } catch (err) {
    signal?.throwIfAborted();
    throw new ArchiveError(
      `Could not read archive: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** List an archive's members without extracting, so they can be vetted first. */
async function listTarMembers(archive: Archive, signal?: AbortSignal): Promise<string[]> {
  const stdout = await readListing(archive, ["-t"], signal);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Reject members that could write or link outside `destDir`. Regular files and
 * directories pass; symlinks pass only with a relative target free of `..` (a
 * `.app` carries internal ones like `Current -> A`); every other type
 * (hardlink, device, fifo, …) is refused. Only `tar -tv`'s type char and
 * ` -> <target>` are read — the column-formatted name is not stable across tar
 * variants.
 */
async function assertSafeMemberTypes(archive: Archive, signal?: AbortSignal): Promise<void> {
  const stdout = await readListing(archive, ["-tv"], signal);
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
      if (parts.length !== 2 || !target || !isContainedPath(target)) {
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
async function assertSafeArchive(
  archive: Archive,
  destDir: string,
  signal?: AbortSignal
): Promise<void> {
  const members = await listTarMembers(archive, signal);
  if (members.length === 0) {
    throw new ArchiveError("Archive is empty.");
  }
  for (const member of members) {
    if (!isSafeTarMember(member, destDir)) {
      throw new ArchiveError(`Archive contains an unsafe path "${member}" — refusing extraction.`);
    }
  }
  await assertSafeMemberTypes(archive, signal);
}

/**
 * Prefer the expected bundle name, falling back to the sole real entry.
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
  expectedName: string,
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted();
  let archive: Archive;
  try {
    archive = { path: archivePath, format: await sniffFormat(archivePath) };
    if (archive.format === "zstd") await assertSingleCompleteZstdFrame(archivePath, signal);
  } catch (err) {
    signal?.throwIfAborted();
    throw new ArchiveError(
      `Could not read archive: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  await assertSafeArchive(archive, destDir, signal);
  signal?.throwIfAborted();
  await runTar(archive, ["-x", "-C", destDir], signal);
  const member = await resolveMember(destDir, expectedName);
  signal?.throwIfAborted();
  return member;
}
