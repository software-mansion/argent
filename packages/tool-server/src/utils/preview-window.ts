import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { electronGuiChildEnv } from "./electron-env";

/**
 * macOS only. Build (and cache) a thin `.app` wrapper around the installed
 * Electron.app whose Info.plist names it "Argent Lens", so the OS labels the
 * window — menu bar, Cmd-Tab, Dock — "Argent Lens" instead of "Electron"
 * (`app.setName()` at runtime cannot override that).
 *
 * The wrapper symlinks Electron's Frameworks/Resources instead of copying
 * ~270MB, but a symlinked bundle with a modified Info.plist no longer matches
 * the signed Helper apps inside, so the OS sandbox cannot initialise and the
 * helpers crash unless launched with `--no-sandbox` (the caller adds it).
 * Acceptable here: the window only loads the tool-server's own localhost
 * preview UI, and the renderer still runs with contextIsolation + sandbox:true.
 * Avoiding `--no-sandbox` would need a re-signed copy of Electron.app (à la
 * @electron/packager) and that ~270MB.
 *
 * Returns the wrapper's executable path, or null to fall back to plain Electron
 * (non-macOS, or any failure).
 */
function ensureLensAppBundle(electronBin: string): string | null {
  if (process.platform !== "darwin") return null;
  try {
    const realApp = electronBin.replace(/\/Contents\/MacOS\/[^/]+$/, "");
    if (!realApp.endsWith(".app")) return null;
    const realContents = path.join(realApp, "Contents");
    const wrapperContents = path.join(
      os.tmpdir(),
      "argent-lens-app",
      "Argent Lens.app",
      "Contents"
    );
    const wrapperExec = path.join(wrapperContents, "MacOS", "Electron");
    // Rebuild only if the cached wrapper is missing or points at a different
    // Electron install (e.g. an upgrade moved the binary).
    try {
      if (fs.realpathSync(wrapperExec) === fs.realpathSync(electronBin)) return wrapperExec;
    } catch {
      /* not built yet */
    }
    fs.rmSync(path.dirname(wrapperContents), { recursive: true, force: true });
    fs.mkdirSync(path.join(wrapperContents, "MacOS"), { recursive: true });
    fs.symlinkSync(path.join(realContents, "Frameworks"), path.join(wrapperContents, "Frameworks"));
    fs.symlinkSync(path.join(realContents, "Resources"), path.join(wrapperContents, "Resources"));
    fs.symlinkSync(electronBin, wrapperExec);
    const pkgInfo = path.join(realContents, "PkgInfo");
    if (fs.existsSync(pkgInfo)) fs.copyFileSync(pkgInfo, path.join(wrapperContents, "PkgInfo"));
    // PlistBuddy is a macOS system tool and handles binary plists, so no new
    // dep. CFBundleExecutable stays "Electron" so the Helper apps still resolve.
    const plist = path.join(wrapperContents, "Info.plist");
    fs.copyFileSync(path.join(realContents, "Info.plist"), plist);
    const setPlist = (entry: string, value: string): void => {
      try {
        execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${entry} ${value}`, plist]);
      } catch {
        try {
          execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${entry} string ${value}`, plist]);
        } catch {
          /* leave the original value if PlistBuddy can't set it */
        }
      }
    };
    setPlist("CFBundleName", "Argent Lens");
    setPlist("CFBundleDisplayName", "Argent Lens");
    setPlist("CFBundleIdentifier", "com.swmansion.argent.lens");
    return wrapperExec;
  } catch {
    return null;
  }
}

/**
 * Tool-server side of the Electron preview window: one child, spawned on demand
 * and reused across rounds for the tool-server's lifetime.
 *
 * No IPC port — commands go to the child as line-delimited JSON over stdin, and
 * the child loads the tool-server's own `/preview/` HTTP URL.
 */
interface PreviewWindowManager {
  /** Spawn the window if not running; foreground + (re)load otherwise. */
  ensureOpen(url: string): void;
  /** Ask the window to play the close animation and exit. */
  requestClose(): void;
  /** Hard kill any live child; safe to call multiple times. */
  dispose(): void;
}

