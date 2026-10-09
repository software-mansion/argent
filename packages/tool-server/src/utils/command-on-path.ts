import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { win32 as pathWin32 } from "node:path";

const execFileAsync = promisify(execFile);

/**
 * Resolve a command name to its absolute path via the OS' own PATH-lookup tool,
 * without executing the command itself (a bare `xcrun` can pop the Xcode
 * license dialog on first use). Returns the first match, or `null`.
 *
 * POSIX uses `command -v` under `/bin/sh`; Windows uses `where`, which also
 * resolves the executable extension (`adb` → `adb.exe`). `where` searches the
 * current directory *before* PATH, so CWD matches are dropped: an `adb.exe`
 * planted in the tool-server's working directory must never beat the real one.
 *
 * `accept` filters the matches the resolver offers, for a caller that has to
 * reject a name PATH resolves to the wrong program — Windows' own
 * `System32\bash.exe`, which is the WSL launcher rather than a bash that can
 * see this filesystem. `where` lists every match, so a rejected first hit still
 * finds a later one; `command -v` answers once, so a rejected answer is a miss.
 */
export async function commandOnPath(
  name: string,
  accept?: (candidate: string) => boolean
): Promise<string | null> {
  // Bare binary names only: keeps the POSIX `/bin/sh -c` interpolation safe and
  // stops `where`'s glob matching (`adb*`) resolving something else.
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return null;
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("where", [name], { timeout: 2_000 });
      // Explicit win32 semantics: correct on a real Windows host, and
      // unit-testable on POSIX CI.
      const cwd = pathWin32.resolve(process.cwd()).toLowerCase();
      const match = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        // Windows paths are case-insensitive, so compare normalized + lowercased.
        .find(
          (candidate) =>
            pathWin32.resolve(pathWin32.dirname(candidate)).toLowerCase() !== cwd &&
            (accept?.(candidate) ?? true)
        );
      return match ?? null;
    }
    const { stdout } = await execFileAsync("/bin/sh", ["-c", `command -v ${name}`], {
      timeout: 2_000,
    });
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    return (accept?.(trimmed) ?? true) ? trimmed : null;
  } catch {
    return null;
  }
}
