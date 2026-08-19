import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, open, rm, symlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, posix, resolve, sep } from "node:path";
import { PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw, inflateRaw } from "node:zlib";
import { ArchiveError } from "./errors.js";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_ENTRY_SIGNATURE = 0x02014b50;
const LOCAL_ENTRY_SIGNATURE = 0x04034b50;
const ZIP64_SENTINEL = 0xffffffff;
const MAX_EOCD_SEARCH = 65_557;
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 50_000;
const MAX_BUFFERED_COMPRESSED_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_EXTRACTED_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_EXTRACTED_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_READ_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_SYMLINK_TARGET_BYTES = 4 * 1024;

interface ZipEntry {
  name: string;
  flags: number;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  unixMode: number;
  directory: boolean;
  symlink: boolean;
}

function artifactFailure(message: string, cause?: unknown): ArchiveError {
  return new ArchiveError(
    message,
    cause === undefined
      ? undefined
      : {
          cause:
            cause instanceof Error
              ? cause
              : new Error(typeof cause === "string" ? cause : "Unknown ZIP error"),
        }
  );
}

async function readAt(file: FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await file.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) throw artifactFailure("ZIP artifact ended unexpectedly.");
    offset += bytesRead;
  }
  return buffer;
}

function normalizeEntryName(rawName: string): string {
  if (!rawName || rawName.includes("\0") || rawName.includes("\\")) {
    throw artifactFailure("ZIP artifact contains an invalid entry name.");
  }
  const withoutDot = rawName.replace(/^(?:\.\/)+/, "");
  const normalized = posix.normalize(withoutDot);
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").includes("..")
  ) {
    throw artifactFailure(`ZIP artifact contains an unsafe path: ${rawName}.`);
  }
  return normalized.replace(/\/$/, "");
}

async function readZipEntriesFromHandle(file: FileHandle): Promise<ZipEntry[]> {
  const stat = await file.stat();
  if (stat.size < 22) throw artifactFailure("App artifact is not a valid ZIP file.");
  const tailLength = Math.min(stat.size, MAX_EOCD_SEARCH);
  const tail = await readAt(file, tailLength, stat.size - tailLength);

  let eocdOffset = -1;
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = tail.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === tail.length) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw artifactFailure("App artifact is not a valid ZIP file.");
  if (tail.readUInt16LE(eocdOffset + 4) !== 0 || tail.readUInt16LE(eocdOffset + 6) !== 0) {
    throw artifactFailure("Multi-disk ZIP artifacts are not supported.");
  }

  const entryCount = tail.readUInt16LE(eocdOffset + 10);
  const centralSize = tail.readUInt32LE(eocdOffset + 12);
  const centralOffset = tail.readUInt32LE(eocdOffset + 16);
  if (entryCount === 0xffff || centralSize === ZIP64_SENTINEL || centralOffset === ZIP64_SENTINEL) {
    throw artifactFailure("ZIP64 app artifacts are not supported.");
  }
  if (entryCount > MAX_ZIP_ENTRIES) {
    throw artifactFailure(`ZIP artifact contains more than ${MAX_ZIP_ENTRIES} entries.`);
  }
  if (centralSize <= 0 || centralSize > MAX_CENTRAL_DIRECTORY_BYTES) {
    throw artifactFailure("ZIP artifact central directory is empty or too large.");
  }
  if (centralOffset + centralSize > stat.size) {
    throw artifactFailure("ZIP artifact central directory is truncated.");
  }

  const central = await readAt(file, centralSize, centralOffset);
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let offset = 0;
  while (offset < central.length) {
    if (offset + 46 > central.length || central.readUInt32LE(offset) !== CENTRAL_ENTRY_SIGNATURE) {
      throw artifactFailure("ZIP artifact central directory is malformed.");
    }
    const nameLength = central.readUInt16LE(offset + 28);
    const extraLength = central.readUInt16LE(offset + 30);
    const commentLength = central.readUInt16LE(offset + 32);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    if (offset + recordLength > central.length) {
      throw artifactFailure("ZIP artifact central directory entry is truncated.");
    }
    const rawName = central.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const name = normalizeEntryName(rawName);
    if (names.has(name)) throw artifactFailure(`ZIP artifact contains duplicate path ${name}.`);
    names.add(name);

    const compressedSize = central.readUInt32LE(offset + 20);
    const uncompressedSize = central.readUInt32LE(offset + 24);
    const localHeaderOffset = central.readUInt32LE(offset + 42);
    if (
      compressedSize === ZIP64_SENTINEL ||
      uncompressedSize === ZIP64_SENTINEL ||
      localHeaderOffset === ZIP64_SENTINEL
    ) {
      throw artifactFailure("ZIP64 app artifacts are not supported.");
    }
    const versionMadeBy = central.readUInt16LE(offset + 4);
    const unixMode = versionMadeBy >>> 8 === 3 ? central.readUInt32LE(offset + 38) >>> 16 : 0;
    const fileType = unixMode & 0o170000;
    entries.push({
      name,
      flags: central.readUInt16LE(offset + 8),
      compressionMethod: central.readUInt16LE(offset + 10),
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      unixMode,
      directory: rawName.endsWith("/") || fileType === 0o040000,
      symlink: fileType === 0o120000,
    });
    offset += recordLength;
  }
  if (entries.length !== entryCount) {
    throw artifactFailure(
      `ZIP artifact declared ${entryCount} entries but contained ${entries.length}.`
    );
  }
  return entries;
}