interface PreviewWindowManagerOptions {
  /** Override for tests / unusual installs (default: `require("electron")`). */
  electronBinaryPath?: string;
  /** Override for tests. */
  mainScript?: string;
  /** Optional error sink — defaults to stderr. */
  onError?: (err: Error) => void;
  /**
   * Called when the window fails to LAUNCH — the synchronous resolve throws
   * (commonly: `electron` is an optionalDependency and absent) or the child
   * emits `error`. Lets callers fail fast instead of leaving a parked
   * `await_user_selection` to time out.
   */
  onLaunchFailure?: (err: Error) => void;
}

export function createPreviewWindowManager(
  opts: PreviewWindowManagerOptions = {}
): PreviewWindowManager {
  let child: ChildProcess | null = null;
  // True between `requestClose()` and the child's exit: it is playing the close
  // animation and will quit, so `ensureOpen` must respawn rather than foreground
  // a doomed window that would then quit under the next round.
  let closing = false;

  const reportError = (err: Error): void => {
    if (opts.onError) opts.onError(err);
    else process.stderr.write(`[preview-window] ${err.message}\n`);
  };

  const send = (msg: { cmd: string; [k: string]: unknown }): void => {
    if (!child || !child.stdin || child.stdin.destroyed) return;
    try {
      child.stdin.write(JSON.stringify(msg) + "\n");
    } catch (err) {
      reportError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const resolveElectronBin = (): string => {
    if (opts.electronBinaryPath) return opts.electronBinaryPath;
    // `require("electron")` from outside an Electron context returns the
    // path string to the Electron executable shipped in node_modules.
    return require("electron") as string;
  };

  const resolveMainScript = (): string => {
    if (opts.mainScript) return opts.mainScript;
    // The published @swmansion/argent bundle drops the compiled main next to
    // the tool-server bundle, where `@argent/preview-window` is not a sibling
    // install and require.resolve would fail. In workspace dev it is.
    const bundled = path.join(__dirname, "preview-window", "main.cjs");
    if (fs.existsSync(bundled)) return bundled;
    return require.resolve("@argent/preview-window/dist/main.js");
  };

  const isAlive = (c: ChildProcess | null): c is ChildProcess =>
    c !== null && c.exitCode === null && !c.killed;

  const ensureOpen = (url: string): void => {
    // A mid-close child would strand this round, so respawn instead; it quits on
    // its own, having already been sent `close`.
    if (isAlive(child) && !closing) {
      send({ cmd: "foreground", url });
      return;
    }
    let electronBin: string;
    let mainScript: string;
    try {
      electronBin = resolveElectronBin();
      mainScript = resolveMainScript();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e);
      opts.onLaunchFailure?.(e);
      return;
    }
    // The wrapper bundle names the window, and needs `--no-sandbox` to run (see
    // ensureLensAppBundle). Falls back to plain Electron off macOS or on failure.
    const wrapperBin = ensureLensAppBundle(electronBin);
    const launchBin = wrapperBin ?? electronBin;
    const launchArgs = wrapperBin ? ["--no-sandbox", mainScript] : [mainScript];
    const next = spawn(launchBin, launchArgs, {
      // Strips ELECTRON_RUN_AS_NODE, which an Electron-based MCP host leaves in
      // our env, so the child boots as a GUI app instead of bare Node.
      env: electronGuiChildEnv({ ARGENT_PREVIEW_URL: url }),
      stdio: ["pipe", "ignore", "pipe"],
    });
    // `spawn` reports ENOENT / EACCES asynchronously. Clear `child` so a
    // follow-up `ensureOpen` retries instead of no-oping against a dead handle
    // that hasn't yet emitted `exit`.
    next.on("error", (err) => {
      if (child === next) {
        child = null;
        closing = false;
      }
      reportError(err);
      opts.onLaunchFailure?.(err);
    });
    next.on("exit", () => {
      // A respawn may already have replaced this handle, and the newer child
      // owns its own state.
      if (child === next) {
        child = null;
        closing = false;
      }
    });
    next.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[preview-window] ${chunk}`);
    });
    child = next;
    closing = false;
  };

  const requestClose = (): void => {
    if (!isAlive(child)) return;
    closing = true;
    send({ cmd: "close" });
  };

  const dispose = (): void => {
    if (isAlive(child)) child.kill();
    child = null;
    closing = false;
  };

  return { ensureOpen, requestClose, dispose };
}
