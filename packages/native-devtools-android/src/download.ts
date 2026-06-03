import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import {
  detectHostPlatform,
  tryDetectHostPlatform,
  traceProcessorCacheDir,
  traceProcessorCachePath,
  type TraceProcessorPlatform,
} from "./platform";
import { TraceProcessorUnavailableError, isExecFormatError } from "./errors";
import { PERFETTO_VERSION } from "./bundled-meta";
import { traceProcessorShellPath } from "./index";

const execFileAsync = promisify(execFile);

/**
 * GitHub org hosting `argent-private-releases`. Defaults to the value the
 * proven-working `scripts/download-native-binaries.sh` uses (so the TS
 * downloader can't diverge from what currently packs). Overridable via env for
 * forks / mirrors. NOTE: the argent-private publisher workflow currently
 * targets `software-mansion/argent-private-releases` — that mismatch is tracked
 * as a separate cleanup; do not flip this without reconciling the publisher,
 * else every download 404s.
 */
export const ORG = process.env.ARGENT_TRACE_PROCESSOR_ORG ?? "software-mansion-labs";
const RELEASES_REPO = "argent-private-releases";

const MAX_ATTEMPTS = 3;
const PROBE_TIMEOUT_MS = 5_000;
// A real trace_processor_shell is ~12 MB; anything tiny is almost certainly an
// error page or truncated transfer. Cheap floor before the magic-byte check.
const MIN_BINARY_BYTES = 1024 * 1024;

export interface DownloadTraceProcessorOptions {
  platform: TraceProcessorPlatform;
  version: string;
  /**
   * Release tag (e.g. `argent-v0.8.1`). Omit to resolve it via
   * {@link resolveReleaseTag} (which honors `ARGENT_TRACE_PROCESSOR_TAG`,
   * else falls back to `argent-main`).
   */
  tag?: string;
  /** Progress callback: (bytesSoFar, totalBytes|null). */
  onProgress?: (downloaded: number, total: number | null) => void;
  signal?: AbortSignal;
}

export interface DownloadTraceProcessorResult {
  path: string;
  bytes: number;
  /** True when the cache already held the binary and nothing was fetched. */
  fromCache: boolean;
}

/**
 * Pick the `argent-private-releases` tag whose assets to download from.
 *
 * Precedence:
 *   1. `ARGENT_TRACE_PROCESSOR_TAG` — explicit override, wins over everything.
 *      Lets an operator/agent force a specific build, e.g. a branch build
 *      (`argent-my-branch`) or a pin to an older release (`argent-v0.7.1`),
 *      without overriding the whole asset URL.
 *   2. `argent-v<version>` for a clean installed version.
 *   3. `argent-main` (rolling) for an unknown version (dev tarball / source build).
 */
export function resolveReleaseTag(installedVersion: string | null | undefined): string {
  const override = process.env.ARGENT_TRACE_PROCESSOR_TAG;
  if (override) return override;
  if (installedVersion && installedVersion !== "unknown") {
    return `argent-v${installedVersion}`;
  }
  return "argent-main";
}

/**
 * Direct release-asset URL (objects.githubusercontent.com under the hood — no
 * GitHub API, so no per-IP API rate limit). Overridable wholesale via
 * `ARGENT_TRACE_PROCESSOR_URL` for self-hosted mirrors / offline proxies.
 */
function assetUrl(tag: string, platform: TraceProcessorPlatform): string {
  const override = process.env.ARGENT_TRACE_PROCESSOR_URL;
  if (override) return override;
  return `https://github.com/${ORG}/${RELEASES_REPO}/releases/download/${tag}/trace_processor_shell-${platform}`;
}

const MACHO_MAGICS = new Set([
  0xfeedface, // 32-bit
  0xfeedfacf, // 64-bit
  0xcefaedfe, // 32-bit, byte-swapped
  0xcffaedfe, // 64-bit, byte-swapped
  0xcafebabe, // fat / universal
  0xbebafeca, // fat, byte-swapped
]);

/**
 * Reject HTML 404 bodies / truncated transfers by sniffing the first 4 bytes
 * for an ELF (`\x7fELF`) or Mach-O magic. A real GitHub "Not Found" page starts
 * with `<` or whitespace, which fails this check.
 */
function looksLikeNativeBinary(magic: Buffer): boolean {
  if (magic.length < 4) return false;
  if (magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46) {
    return true; // ELF
  }
  return MACHO_MAGICS.has(magic.readUInt32BE(0)) || MACHO_MAGICS.has(magic.readUInt32LE(0));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true }
    );
  });
}

/** Per-attempt 404 carries this flag so the retry loop bails immediately. */
class HttpNotFoundError extends Error {}

