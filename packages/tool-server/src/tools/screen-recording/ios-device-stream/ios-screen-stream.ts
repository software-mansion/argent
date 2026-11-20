import * as crypto from "crypto";
import * as os from "os";
import * as path from "path";
import { existsSync, promises as fs } from "fs";
import { execFile, spawn, type ChildProcess } from "child_process";
import { promisify } from "util";
import {
  FAILURE_CODES,
  FailureError,
  subprocessFailureMetadata,
  type FailureCode,
} from "@argent/registry";

/**
 * Frames of a cabled iPhone's screen, from a host-side helper. A physical
 * iPhone has no simulator-server, but macOS exposes its screen (what
 * QuickTime's "New Movie Recording" shows) as a CoreMediaIO capture device.
 * `ios-screen-stream.swift` captures it and serves the same MJPEG stream
 * simulator-server does, so the recording pipeline in `capture.ts` is shared.
 *
 * The helper ships as source and is compiled with `xcrun swiftc` on first use,
 * the way the on-device runner is built with xcodebuild: anyone driving a
 * physical iPhone already has Xcode.
 */

const execFileAsync = promisify(execFile);

const SOURCE_FILE = "ios-screen-stream.swift";
const PLIST_FILE = "Info.plist";
const BINARY_NAME = "ios-screen-stream";
/** Matches the embedded Info.plist, so macOS files the camera grant under one name. */
const SIGNING_IDENTIFIER = "com.swmansion.argent.ios-screen-stream";
const COMPILE_TIMEOUT_MS = 180_000;
/** Opt-in, discovery and the listener take well under a second once allowed. */
const READY_TIMEOUT_MS = 15_000;
/** How long the user has to answer the macOS camera prompt (the helper waits 120s). */
const PERMISSION_TIMEOUT_MS = 130_000;
const KILL_GRACE_MS = 2_000;

export interface IosScreenStream {
  /** MJPEG endpoint on 127.0.0.1. */
  readonly streamUrl: string;
  /** The capture device's name, as macOS reports it. */
  readonly deviceName: string;
  /** Stop the helper. Idempotent, never throws. */
  close(): void;
}

// __dirname differs by build: bundled it is argent/dist/ (sources copied to
// argent/assets/ios-screen-stream/); in dev the build copies them beside this
// module in tool-server/dist, and ts-node and vitest read them from src.
export function resolveSourceDir(moduleDir: string = __dirname): string {
  const candidates = [
    path.resolve(moduleDir, "..", "assets", "ios-screen-stream"),
    path.resolve(moduleDir),
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, SOURCE_FILE))) return dir;
  }
  throw new FailureError(
    `The iPhone screen-capture helper source (${SOURCE_FILE}) was not found. Looked in:\n` +
      candidates.map((c) => `  - ${c}`).join("\n"),
    {
      error_code: FAILURE_CODES.SCREEN_RECORDING_DEVICE_HELPER_BUILD_FAILED,
      failure_stage: "screen_recording_device_helper_resolve",
      failure_area: "tool_server",
      error_kind: "dependency_missing",
    }
  );
}

function cacheRoot(): string {
  return path.join(os.homedir(), ".argent", "ios-screen-stream");
}

/**
 * Compile the helper once per source revision. The key is the source alone,
 * not the compiler version: macOS ties the camera grant to the binary, so a
 * rebuild after an Xcode update would ask the user again for nothing.
 */
export async function ensureHelperBinary(sourceDir: string = resolveSourceDir()): Promise<string> {
  const source = await fs.readFile(path.join(sourceDir, SOURCE_FILE));
  const plist = await fs.readFile(path.join(sourceDir, PLIST_FILE));
  const key = crypto.createHash("sha256").update(source).update(plist).digest("hex").slice(0, 16);
  const dir = path.join(cacheRoot(), key);
  const binary = path.join(dir, BINARY_NAME);
  if (existsSync(binary)) return binary;

  await fs.mkdir(dir, { recursive: true });
  // Unique per build, renamed into place: two tool-servers compiling at once
  // each finish their own file and the last rename wins with an identical one.
  const staging = `${binary}.${process.pid}.${Date.now()}`;
  try {
    await execFileAsync(
      "xcrun",
      [
        "swiftc",
        "-O",
        path.join(sourceDir, SOURCE_FILE),
        "-o",
        staging,
        // Gives the bare executable the camera usage string macOS needs to
        // show its prompt.
        "-Xlinker",
        "-sectcreate",
        "-Xlinker",
        "__TEXT",
        "-Xlinker",
        "__info_plist",
        "-Xlinker",
        path.join(sourceDir, PLIST_FILE),
      ],
      { timeout: COMPILE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }
    );
    await execFileAsync("codesign", ["-s", "-", "-f", "-i", SIGNING_IDENTIFIER, staging], {
      timeout: 30_000,
    });
    await fs.rename(staging, binary);
  } catch (err) {
    await fs.rm(staging, { force: true }).catch(() => {});
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new FailureError(
      `Could not compile the iPhone screen-capture helper with \`xcrun swiftc\`. ` +
        `Install Xcode and run \`sudo xcode-select -s /Applications/Xcode.app\` if it is not selected.` +
        (stderr ? ` stderr: ${stderr.slice(-600)}` : ""),
      {
        error_code: FAILURE_CODES.SCREEN_RECORDING_DEVICE_HELPER_BUILD_FAILED,
        failure_stage: "screen_recording_device_helper_compile",
        failure_area: "tool_server",
        error_kind: "subprocess",
        ...subprocessFailureMetadata(err, "swiftc"),
      },
      err instanceof Error ? { cause: err } : undefined
    );
  }
  return binary;
}

