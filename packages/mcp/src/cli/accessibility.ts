import { execSync } from "node:child_process";
import pc from "picocolors";

// ── macOS Accessibility Permission Helpers ───────────────────────────────────

/**
 * Check whether the current process has macOS Accessibility permissions.
 * Uses the CoreGraphics AXIsProcessTrusted() API via a one-liner Swift call.
 * Returns false on non-macOS platforms.
 */
function isSwiftAvailable(): boolean {
  try {
    execSync("which swift", { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export function isAccessibilityEnabled(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    const result = execSync(
      `swift -e 'import Cocoa; print(AXIsProcessTrusted())'`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }
    );
    return result.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Trigger the macOS Accessibility permission prompt via AXIsProcessTrustedWithOptions.
 * This shows the native system dialog asking the user to grant access.
 */
function requestAccessibilityPermission(): void {
  try {
    execSync(
      `swift -e 'import Cocoa; let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary; AXIsProcessTrustedWithOptions(opts)'`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }
    );
  } catch {
    // Prompt may still appear even if swift exits non-zero
  }
}

/**
 * Open System Settings directly to the Accessibility privacy pane.
 */
function openAccessibilitySettings(): void {
  try {
    execSync(
      `open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"`,
      { stdio: "ignore" }
    );
  } catch {
    // Swallow — user can navigate manually
  }
}

// ── Banner rendering ─────────────────────────────────────────────────────────

const PERM_BANNER_LINES = [
  "╔══════════════════════════════════════════════════════════════════════════════╗",
  "║                                                                            ║",
  "║       █████╗  ██████╗ ██████╗███████╗███████╗███████╗                      ║",
  "║      ██╔══██╗██╔════╝██╔════╝██╔════╝██╔════╝██╔════╝                      ║",
  "║      ███████║██║     ██║     █████╗  ███████╗███████╗                      ║",
  "║      ██╔══██║██║     ██║     ██╔══╝  ╚════██║╚════██║                      ║",
  "║      ██║  ██║╚██████╗╚██████╗███████╗███████║███████║                      ║",
  "║      ╚═╝  ╚═╝ ╚═════╝ ╚═════╝╚══════╝╚══════╝╚══════╝                      ║",
  "║                                                                            ║",
  "║              ⚠  ACCESSIBILITY PERMISSION REQUIRED  ⚠                      ║",
  "║                                                                            ║",
  "║   Argent needs macOS Accessibility permissions to inspect simulator UI.    ║",
  "║   Without this, the `describe` tool cannot read screen elements.           ║",
  "║                                                                            ║",
  "║   The system permission prompt will appear shortly.                        ║",
  "║   Please click \"Allow\" when prompted.                                      ║",
  "║                                                                            ║",
  "╚══════════════════════════════════════════════════════════════════════════════╝",
];

const SUCCESS_BANNER_LINES = [
  "╔══════════════════════════════════════════════════════════════════════════════╗",
  "║                                                                            ║",
  "║              ✓  ACCESSIBILITY PERMISSION GRANTED                           ║",
  "║                                                                            ║",
  "║   Thank you! Argent can now inspect simulator UI elements.                 ║",
  "║                                                                            ║",
  "╚══════════════════════════════════════════════════════════════════════════════╝",
];

const DENIED_BANNER_LINES = [
  "╔══════════════════════════════════════════════════════════════════════════════╗",
  "║                                                                            ║",
  "║              ✗  ACCESSIBILITY PERMISSION DENIED                            ║",
  "║                                                                            ║",
  "║   Argent cannot function without Accessibility permissions.                ║",
  "║   The `describe` tool requires access to the UI element tree.              ║",
  "║                                                                            ║",
  "║   To enable manually:                                                      ║",
  "║                                                                            ║",
  "║     1. Open System Settings                                                ║",
  "║     2. Go to Privacy & Security → Accessibility                            ║",
  "║     3. Find your terminal app (Terminal, iTerm2, etc.)                     ║",
  "║     4. Toggle the switch ON                                                ║",
  "║                                                                            ║",
  "║   Then run `argent init` again.                                            ║",
  "║                                                                            ║",
  "╚══════════════════════════════════════════════════════════════════════════════╝",
];

function printBannerBlock(lines: string[], colorFn: (s: string) => string): void {
  console.log();
  for (const line of lines) {
    console.log(colorFn(line));
  }
  console.log();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll for accessibility permission with retries.
 * Returns true as soon as permission is detected, false after all attempts.
 */
function waitForPermission(attempts: number, intervalMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let count = 0;
    const check = () => {
      if (isAccessibilityEnabled()) {
        resolve(true);
        return;
      }
      count++;
      if (count >= attempts) {
        resolve(false);
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

// ── Main gate ────────────────────────────────────────────────────────────────

/**
 * Ensure macOS Accessibility permissions are granted before continuing init.
 * Shows a prominent banner, counts down, triggers the system prompt, and
 * polls for the result. Exits the process if the user refuses.
 *
 * No-ops on non-macOS platforms or if permissions are already granted.
 *
 * In non-interactive mode (--yes), skips the countdown and interactive polling
 * but still checks and exits if permissions are missing.
 */
export async function ensureAccessibilityPermission(
  nonInteractive = false
): Promise<void> {
  // Only relevant on macOS
  if (process.platform !== "darwin") return;

  // Already granted — nothing to do
  if (isAccessibilityEnabled()) return;

  // Check that swift is available — we need it to query the Accessibility API
  if (!isSwiftAvailable()) {
    console.log(
      pc.yellow(
        "\n  Warning: `swift` is not available on your PATH.\n" +
          "  Argent needs Swift to check Accessibility permissions.\n" +
          "  Install Xcode Command Line Tools: xcode-select --install\n"
      )
    );
    process.exit(1);
  }

  // Show the warning banner
  printBannerBlock(PERM_BANNER_LINES, pc.yellow);

  // In non-interactive mode (CI, --yes), we can't wait for user input.
  // Trigger the prompt and do a quick poll, then fail if still denied.
  if (nonInteractive) {
    requestAccessibilityPermission();
    // Give the system a few seconds to register the permission
    const granted = await waitForPermission(5, 2000);
    if (granted) {
      printBannerBlock(SUCCESS_BANNER_LINES, pc.green);
      return;
    }
    printBannerBlock(DENIED_BANNER_LINES, pc.red);
    process.exit(1);
  }

  // Countdown
  for (let i = 3; i > 0; i--) {
    process.stdout.write(pc.yellow(pc.bold(`  Opening permission prompt in ${i}...`)) + "\r");
    await sleep(1000);
  }
  process.stdout.write("\x1b[2K\r"); // Clear countdown line

  // Trigger the native prompt
  requestAccessibilityPermission();

  console.log(pc.dim("  Waiting for you to grant Accessibility permission..."));
  console.log(
    pc.dim("  Press ") +
      pc.cyan("s") +
      pc.dim(" to open System Settings, or grant via the system dialog.")
  );

  // Poll for permission — give the user up to ~60 seconds
  const granted = await pollWithKeyboardHint(60);

  if (granted) {
    printBannerBlock(SUCCESS_BANNER_LINES, pc.green);
    return;
  }

  // Permission still denied
  printBannerBlock(DENIED_BANNER_LINES, pc.red);

  // Offer to open settings one more time
  console.log(
    pc.yellow("  Opening System Settings → Accessibility so you can enable it manually...")
  );
  openAccessibilitySettings();

  console.log();
  console.log(pc.dim("  Waiting for you to toggle the permission ON in System Settings..."));
  console.log(pc.dim("  (checking every 2 seconds for up to 2 minutes)"));
  console.log();

  // Final extended poll — 2 minutes
  const grantedAfterSettings = await waitForPermission(60, 2000);

  if (grantedAfterSettings) {
    printBannerBlock(SUCCESS_BANNER_LINES, pc.green);
    return;
  }

  // User absolutely refuses — abort installation
  console.log(
    pc.red(pc.bold("  ✗ Accessibility permission is required. Installation aborted."))
  );
  console.log();
  console.log(pc.dim("  Enable Accessibility for your terminal, then run:"));
  console.log(pc.cyan("    argent init"));
  console.log();
  process.exit(1);
}

/**
 * Poll for permission while listening for 's' keypress to open settings.
 * Uses recursive setTimeout (not setInterval) so that synchronous execSync
 * calls in isAccessibilityEnabled() don't stack up and block key events.
 * Handles Ctrl+C and ensures raw mode is always restored on exit.
 */
function pollWithKeyboardHint(timeoutSeconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    let rawModeSet = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (rawModeSet && process.stdin.isTTY) {
        try {
          process.stdin.setRawMode(false);
        } catch {
          // Best effort
        }
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        rawModeSet = false;
      }
      process.removeListener("exit", cleanup);
      process.removeListener("SIGINT", onSigInt);
      process.removeListener("SIGTERM", onSigInt);
    };

    const done = (result: boolean) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(result);
    };

    const onSigInt = () => {
      cleanup();
      process.exit(1);
    };

    // Ensure raw mode is always restored, even on unexpected exit
    process.on("exit", cleanup);
    process.on("SIGINT", onSigInt);
    process.on("SIGTERM", onSigInt);

    // Set up keyboard listener for 's' to open settings, Ctrl+C to abort
    const onData = (data: Buffer) => {
      const key = data.toString();
      if (key === "\x03") {
        // Ctrl+C
        console.log();
        done(false);
        return;
      }
      if (key === "s" || key === "S") {
        openAccessibilitySettings();
        console.log(pc.dim("  Opened System Settings → Accessibility"));
      }
    };

    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(true);
        rawModeSet = true;
        process.stdin.resume();
        process.stdin.on("data", onData);
      } catch {
        // If raw mode fails, continue without keyboard hints
      }
    }

    // Poll using recursive setTimeout so each check completes before scheduling the next
    const startTime = Date.now();
    const pollIntervalMs = 2000;

    const check = () => {
      if (resolved) return;
      if (isAccessibilityEnabled()) {
        done(true);
        return;
      }
      const elapsed = (Date.now() - startTime) / 1000;
      if (elapsed >= timeoutSeconds) {
        done(false);
        return;
      }
      timer = setTimeout(check, pollIntervalMs);
    };

    // Start first check after a short delay to let the system prompt appear
    timer = setTimeout(check, pollIntervalMs);
  });
}