async function fetchToFile(
  url: string,
  destTmp: string,
  opts: DownloadTraceProcessorOptions
): Promise<number> {
  const res = await fetch(url, { signal: opts.signal, redirect: "follow" });
  if (res.status === 404) {
    throw new HttpNotFoundError(`Asset not found (404): ${url}`);
  }
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (HTTP ${res.status}): ${url}`);
  }

  const totalHeader = res.headers.get("content-length");
  const total = totalHeader ? Number(totalHeader) : null;

  let downloaded = 0;
  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  if (opts.onProgress) {
    source.on("data", (chunk: Buffer) => {
      downloaded += chunk.length;
      opts.onProgress!(downloaded, Number.isFinite(total) ? total : null);
    });
  }
  await streamPipeline(source, fs.createWriteStream(destTmp), { signal: opts.signal });

  const stat = await fsp.stat(destTmp);
  return stat.size;
}

/**
 * Idempotently ensure the `trace_processor_shell` for `platform`/`version` is in
 * the `~/.argent` cache, downloading it if absent. Streams to a unique temp file
 * in the cache dir, verifies magic bytes + size, chmods 0o755, strips the macOS
 * quarantine xattr (best-effort), then **atomically renames** into place — so a
 * concurrent profiler / interrupted transfer can never leave a half-written
 * binary at the canonical path. Retries transient failures (3×, backoff); a 404
 * fails fast.
 */
export async function downloadTraceProcessor(
  opts: DownloadTraceProcessorOptions
): Promise<DownloadTraceProcessorResult> {
  const { platform, version } = opts;
  const finalPath = traceProcessorCachePath(version, platform);

  // Cache hit — nothing to fetch.
  if (fs.existsSync(finalPath)) {
    const { size } = await fsp.stat(finalPath);
    return { path: finalPath, bytes: size, fromCache: true };
  }

  const cacheDir = traceProcessorCacheDir(version, platform);
  try {
    await fsp.mkdir(cacheDir, { recursive: true });
  } catch (err) {
    throw wrapWriteError(err, cacheDir);
  }

  const tag = opts.tag ?? resolveReleaseTag(null);
  const url = assetUrl(tag, platform);
  // Unique temp name (pid + time + random) so racing downloaders don't collide;
  // the atomic rename below makes "last writer wins" safe.
  const tmpPath = path.join(
    cacheDir,
    `.trace_processor_shell.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2)}.tmp`
  );

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const bytes = await fetchToFile(url, tmpPath, opts);

      if (bytes < MIN_BINARY_BYTES) {
        throw new Error(
          `Downloaded file is implausibly small (${bytes} bytes) — likely an error page, not a binary.`
        );
      }
      const fh = await fsp.open(tmpPath, "r");
      try {
        const magic = Buffer.alloc(4);
        await fh.read(magic, 0, 4, 0);
        if (!looksLikeNativeBinary(magic)) {
          throw new Error(
            `Downloaded file is not a native executable (bad magic bytes) — got ${url}. ` +
              `The release asset may be missing for tag "${tag}".`
          );
        }
      } finally {
        await fh.close();
      }

      await fsp.chmod(tmpPath, 0o755);
      await stripQuarantine(tmpPath);
      // Atomic publish: rename within the same dir is atomic on POSIX/NTFS.
      await fsp.rename(tmpPath, finalPath);
      return { path: finalPath, bytes, fromCache: false };
    } catch (err) {
      lastErr = err;
      await fsp.unlink(tmpPath).catch(() => {});
      // A missing asset (404) or an aborted transfer won't fix itself on retry.
      if (err instanceof HttpNotFoundError || opts.signal?.aborted) break;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(2 ** attempt * 500, opts.signal).catch(() => {});
      }
    }
  }

  const cause = lastErr;
  throw wrapWriteError(cause, cacheDir, url);
}

/**
 * Resolve the binary and confirm it actually runs on this host in one shot:
 * `traceProcessorShellPath()` proves *presence* (throws
 * TraceProcessorUnavailableError when missing/env-invalid), then a quick
 * `--version` exec proves *architecture* (a wrong-arch binary fails with
 * ENOEXEC, which we remap to a wrong_arch error). Other `--version` failures
 * (timeout, odd exit) are tolerated — the real queries will surface them — so a
 * flaky probe never blocks a working binary. Call this before running the
 * analyze queries so a missing/wrong-arch binary becomes the actionable banner
 * rather than three identical per-query "Export warnings".
 */
export async function ensureTraceProcessorRunnable(): Promise<string> {
  const p = traceProcessorShellPath();
  try {
    await execFileAsync(p, ["--version"], { timeout: PROBE_TIMEOUT_MS });
  } catch (err) {
    if (isExecFormatError(err)) throw wrongArchError(err);
    // Non-format failure: binary exists and execs; let the real queries run.
  }
  return p;
}

/** Build a wrong-arch error tagged with the (best-effort) host platform. */
export function wrongArchError(cause?: unknown): TraceProcessorUnavailableError {
  return new TraceProcessorUnavailableError("wrong_arch", {
    platform: tryDetectHostPlatform() ?? undefined,
    version: PERFETTO_VERSION,
    cause,
  });
}

/**
 * Best-effort removal of the macOS Gatekeeper quarantine attribute. A
 * programmatic `fetch` doesn't set it, but a pre-staged or security-tool-touched
 * binary might, and Gatekeeper would then kill our unsigned binary with no
 * useful error. Non-fatal: the xattr usually isn't present.
 */
async function stripQuarantine(filePath: string): Promise<void> {
  if (process.platform !== "darwin") return;
  await execFileAsync("xattr", ["-d", "com.apple.quarantine", filePath]).catch(() => {});
}

/**
 * Turn a write/network failure into a clear message. A `~/.argent` that's
 * root-owned after a `sudo` global install yields EACCES on later non-root
 * writes — point the user at the `ARGENT_TRACE_PROCESSOR_PATH` escape hatch.
 */
function wrapWriteError(err: unknown, dir: string, url?: string): Error {
  const e = err as NodeJS.ErrnoException | undefined;
  if (e && (e.code === "EACCES" || e.code === "EPERM")) {
    return new Error(
      `Cannot write to the trace-processor cache at ${dir} (${e.code}). ` +
        `It may be owned by root after a sudo install. Either fix its ownership, ` +
        `or set ARGENT_TRACE_PROCESSOR_PATH to a pre-staged trace_processor_shell binary.`
    );
  }
  const detail = e?.message ?? String(err);
  return new Error(
    `Failed to download trace_processor_shell${url ? ` from ${url}` : ""}: ${detail}`
  );
}