function inflateRawBounded(compressed: Buffer, maxOutputLength: number): Promise<Buffer> {
  return new Promise((resolveInflated, rejectInflated) => {
    inflateRaw(compressed, { maxOutputLength: Math.max(1, maxOutputLength) }, (error, result) => {
      if (error) rejectInflated(error);
      else resolveInflated(result);
    });
  });
}

async function readEntryData(
  file: FileHandle,
  entry: ZipEntry,
  maxOutputBytes: number
): Promise<Buffer> {
  if ((entry.flags & 0x1) !== 0)
    throw artifactFailure("Encrypted ZIP artifacts are not supported.");
  if (entry.compressedSize > MAX_BUFFERED_COMPRESSED_ENTRY_BYTES) {
    throw artifactFailure(`ZIP entry ${entry.name} is too large to read into memory safely.`);
  }
  if (entry.uncompressedSize > maxOutputBytes) {
    throw artifactFailure(`ZIP entry ${entry.name} is too large to extract safely.`);
  }
  if (entry.compressionMethod === 0 && entry.compressedSize !== entry.uncompressedSize) {
    throw artifactFailure(`Stored ZIP entry ${entry.name} has inconsistent sizes.`);
  }
  const localHeader = await readAt(file, 30, entry.localHeaderOffset);
  if (localHeader.readUInt32LE(0) !== LOCAL_ENTRY_SIGNATURE) {
    throw artifactFailure(`ZIP entry ${entry.name} has an invalid local header.`);
  }
  const nameLength = localHeader.readUInt16LE(26);
  const extraLength = localHeader.readUInt16LE(28);
  const localName = normalizeEntryName(
    (await readAt(file, nameLength, entry.localHeaderOffset + 30)).toString("utf8")
  );
  if (localName !== entry.name) {
    throw artifactFailure(`ZIP entry ${entry.name} does not match its local header name.`);
  }
  const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const compressed = await readAt(file, entry.compressedSize, dataOffset);

  let result: Buffer;
  if (entry.compressionMethod === 0) result = compressed;
  else if (entry.compressionMethod === 8) {
    try {
      // The central-directory size is attacker controlled, so the decompressor
      // itself must enforce the bound. Comparing only after inflateRaw returns
      // would allow a tiny, lying entry to allocate until the process OOMs.
      result = await inflateRawBounded(compressed, entry.uncompressedSize);
    } catch (error) {
      throw artifactFailure(`Could not decompress ZIP entry ${entry.name}.`, error);
    }
  } else {
    throw artifactFailure(
      `ZIP entry ${entry.name} uses unsupported compression method ${entry.compressionMethod}.`
    );
  }
  if (result.byteLength !== entry.uncompressedSize) {
    throw artifactFailure(`ZIP entry ${entry.name} did not match its declared size.`);
  }
  return result;
}

