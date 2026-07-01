import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
 *   non-zero when nothing matches; we take the first line. `where` also handles
 *   the executable-extension search (`adb` → `adb.exe`) that `command -v` does
 *   not, which is exactly what callers want here.
 *
 * Centralised so the three resolvers that need it (android-binary, check-deps,
 * vega-cli) share one cross-platform implementation instead of each hardcoding
 * the POSIX `/bin/sh` form (which silently never matches on Windows).
 */
export async function commandOnPath(name: string): Promise<string | null> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("where", [name], { timeout: 2_000 });
      const first = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      return first ?? null;
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
