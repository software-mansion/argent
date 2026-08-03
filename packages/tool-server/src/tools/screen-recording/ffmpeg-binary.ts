import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import { commandOnPath } from "../../utils/command-on-path";

const execFileAsync = promisify(execFile);

/**
 * Which ffmpeg to record with.
 *
 * ffmpeg IS the recorder — it encodes simulator-server's frame stream straight
 * to mp4 with `-c:v libx264` (see `ffmpegArgs` in capture.ts), so a build
 * without libx264 can never work. Resolving by name alone is not enough: a
 * `--disable-gpl` build (conda-forge ships one) has no libx264, and when it sits
 * ahead of a good build on PATH every recording dies with
 * `Unrecognized option 'preset'` — `-preset` being a libx264-private option.
 * That is issue #621, and the known-good build was sitting in the fallback list
 * the whole time, unreachable because the list was only consulted when ffmpeg
 * was *absent*.
 *
 * So each candidate is asked whether it can actually encode, and the first one
 * that says yes wins.
 */

/** Package-manager prefixes to try when PATH has no usable ffmpeg. */
const FFMPEG_FALLBACK_PATHS = [
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/usr/bin/ffmpeg",
];

/**
 * `-hide_banner` is load-bearing, NOT cosmetic: without it ffmpeg writes its
 * build banner to stderr, and that banner's `configuration:` line contains the
 * literal `--enable-libx264`. Since the verdict is taken from stdout AND stderr
 * combined, dropping this flag would put a libx264-shaped string in front of any
 * looser matcher. (The marker below happens to survive it, but the next person
 * to relax the regex should not have to discover that.)
 *
 * Deliberately no `-loglevel`: it does not gate help output either way
 * (measured: `-loglevel error` and even `-loglevel quiet` still print the full
 * encoder help), so it would add a version-dependent variable for nothing.
 */
const PROBE_ARGS = ["-hide_banner", "-h", "encoder=libx264"];

/**
 * Generous purely as hang insurance — the probe measures ~33ms. It is longer
 * than `commandOnPath`'s 2s on purpose: this execs the real binary, which may be
 * on a stalled network mount or paying a first-run translation cost.
 */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * ffmpeg answers `-h encoder=libx264` with `Encoder libx264 [libx264 H.264 …]:`
 * when it has the encoder, and `Codec 'libx264' is not recognized by FFmpeg.`
 * when it does not — **exiting 0 either way**. The verdict therefore has to come
 * from the output, never from the exit status.
 *
 * Matching the success header rather than the failure sentence is deliberate:
 * `Encoder <name> [<desc>]:` comes from ffmpeg's help formatter and has been
 * stable for a decade, while the failure text is ordinary prose that any release
 * may reword. Keying on the failure string would mean a future ffmpeg silently
 * re-breaks recording — and it would break it for people whose setup works,
 * which is the one direction this must never fail in.
 *
 * `\bencoder\s+` (rather than a bare `libx264`) keeps `--enable-libx264` and
 * `libx264rgb` from counting.
 */
const LIBX264_MARKER = /\bencoder\s+libx264\b/i;

/** Point argent at a specific ffmpeg when discovery cannot find a usable one. */
const FFMPEG_OVERRIDE_ENV = "ARGENT_FFMPEG";

export type FfmpegResolution =
  | { ok: true; path: string; origin: "override" | "path" | "fallback" }
  | { ok: false; reason: "missing" | "unusable"; override: string | null; tried: string[] };

type Verdict =
  /** Answered with the encoder header — it can record. */
  | "supported"
  /** Answered, but without the header: a real "I don't have libx264". */
  | "unsupported"
  /** Nothing to execute at that path. */
  | "absent"
  /** Something is there but this user cannot execute it. */
  | "unrunnable"
  /** No trustworthy answer — timed out, was killed, or said nothing. */
  | "inconclusive";

/**
 * Ask one binary whether it can encode H.264.
 *
 * Anything short of a clear "no" is inconclusive, and an inconclusive candidate
 * is still usable (see {@link resolveFfmpeg}). The probe exists to demote a
 * build that positively told us it lacks libx264 — it must never be the reason
 * a working setup stops recording.
 */