async function writeEntryData(
  filePath: string,
  file: FileHandle,
  entry: ZipEntry,
  outputPath: string,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  if ((entry.flags & 0x1) !== 0) {
    throw artifactFailure("Encrypted ZIP artifacts are not supported.");
  }
  if (entry.uncompressedSize > MAX_EXTRACTED_ENTRY_BYTES) {
    throw artifactFailure(`ZIP entry ${entry.name} is too large to extract safely.`);
  }
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw artifactFailure(
      `ZIP entry ${entry.name} uses unsupported compression method ${entry.compressionMethod}.`
    );
  }
  if (entry.compressionMethod === 0 && entry.compressedSize !== entry.uncompressedSize) {
    throw artifactFailure(`Stored ZIP entry ${entry.name} has inconsistent sizes.`);
  }

  const localHeader = await readAt(file, 30, entry.localHeaderOffset);
  if (localHeader.readUInt32LE(0) !== LOCAL_ENTRY_SIGNATURE) {
    throw artifactFailure(`ZIP entry ${entry.name} has an invalid local header.`);
  }
  const nameLength = localHeader.readUInt16LE(26);
  const extraLength = localHeader.readUInt16LE(28);
  const localName = normalizeEntryName(
    (await readAt(file, nameLength, entry.localHeaderOffset + 30)).toString("utf8")
  );
  if (localName !== entry.name) {
    throw artifactFailure(`ZIP entry ${entry.name} does not match its local header name.`);
  }
  const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;

  if (entry.compressedSize === 0) {
    if (entry.uncompressedSize !== 0) {
      throw artifactFailure(`ZIP entry ${entry.name} did not match its declared size.`);
    }
    await writeFile(outputPath, Buffer.alloc(0), { flag: "wx" });
    return;
  }

  let written = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      written += chunk.byteLength;
      callback(
        written > entry.uncompressedSize
          ? artifactFailure(`ZIP entry ${entry.name} exceeded its declared size.`)
          : undefined,
        chunk
      );
    },
  });
  const source = createReadStream(filePath, {
    start: dataOffset,
    end: dataOffset + entry.compressedSize - 1,
  });
  const destination = createWriteStream(outputPath, { flags: "wx" });
  try {
    if (entry.compressionMethod === 8) {
      await pipeline(source, createInflateRaw(), counter, destination, { signal });
    } else {
      await pipeline(source, new PassThrough(), counter, destination, { signal });
    }
    if (written !== entry.uncompressedSize) {
      throw artifactFailure(`ZIP entry ${entry.name} did not match its declared size.`);
    }
  } catch (error) {
    await rm(outputPath, { force: true }).catch(() => {});
    if (error instanceof ArchiveError) throw error;
    throw artifactFailure(`Could not extract ZIP entry ${entry.name}.`, error);
  }
}

export async function looksLikeZip(filePath: string): Promise<boolean> {
  let file: FileHandle | undefined;
  try {
    file = await open(filePath, "r");
    const header = await readAt(file, 4, 0);
    const signature = header.readUInt32LE(0);
    return (
      signature === LOCAL_ENTRY_SIGNATURE ||
      signature === EOCD_SIGNATURE ||
      signature === 0x08074b50
    );
  } catch {
    return false;
  } finally {
    await file?.close().catch(() => {});
  }
}

