import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: readonly string[],
      opts: unknown,
      cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
    ) => {
      const callback = typeof opts === "function" ? opts : cb!;
      const options = typeof opts === "function" ? undefined : opts;
      const result = execFileMock(cmd, args, options);
      if (result instanceof Error) callback(result, { stdout: "", stderr: "" });
      else callback(null, result ?? { stdout: "", stderr: "" });
    },
  };
});

vi.mock("../src/utils/android-binary", () => ({
  resolveAndroidBinary: vi.fn(async (name: "adb" | "emulator") => name),
  __resetAndroidBinaryCacheForTesting: () => {},
}));

import {
  normalizeActivityComponent,
  resolveLauncherActivity,
} from "../src/tools/launch-app/platforms/android";

// Returns the shell command string of an `adb -s <serial> shell <cmd>` call.
function shellCmd(args: string[]): string {
  return args[0] === "-s" && args[2] === "shell" ? (args[3] ?? "") : "";
}

beforeEach(() => {
  execFileMock.mockReset();
});

describe("normalizeActivityComponent — shared by launch-app + restart-app", () => {
  const PKG = "com.example.app";

  it("makes a bare class name relative so `am start` doesn't reject it", () => {
    // The trap: `${pkg}/MainActivity` is treated as a default-package class and
    // rejected ("no match"). It must become `${pkg}/.MainActivity`.
    expect(normalizeActivityComponent(PKG, "MainActivity")).toBe(`${PKG}/.MainActivity`);
  });

  it("passes a relative (dot-prefixed) activity through under the bundle id", () => {
    expect(normalizeActivityComponent(PKG, ".MainActivity")).toBe(`${PKG}/.MainActivity`);
  });

  it("qualifies a fully-qualified class name with the bundle id", () => {
    expect(normalizeActivityComponent(PKG, "com.other.SplashActivity")).toBe(
      `${PKG}/com.other.SplashActivity`
    );
  });

  it("leaves an already-complete pkg/Activity component untouched", () => {
    expect(normalizeActivityComponent(PKG, "com.example.app/.MainActivity")).toBe(
      `${PKG}/.MainActivity`
    );
    expect(normalizeActivityComponent(PKG, "other.pkg/full.Class")).toBe("other.pkg/full.Class");
  });
});

describe("resolveLauncherActivity — leanback (Android TV)", () => {
  it("resolves the LEANBACK_LAUNCHER activity first on TV targets", async () => {
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      const shell = shellCmd(args);
      if (shell.includes("LEANBACK_LAUNCHER") && shell.includes("com.example.tv")) {
        return { stdout: "com.example.tv/com.example.tv.LeanbackActivity\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const component = await resolveLauncherActivity("emulator-5556", "com.example.tv", true);
    expect(component).toBe("com.example.tv/com.example.tv.LeanbackActivity");
    // The resolve query must have carried the leanback category.
    const calls = execFileMock.mock.calls.map((c) => shellCmd(c[1] as string[]));
    expect(calls.some((s) => s.includes("LEANBACK_LAUNCHER"))).toBe(true);
  });

  it("falls back to the standard LAUNCHER when no leanback activity exists", async () => {
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      const shell = shellCmd(args);
      // No leanback match; a plain resolve (no category) returns the launcher.
      if (
        shell.startsWith("cmd package resolve-activity --brief ") &&
        !shell.includes("-c ") &&
        shell.includes("com.example.tv")
      ) {
        return { stdout: "com.example.tv/com.example.tv.MainActivity\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const component = await resolveLauncherActivity("emulator-5556", "com.example.tv", true);
    expect(component).toBe("com.example.tv/com.example.tv.MainActivity");
  });

  it("does NOT query leanback for a non-TV target", async () => {
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      const shell = shellCmd(args);
      if (shell.startsWith("cmd package resolve-activity --brief ") && !shell.includes("-c ")) {
        return { stdout: "com.example.app/com.example.app.MainActivity\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const component = await resolveLauncherActivity("emulator-5554", "com.example.app", false);
    expect(component).toBe("com.example.app/com.example.app.MainActivity");
    const calls = execFileMock.mock.calls.map((c) => shellCmd(c[1] as string[]));
    expect(calls.some((s) => s.includes("LEANBACK_LAUNCHER"))).toBe(false);
  });

  it("rejects the system ResolverActivity and falls through to the real launcher", async () => {
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      const shell = shellCmd(args);
      // The leanback resolve returns the system chooser (the package has no
      // leanback activity) — it matches the component shape but must NOT be
      // treated as resolved.
      if (shell.includes("LEANBACK_LAUNCHER")) {
        return {
          stdout: "android/com.android.internal.app.ResolverActivity\n",
          stderr: "",
        };
      }
      // The plain LAUNCHER resolve then finds the real activity.
      if (shell.startsWith("cmd package resolve-activity --brief ") && !shell.includes("-c ")) {
        return { stdout: "com.example.tv/com.example.tv.MainActivity\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const component = await resolveLauncherActivity("emulator-5556", "com.example.tv", true);
    expect(component).toBe("com.example.tv/com.example.tv.MainActivity");
  });

  it("throws (not launches the chooser) when only the system ResolverActivity resolves", async () => {
    execFileMock.mockImplementation(() => ({
      stdout: "android/com.android.internal.app.ResolverActivity\n",
      stderr: "",
    }));
    await expect(resolveLauncherActivity("emulator-5556", "com.example.tv", true)).rejects.toThrow(
      /LEANBACK_LAUNCHER or LAUNCHER/
    );
  });

  it("throws a leanback-aware error when nothing resolves on a TV target", async () => {
    execFileMock.mockImplementation(() => ({ stdout: "", stderr: "" }));
    await expect(resolveLauncherActivity("emulator-5556", "com.example.tv", true)).rejects.toThrow(
      /LEANBACK_LAUNCHER or LAUNCHER/
    );
  });
});
