import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * macOS only. Build (and cache) a thin `.app` wrapper around the installed
 * Electron.app whose Info.plist `CFBundleName` is "Argent Lens", so the OS names
 * the window — menu bar, Cmd-Tab, Dock — "Argent Lens" instead of "Electron"
 * (the framework default, which `app.setName()` at runtime cannot override).
 *
 * The wrapper SYMLINKS Electron's heavy Frameworks/Resources — there is no
 * ~270MB copy — and supplies only its own Info.plist + a symlinked executable.
 * The catch: a symlinked bundle with a modified Info.plist no longer matches the
 * signed Helper apps inside Frameworks, so the OS sandbox cannot initialise and
 * the helper processes crash unless the app is launched with `--no-sandbox`
 * (the caller adds it). That is an acceptable trade-off for THIS window: it only
 * ever loads the tool-server's own localhost preview UI — never untrusted or
 * remote content — and the renderer still runs with contextIsolation +
 * sandbox:true at the Electron level. The full alternative (a renamed, deeply
 * re-signed copy of Electron.app, à la @electron/packager) is what avoids
 * `--no-sandbox`, at the cost of that ~270MB copy.
 *
 * Returns the wrapper's executable path, or null to fall back to plain Electron
 * (non-macOS, or any failure — the window still opens, just named "Electron").
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
    // Reuse the cached wrapper unless it's missing or points at a different
    // Electron install (e.g. an upgrade moved the binary).
    try {
      if (fs.realpathSync(wrapperExec) === fs.realpathSync(electronBin)) return wrapperExec;
    } catch {
      /* not built yet — fall through and build it */
    }
    fs.rmSync(path.dirname(wrapperContents), { recursive: true, force: true });
    fs.mkdirSync(path.join(wrapperContents, "MacOS"), { recursive: true });
    fs.symlinkSync(path.join(realContents, "Frameworks"), path.join(wrapperContents, "Frameworks"));
    fs.symlinkSync(path.join(realContents, "Resources"), path.join(wrapperContents, "Resources"));
    fs.symlinkSync(electronBin, wrapperExec);
    const pkgInfo = path.join(realContents, "PkgInfo");
    if (fs.existsSync(pkgInfo)) fs.copyFileSync(pkgInfo, path.join(wrapperContents, "PkgInfo"));
    // Custom Info.plist: copy Electron's, rename the display fields. PlistBuddy
    // is a macOS system tool (handles binary or XML plists), so no new dep. Keep
    // CFBundleExecutable = "Electron" so the signed Helper apps still resolve.
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
 * Tool-server side of the Electron preview window. A single Electron child
 * is spawned on demand when `await_user_selection` parks and quits (with an
 * animated squeeze) when the user submits — same window is reused across
 * multiple await cycles within one tool-server lifetime.
 *
 * No ports: communication with the child is line-delimited JSON over stdin.
 * The child loads the tool-server's HTTP `/preview/` URL directly; the
 * tool-server's port is already ephemeral in production
 * (`argent-tools-client/src/launcher.ts` uses `findFreePort`).
 */
export interface PreviewWindowManager {
  /** Spawn the window if not running; foreground + (re)load otherwise. */
  ensureOpen(url: string): void;
  /** Ask the window to play the close animation and exit. */
  requestClose(): void;
  /** Hard kill any live child; safe to call multiple times. */
  dispose(): void;
}

export interface PreviewWindowManagerOptions {
  /** Override for tests / unusual installs (default: `require("electron")`). */
  electronBinaryPath?: string;
  /** Override for tests (default: `@argent/preview-window/dist/main.js`). */
  mainScript?: string;
  /** Optional error sink — defaults to stderr. */
  onError?: (err: Error) => void;
  /**
   * Called specifically when the window FAILS TO LAUNCH — either the
   * synchronous electron/main-script resolve throws (the common
   * electron-absent case, since `electron` is an optionalDependency) or the
   * spawned child emits `error` (ENOENT / EACCES). NOT called for failures
   * after the window is already up. Lets callers fail fast with actionable
   * guidance instead of leaving a parked `await_user_selection` to time out.
   */
  onLaunchFailure?: (err: Error) => void;
}

export function createPreviewWindowManager(
  opts: PreviewWindowManagerOptions = {}
): PreviewWindowManager {
  let child: ChildProcess | null = null;
  // True between `requestClose()` and the child actually exiting — the window
  // is playing its close animation and will quit shortly. A child in this state
  // must NOT be reused: foregrounding it would hand a doomed window to a fresh
  // round, which then quits under the user (the round is left windowless until
  // its await times out). `ensureOpen` treats a still-alive-but-closing child as
  // not-reusable and respawns. Cleared on a fresh spawn and on child `exit`.
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
    // Two layouts to support:
    //   1) Published @swmansion/argent bundle. The bundler drops the
    //      preview-window's compiled main next to the tool-server bundle
    //      at <install>/dist/preview-window/main.cjs. The workspace pkg
    //      `@argent/preview-window` isn't a sibling install at that
    //      point, so require.resolve would fail.
    //   2) Workspace dev (ts-node from packages/tool-server/src). The
    //      sibling package IS resolvable; fall through to that.
    const bundled = path.join(__dirname, "preview-window", "main.cjs");
    if (fs.existsSync(bundled)) return bundled;
    return require.resolve("@argent/preview-window/dist/main.js");
  };

  const isAlive = (c: ChildProcess | null): c is ChildProcess =>
    c !== null && c.exitCode === null && !c.killed;

  const ensureOpen = (url: string): void => {
    // Reuse the window only if it is alive AND not mid-close. A closing child is
    // about to quit, so foregrounding it would strand this round — spawn a fresh
    // one instead. The closing child quits on its own (it already got `close`).
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
    // On macOS, launch through the "Argent Lens" wrapper bundle so the OS names
    // the window correctly. The wrapper needs `--no-sandbox` (see
    // ensureLensAppBundle); both fall back to plain Electron when the wrapper
    // can't be built, so the window always opens.
    const wrapperBin = ensureLensAppBundle(electronBin);
    const launchBin = wrapperBin ?? electronBin;
    const launchArgs = wrapperBin ? ["--no-sandbox", mainScript] : [mainScript];
    const next = spawn(launchBin, launchArgs, {
      env: { ...process.env, ARGENT_PREVIEW_URL: url },
      stdio: ["pipe", "ignore", "pipe"],
    });
    // `spawn` does not throw synchronously for ENOENT / EACCES — the error
    // arrives asynchronously. Clear `child` here too so a follow-up
    // `ensureOpen` retries cleanly instead of no-oping against a dead handle
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
      // Only the CURRENT child's exit resets state. If a respawn already
      // replaced this handle (a new round opened while this one was closing),
      // `child` points at the newer child and its `closing` is its own.
      if (child === next) {
        child = null;
        closing = false;
      }
    });
    next.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[preview-window] ${chunk}`);
    });
    child = next;
    // This is a freshly-spawned, live window — not closing.
    closing = false;
  };

  const requestClose = (): void => {
    if (!isAlive(child)) return;
    // Mark the window as closing so a round that parks during the close
    // animation respawns instead of reusing this about-to-quit child.
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