async function probeLibx264(binary: string): Promise<Verdict> {
  try {
    const { stdout, stderr } = await execFileAsync(binary, PROBE_ARGS, {
      timeout: PROBE_TIMEOUT_MS,
    });
    return LIBX264_MARKER.test(`${stdout}\n${stderr}`) ? "supported" : "unsupported";
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: string | null;
    };
    // execFile still captures output when the child exits non-zero, so a build
    // that answers correctly and *then* exits non-zero is still supported.
    const output = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    if (LIBX264_MARKER.test(output)) return "supported";

    // A spawn failure sets a STRING code (ENOENT/EACCES); a non-zero exit sets a
    // NUMBER. Only the string form tells us anything about the binary itself.
    if (typeof e.code === "string") {
      if (e.code === "ENOENT") return "absent";
      // Not "absent": the file is there. Calling it missing would make the error
      // tell a user who HAS ffmpeg installed to go and install it.
      if (e.code === "EACCES" || e.code === "EPERM") return "unrunnable";
      return "inconclusive";
    }

    // Checked before the output test on purpose: a killed process may have
    // printed something first, but a partial answer from a run that never
    // finished is not evidence that libx264 is absent.
    if (e.killed || e.signal) return "inconclusive";

    return output.trim() ? "unsupported" : "inconclusive";
  }
}