type HelperEvent =
  | { event: "awaiting_permission" }
  | { event: "ready"; port: number; device: string }
  | { event: "error"; code: string; message: string };

function helperFailure(code: string, message: string): FailureError {
  const map: Record<string, { error_code: FailureCode; error_kind: "not_found" | "unsupported" }> =
    {
      device_not_found: {
        error_code: FAILURE_CODES.SCREEN_RECORDING_DEVICE_SCREEN_NOT_FOUND,
        error_kind: "not_found",
      },
      ambiguous_device: {
        error_code: FAILURE_CODES.SCREEN_RECORDING_DEVICE_SCREEN_NOT_FOUND,
        error_kind: "not_found",
      },
      camera_permission_denied: {
        error_code: FAILURE_CODES.SCREEN_RECORDING_DEVICE_CAMERA_PERMISSION_DENIED,
        error_kind: "unsupported",
      },
    };
  const known = map[code];
  return new FailureError(message, {
    error_code: known?.error_code ?? FAILURE_CODES.SCREEN_RECORDING_DEVICE_HELPER_FAILED,
    failure_stage: "screen_recording_device_helper_start",
    failure_area: "tool_server",
    error_kind: known?.error_kind ?? "subprocess",
    failure_command: "ios_screen_stream",
  });
}

function stopChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // stdin EOF is the helper's own exit signal; SIGTERM backs it up, SIGKILL
  // covers a helper wedged in CoreMediaIO.
  child.stdin?.end();
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
  timer.unref();
  child.once("exit", () => clearTimeout(timer));
}

/**
 * Start capturing the screen of the cabled iPhone named `deviceName` and
 * resolve once its stream is being served. The first run on a Mac compiles
 * the helper and may wait on the macOS camera prompt.
 */
export async function startIosScreenStream(
  deviceName: string | undefined
): Promise<IosScreenStream> {
  const binary = await ensureHelperBinary();
  const args = deviceName ? ["--name", deviceName] : [];
  const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin?.on("error", () => {});
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-2_000);
  });

  return new Promise<IosScreenStream>((resolve, reject) => {
    let settled = false;
    let buffered = "";
    let timer = setTimeout(() => onTimeout(READY_TIMEOUT_MS), READY_TIMEOUT_MS);

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const failWith = (err: Error) =>
      settle(() => {
        stopChild(child);
        reject(err);
      });
    const onTimeout = (waitedMs: number) =>
      failWith(
        new FailureError(
          `The iPhone screen-capture helper did not start within ${waitedMs / 1000}s.` +
            (stderr ? ` stderr: ${stderr.trim().slice(-600)}` : ""),
          {
            error_code: FAILURE_CODES.SCREEN_RECORDING_DEVICE_HELPER_FAILED,
            failure_stage: "screen_recording_device_helper_ready",
            failure_area: "tool_server",
            error_kind: "timeout",
            failure_command: "ios_screen_stream",
          }
        )
      );

    const onEvent = (evt: HelperEvent) => {
      if (evt.event === "awaiting_permission") {
        clearTimeout(timer);
        timer = setTimeout(() => onTimeout(PERMISSION_TIMEOUT_MS), PERMISSION_TIMEOUT_MS);
      } else if (evt.event === "error") {
        failWith(helperFailure(evt.code, evt.message));
      } else if (evt.event === "ready") {
        settle(() =>
          resolve({
            streamUrl: `http://127.0.0.1:${evt.port}/`,
            deviceName: evt.device,
            close: () => stopChild(child),
          })
        );
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        try {
          onEvent(JSON.parse(line) as HelperEvent);
        } catch {
          // Not a protocol line; ignore.
        }
      }
    });
    child.once("error", (err) =>
      failWith(
        new FailureError(
          `Could not launch the iPhone screen-capture helper: ${err.message}`,
          {
            error_code: FAILURE_CODES.SCREEN_RECORDING_DEVICE_HELPER_FAILED,
            failure_stage: "screen_recording_device_helper_spawn",
            failure_area: "tool_server",
            error_kind: "subprocess",
            ...subprocessFailureMetadata(err, "ios_screen_stream"),
          },
          { cause: err }
        )
      )
    );
    child.once("exit", (code, signal) =>
      failWith(
        new FailureError(
          `The iPhone screen-capture helper exited (${signal ? `signal ${signal}` : `code ${code ?? "?"}`}) before it was ready.` +
            (stderr ? ` stderr: ${stderr.trim().slice(-600)}` : ""),
          {
            error_code: FAILURE_CODES.SCREEN_RECORDING_DEVICE_HELPER_FAILED,
            failure_stage: "screen_recording_device_helper_ready",
            failure_area: "tool_server",
            error_kind: "subprocess",
            ...subprocessFailureMetadata({ code, signal }, "ios_screen_stream"),
          }
        )
      )
    );
  });
}
