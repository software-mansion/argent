import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveInstallableUpdateTarget } from "@argent/installer";
import { globalBehindCheck, otherSection } from "../src/doctor-other.js";
import { type DoctorContext } from "../src/doctor-shared.js";

vi.mock("@argent/installer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@argent/installer")>()),
  resolveInstallableUpdateTarget: vi.fn(),
}));

const ctx: DoctorContext = {
  projectRoot: "/proj",
  cwd: "/proj",
  mode: "global",
  global: {
    bin: "/g/bin/argent",
    root: "/g/lib/node_modules/@swmansion/argent",
    version: "0.26.0",
  },
  argentCmd: "argent",
  installCmd: "npm install",
  offPathGlobalBin: null,
};

function registry(latestVersion: string, targetVersion: string | null) {
  vi.mocked(resolveInstallableUpdateTarget).mockResolvedValue({
    latestVersion,
    latestPublishedAt: null,
    targetVersion,
    minReleaseAgeMs: 0,
  });
}

describe("otherSection update check", () => {
  it("warns about a global install behind latest when the running copy is on latest", async () => {
    registry("0.30.1", null);
    const { checks } = await otherSection(ctx, "0.30.1", false, "argent update", "npm");
    expect(checks.map((c) => c.label)).toEqual(
      expect.arrayContaining([
        "Up to date (latest v0.30.1)",
        expect.stringMatching(/^Global install v0\.26\.0, .* is behind v0\.30\.1$/),
      ])
    );
  });

  it("does not compare the global against a release the age policy holds back", async () => {
    registry("0.30.1", null);
    const { checks } = await otherSection(ctx, "0.30.0", false, "argent update", "npm");
    expect(checks.some((c) => c.label.startsWith("Global install"))).toBe(false);
  });

  it("offers the version argent update would install, asked through the right manager", async () => {
    registry("0.31.0", "0.31.0");
    const noGlobal = { ...ctx, global: null };
    const { checks } = await otherSection(noGlobal, "0.30.0", false, "argent update", "pnpm");
    expect(checks.slice(1)).toEqual([
      expect.objectContaining({
        status: "warn",
        label: "Update available: v0.30.0 → v0.31.0",
        fix: "argent update",
      }),
    ]);
    expect(resolveInstallableUpdateTarget).toHaveBeenLastCalledWith(
      "pnpm",
      "0.30.0",
      expect.anything()
    );
  });

  it("reports a release the minimum-release-age policy holds back", async () => {
    registry("0.31.0", null);
    const noGlobal = { ...ctx, global: null };
    const { checks } = await otherSection(noGlobal, "0.30.0", false, "argent update", "npm");
    expect(checks[1]).toMatchObject({
      status: "info",
      label: expect.stringMatching(/held by your minimum-release-age policy/),
    });
  });
});

describe("globalBehindCheck", () => {
  it("names the global install's own package manager in the fix", () => {
    const pnpmGlobal = {
      bin: "/Users/me/Library/pnpm/argent",
      root: "/Users/me/Library/pnpm/global/5/node_modules/@swmansion/argent",
      version: "1.0.0",
    };
    expect(globalBehindCheck(pnpmGlobal, "2.0.0", "2.0.0")).toMatchObject({
      status: "warn",
      fix: expect.stringMatching(/^pnpm add -g @swmansion\/argent@latest/),
    });
  });

  it("stays quiet when the global install is already the latest", () => {
    const global = { bin: "/usr/local/bin/argent", root: null, version: "2.0.0" };
    expect(globalBehindCheck(global, "1.0.0", "2.0.0")).toBeNull();
  });
});

describe("otherSection guards", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-doctor-other-"));
    fs.mkdirSync(path.join(projectRoot, ".git"));
    fs.mkdirSync(path.join(projectRoot, "home"));
    vi.stubEnv("HOME", path.join(projectRoot, "home"));
    registry("0.30.1", "0.30.1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  const local = (overrides: Partial<DoctorContext> = {}): DoctorContext => ({
    ...ctx,
    projectRoot,
    cwd: projectRoot,
    ...overrides,
  });

  it("skips the behind-latest warning in local mode, whose entries start the project's copy", async () => {
    const { checks } = await otherSection(local({ mode: "local" }), "0.30.1", false, "u", "npm");
    expect(checks.some((c) => c.label.startsWith("Global install"))).toBe(false);
  });

  it("keeps the behind-latest warning in local mode when an entry starts the global", async () => {
    const localMode = local({ mode: "local" });
    const { checks } = await otherSection(localMode, "0.30.1", false, "u", "npm", true);
    expect(checks.some((c) => c.label.startsWith("Global install v0.26.0"))).toBe(true);
  });

  it("caps the update check and keeps the package manager from installing or logging", async () => {
    await otherSection(local(), "0.30.1", false, "argent update", "npm");
    expect(vi.mocked(resolveInstallableUpdateTarget).mock.lastCall?.[2]).toMatchObject({
      deadlineMs: 15_000,
      env: expect.objectContaining({
        COREPACK_ENABLE_NETWORK: "0",
        npm_config_update_notifier: "false",
        npm_config_logs_max: "0",
      }),
    });
  });

  it("points at --offline when the registry gives no answer in time", async () => {
    vi.mocked(resolveInstallableUpdateTarget).mockResolvedValue(null);
    const { checks } = await otherSection(local(), "0.30.1", false, "argent update", "npm");
    expect(checks.find((c) => c.label.startsWith("Update check skipped"))?.detail).toMatch(
      /^the request failed .* or took over 15s; --offline/
    );
  });

  it("names a project config file that does not parse", async () => {
    fs.mkdirSync(path.join(projectRoot, ".argent"));
    fs.writeFileSync(
      path.join(projectRoot, ".argent", "config.json"),
      '<<<<<<< HEAD\n{ "telemetry": { "enabled": false } }\n=======\n{}\n>>>>>>> main\n'
    );
    const { checks } = await otherSection(local(), "0.30.1", true, "argent update", "npm");
    expect(checks.find((c) => c.label.includes("config.json"))).toMatchObject({
      status: "warn",
      label: `${path.join(projectRoot, ".argent", "config.json")} doesn't parse, so every setting in it is ignored`,
    });
  });
});
