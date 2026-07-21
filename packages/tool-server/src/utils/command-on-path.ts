import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { win32 as pathWin32 } from "node:path";

const execFileAsync = promisify(execFile);

/**
 * Resolve a command name to its absolute path using the OS' own PATH-lookup
 * tool, *without* executing the command itself (a bare `xcrun`/`adb` call would
 * fork the tool just to probe existence — slower, and `xcrun` can pop the Xcode
 * license dialog on first use). Returns the first match, or `null` if the name
 * isn't on PATH.
 *
 * - POSIX: `command -v <name>` via `/bin/sh`. Portable across shells and also
 *   resolves builtins/aliases; prints the path on stdout and exits non-zero on
 *   a miss.
 * - Windows: `where <name>` (ships in System32, always on PATH). It prints one
 *   line per match (e.g. both `adb.exe` and an `adb.bat` shim) and exits
 *   non-zero when nothing matches. `where` also handles the executable-extension
 *   search (`adb` → `adb.exe`) that `command -v` does not, which is exactly what
 *   callers want here. Unlike POSIX PATH lookup, `where` searches the current
 *   directory *before* PATH, so we drop any match that lives in the CWD: a tool
 *   like `adb.exe` sitting in the tool-server's working directory must never be
 *   preferred over the real one on PATH (that would let a repo plant a binary
 *   Argent then executes). This keeps Windows resolution PATH-only, matching the
 *   POSIX branch.
 *
 * Centralised so the three resolvers that need it (android-binary, check-deps,
 * vega-cli) share one cross-platform implementation instead of each hardcoding
 * the POSIX `/bin/sh` form (which silently never matches on Windows).
 */
export async function commandOnPath(name: string): Promise<string | null> {
  // Command names are bare binary names. Rejecting anything else keeps the
  // POSIX branch's `/bin/sh -c` interpolation safe if a future caller passes
  // untrusted input, and stops `where`'s glob matching (`adb*`) from resolving
  // something the caller didn't ask for. Behaviour-neutral for every current
  // caller (all pass fixed literals); a hostile/malformed name becomes `null`.
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return null;
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("where", [name], { timeout: 2_000 });
      // Use win32 path semantics explicitly so this is correct on a real
      // Windows host and unit-testable on POSIX CI.
      const cwd = pathWin32.resolve(process.cwd()).toLowerCase();
      const match = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        // Skip the CWD entry `where` lists ahead of PATH — Windows paths are
        // case-insensitive, so compare normalized + lowercased directories.
        .find((candidate) => pathWin32.resolve(pathWin32.dirname(candidate)).toLowerCase() !== cwd);
      return match ?? null;
    }
    const { stdout } = await execFileAsync("/bin/sh", ["-c", `command -v ${name}`], {
      timeout: 2_000,
    });
    const trimmed = stdout.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}
