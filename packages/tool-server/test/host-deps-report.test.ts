import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Each resolver is stubbed so the report reflects only what this file feeds it,
// not the host the suite runs on.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "host-deps-report-"));
const artifact = (name: string, mode: number): string => {
  const p = path.join(fixture, name);
  fs.writeFileSync(p, "", { mode });
  return p;
};
const paths = {
  simulatorServer: artifact("simulator-server", 0o755),
  axService: artifact("ax-service", 0o644),
  dylib: artifact("devtools.dylib", 0o644),
  bootstrap: artifact("bootstrap.dylib", 0o644),
  apk: artifact("helper.apk", 0o644),
};
const developerDir = path.join(fixture, "Xcode.app", "Contents", "Developer");
fs.mkdirSync(path.join(developerDir, "usr", "bin"), { recursive: true });
fs.writeFileSync(path.join(developerDir, "usr", "bin", "simctl"), "");

vi.mock("@argent/native-devtools-ios", () => ({
  simulatorServerBinaryPath: () => paths.simulatorServer,
  axServiceBinaryPath: () => paths.axService,
  nativeDevtoolsDylibPath: () => paths.dylib,
  bootstrapDylibPath: () => paths.bootstrap,
}));
vi.mock("@argent/native-devtools-android", () => ({ bundledHelperApkPath: () => paths.apk }));
vi.mock("node:child_process", () => ({
  execFile: (
    _cmd: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error | null, out: { stdout: string; stderr: string }) => void
  ) => cb(null, { stdout: `${developerDir}\n`, stderr: "" }),
}));
vi.mock("../src/utils/command-on-path", () => ({
  commandOnPath: async (name: string) => (name === "xcrun" ? "/usr/bin/xcrun" : null),
}));
vi.mock("../src/utils/android-binary", () => ({
  resolveAndroidBinary: async (name: string) => (name === "adb" ? "/sdk/adb" : null),
}));
vi.mock("../src/utils/vega-cli", () => ({ resolveVegaBinary: async () => null }));
vi.mock("../src/utils/ios-device/team-detect", () => ({
  detectSigningTeams: async () => [{ teamId: "T1" }],
}));
vi.mock("../src/utils/chromium-discovery", () => ({
  getCandidateChromiumPorts: () => [9222, 9333],
}));

import { collectHostDepsReport } from "../src/utils/host-deps-report";
import { INSTALL_HINTS } from "../src/utils/check-deps";

async function reportOn(platform: NodeJS.Platform) {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return await collectHostDepsReport();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => {
  fs.rmSync(fixture, { recursive: true, force: true });
});

describe("collectHostDepsReport", () => {
  it("reports every dependency doctor reads, with its own install hint", async () => {
    const report = await reportOn("linux");
    expect(report.platform).toBe("linux");
    expect(report.deps.map((d) => [d.dep, d.path])).toEqual([
      ["xcrun", "/usr/bin/xcrun"],
      ["adb", "/sdk/adb"],
      ["emulator", null],
      ["vega", null],
    ]);
    for (const d of report.deps) expect(d.hint).toBe(INSTALL_HINTS[d.dep]);
    expect(report.chromiumPorts).toEqual([9222, 9333]);
  });

  it("reads signing and Xcode only on macOS", async () => {
    const linux = await reportOn("linux");
    expect(linux.signing).toBeNull();
    expect(linux.xcode).toBeNull();

    const mac = await reportOn("darwin");
    expect(mac.signing).toEqual({ teamIdEnv: null, detectedTeams: 1 });
    expect(mac.xcode).toEqual({ developerDir, simctl: true, fromEnv: false });

    vi.stubEnv("ARGENT_IOS_TEAM_ID", "ABCDE12345");
    vi.stubEnv("DEVELOPER_DIR", developerDir);
    const pinned = await reportOn("darwin");
    expect(pinned.signing).toEqual({ teamIdEnv: "ABCDE12345", detectedTeams: 0 });
    expect(pinned.xcode?.fromEnv).toBe(true);
  });

  it("reports a bundled binary that is not executable", async () => {
    const report = await reportOn("darwin");
    expect(report.bundled.find((b) => b.name === "simulator-server")).toEqual({
      name: "simulator-server",
      path: paths.simulatorServer,
    });
    expect(report.bundled.find((b) => b.name === "ax-service")?.error).toMatch(/not executable/);
    expect(report.bundled.find((b) => b.name === "android helper apk")?.error).toBeUndefined();
  });
});