/** Resolve the override, which may be a path or a bare command name. */
async function resolveOverridePath(value: string): Promise<string | null> {
  if (value.includes("/") || value.includes("\\") || path.isAbsolute(value)) {
    return (await isExecutable(value)) ? value : null;
  }
  // Bare name: go through commandOnPath, which validates the name before it
  // reaches a shell. The env value is user input and must never be interpolated.
  return commandOnPath(value);
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    // X_OK, not F_OK: a present-but-unexecutable file would only surface as an
    // opaque EACCES at spawn time.
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Canonical identity for dedup, so one binary is never probed twice. */
async function canonical(p: string): Promise<string> {
  const resolved = await realpath(p).catch(() => p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Candidates in priority order, deduplicated.
 *
 * `/opt/homebrew/bin/ffmpeg` is both the usual PATH hit and the first fallback,
 * and on Intel macs `/usr/local/bin/ffmpeg` symlinks to the same Cellar binary,
 * so without dedup the healthy host probes one file two or three times. Dedup on
 * the realpath but keep — and later spawn — the path we started from: that is
 * the name the user recognises, and a wrapper script must not be bypassed.
 */
async function collectCandidates(): Promise<Array<{ path: string; origin: "path" | "fallback" }>> {
  const out: Array<{ path: string; origin: "path" | "fallback" }> = [];
  const seen = new Set<string>();

  const add = async (p: string, origin: "path" | "fallback") => {
    const key = await canonical(p);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path: p, origin });
  };

  // commandOnPath returns an ABSOLUTE path and works on Windows, where the old
  // hand-rolled `/bin/sh -c command -v` could never match. Resolving to an
  // absolute path also means the binary we validate is the binary we spawn —
  // otherwise the probe proves nothing about what actually runs.
  const onPath = await commandOnPath("ffmpeg");
  if (onPath) await add(onPath, "path");

  for (const p of FFMPEG_FALLBACK_PATHS) {
    if (await isExecutable(p)) await add(p, "fallback");
  }
  return out;
}

/**
 * Pick an ffmpeg that can record, or explain why none can.
 *
 * Not cached, deliberately. The tool-server has no idle shutdown by default, so
 * a cached "no usable ffmpeg" would outlive the user installing one — they would
 * follow the advice in our own error message and watch it keep failing. One
 * probe per `screen-recording-start` (a human action, minutes apart) is nothing
 * against a start path that already waits ~800ms before it declares success.
 */
export async function resolveFfmpeg(): Promise<FfmpegResolution> {
  const override = (process.env[FFMPEG_OVERRIDE_ENV] ?? "").trim();
  if (override) {
    const resolved = await resolveOverridePath(override);
    if (!resolved) return { ok: false, reason: "missing", override, tried: [] };

    const verdict = await probeLibx264(resolved);
    if (verdict === "absent") return { ok: false, reason: "missing", override, tried: [] };
    if (verdict === "unrunnable") {
      return { ok: false, reason: "unusable", override, tried: [resolved] };
    }
    // The probe is ADVISORY here, and that is the whole point of the override.
    // Its job is to rescue the user whose ffmpeg the probe misjudges — a fork
    // whose help output we don't recognise reads as "unsupported", and refusing
    // it would make the escape hatch subject to the very filter it exists to
    // escape. If the binary really is libx264-less they get ffmpeg's own error,
    // which is exactly what they got before this change.
    return { ok: true, path: resolved, origin: "override" };
  }

  const candidates = await collectCandidates();
  const tried: string[] = [];
  let fallbackToInconclusive: { path: string; origin: "path" | "fallback" } | null = null;

  for (const candidate of candidates) {
    const verdict = await probeLibx264(candidate.path);
    if (verdict === "supported")
      return { ok: true, path: candidate.path, origin: candidate.origin };
    if (verdict === "absent") continue; // vanished between the check and the exec
    if (verdict === "inconclusive") {
      fallbackToInconclusive ??= candidate;
      continue;
    }
    tried.push(candidate.path);
  }

  // Nothing said yes, but something never gave a straight answer — use it. On
  // any host where recording worked before, this is the branch that keeps it
  // working: ffmpeg gets to speak for itself, exactly as it did previously.
  if (fallbackToInconclusive) {
    return { ok: true, path: fallbackToInconclusive.path, origin: fallbackToInconclusive.origin };
  }

  return tried.length > 0
    ? { ok: false, reason: "unusable", override: null, tried }
    : { ok: false, reason: "missing", override: null, tried: [] };
}

/**
 * The user-facing explanation. Pure, so it can be tested without mocking
 * anything — and so the wording is decided in one place rather than at a throw
 * site.
 */
export function ffmpegUnavailableMessage(result: Extract<FfmpegResolution, { ok: false }>): string {
  const { override, reason, tried } = result;

  if (override) {
    return reason === "missing"
      ? `\`${FFMPEG_OVERRIDE_ENV}\` is set to \`${override}\`, but there is no executable there. ` +
          `Point it at an ffmpeg binary, or unset it to let argent search PATH.`
      : `\`${FFMPEG_OVERRIDE_ENV}\` points at \`${override}\`, but it could not be run (check its ` +
          `permissions). Point it at an executable ffmpeg, or unset it to let argent search PATH.`;
  }

  if (reason === "missing") {
    return (
      "`ffmpeg` was not found on PATH or at " +
      `${FFMPEG_FALLBACK_PATHS.join(", ")}. ` +
      "Install it with your system package manager (`brew install ffmpeg` on macOS, " +
      "`apt install ffmpeg` on Debian/Ubuntu; on Fedora use RPM Fusion's `ffmpeg`, since the " +
      "default `ffmpeg-free` build has no libx264) or see https://ffmpeg.org/download.html, " +
      "then retry."
    );
  }

  // The case that made this message worth building: saying "ffmpeg was not
  // found" to someone with three ffmpegs installed is what sent the reporter
  // looking in the wrong place.
  return (
    `Found ffmpeg at ${tried.join(", ")}, but none of them can record: recording needs the ` +
    "`libx264` encoder to write H.264, and a `--disable-gpl` build does not have it — " +
    "conda-forge's and Fedora's default `ffmpeg-free` are both built that way. Install a full " +
    "build ahead of it on PATH (`brew install ffmpeg` on macOS, `apt install ffmpeg` on " +
    "Debian/Ubuntu, RPM Fusion's `ffmpeg` on Fedora), or point argent straight at one with " +
    `\`${FFMPEG_OVERRIDE_ENV}=/path/to/ffmpeg\`.`
  );
}