export async function readZipEntry(
  filePath: string,
  entryName: string
): Promise<Buffer | undefined> {
  const file = await open(filePath, "r");
  try {
    const entries = await readZipEntriesFromHandle(file);
    const entry = entries.find((candidate) => candidate.name === entryName);
    return entry ? await readEntryData(file, entry, MAX_READ_ENTRY_BYTES) : undefined;
  } finally {
    await file.close();
  }
}

function assertInsideRoot(root: string, outputPath: string): void {
  const resolvedRoot = resolve(root);
  const resolvedOutput = resolve(outputPath);
  if (resolvedOutput !== resolvedRoot && !resolvedOutput.startsWith(resolvedRoot + sep)) {
    throw artifactFailure("ZIP artifact attempted to write outside its extraction directory.");
  }
}

export async function extractZipArchive(
  filePath: string,
  outputDir: string,
  options: { signal?: AbortSignal } = {}
): Promise<void> {
  const file = await open(filePath, "r");
  try {
    const entries = await readZipEntriesFromHandle(file);
    const totalSize = entries.reduce((total, entry) => total + entry.uncompressedSize, 0);
    if (!Number.isSafeInteger(totalSize) || totalSize > MAX_EXTRACTED_ARCHIVE_BYTES) {
      throw artifactFailure("ZIP artifact is too large to extract safely.");
    }

    const symlinkNames = new Set(
      entries.filter((entry) => entry.symlink).map((entry) => entry.name)
    );
    for (const entry of entries) {
      options.signal?.throwIfAborted();
      const parts = entry.name.split("/");
      for (let index = 1; index < parts.length; index += 1) {
        if (symlinkNames.has(parts.slice(0, index).join("/"))) {
          throw artifactFailure(
            `ZIP entry ${entry.name} is nested below an archive-controlled symlink.`
          );
        }
      }
    }

    const symlinkTargets = new Map<string, string>();
    for (const entry of entries.filter((candidate) => candidate.symlink)) {
      options.signal?.throwIfAborted();
      const outputPath = resolve(outputDir, entry.name);
      assertInsideRoot(outputDir, outputPath);
      const target = (await readEntryData(file, entry, MAX_SYMLINK_TARGET_BYTES)).toString("utf8");
      const normalizedTarget = target.replace(/\\/g, "/");
      if (
        !target ||
        target.includes("\0") ||
        target.includes("\\") ||
        posix.isAbsolute(normalizedTarget) ||
        /^[A-Za-z]:\//.test(normalizedTarget) ||
        posix.normalize(normalizedTarget).split("/").includes("..")
      ) {
        throw artifactFailure(`ZIP entry ${entry.name} contains an unsafe symlink.`);
      }
      assertInsideRoot(outputDir, resolve(dirname(outputPath), normalizedTarget));
      symlinkTargets.set(entry.name, target);
    }

    // Materialize regular files before symlinks. No archive-controlled symlink
    // can therefore redirect a later write outside the fresh extraction root.
    for (const entry of entries.filter((candidate) => !candidate.symlink)) {
      options.signal?.throwIfAborted();
      const outputPath = resolve(outputDir, entry.name);
      assertInsideRoot(outputDir, outputPath);
      if (entry.directory) {
        await mkdir(outputPath, { recursive: true });
      } else {
        await mkdir(dirname(outputPath), { recursive: true });
        await writeEntryData(filePath, file, entry, outputPath, options.signal);
      }
      const permissions = entry.unixMode & 0o777;
      if (permissions) await chmod(outputPath, permissions);
    }

    for (const entry of entries.filter((candidate) => candidate.symlink)) {
      options.signal?.throwIfAborted();
      const outputPath = resolve(outputDir, entry.name);
      assertInsideRoot(outputDir, outputPath);
      await mkdir(dirname(outputPath), { recursive: true });
      await symlink(symlinkTargets.get(entry.name)!, outputPath);
    }
  } finally {
    await file.close();
  }
}
