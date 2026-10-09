import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isGloballyInstalled } from "../src/utils.js";
import { runInstall } from "../src/install-runner.js";
import { runShellCommand } from "../src/shell.js";
import type { InitTelemetry } from "../src/init-telemetry.js";

const childProcessMock = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock("node:child_process", () => childProcessMock);
vi.mock("../src/shell.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/shell.js")>()),
  runShellCommand: vi.fn(),
}));
vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("@argent/telemetry", () => ({ track: vi.fn() }));

function whichFinds(...paths: string[]): void {
  childProcessMock.execFileSync.mockReturnValue(paths.map((p) => `${p}\n`).join(""));
}

// Where each runner puts its own copy of argent: the POSIX layouts as observed
// with `which -a argent`, the Windows ones under each tool's default dirs.
const TEMP_RUNNER_BINS: Array<[string, string]> = [
  ["npx", "/home/u/.npm/_npx/0ba8f3802715c416/node_modules/.bin/argent"],
  [
    "pnpm 9 dlx",
    "/home/u/.cache/pnpm/dlx/bngrqnrvxrzuyhh4gjt7gytap4/1a1222286f6-3bf9dd/node_modules/.bin/argent",
  ],
  [
    "pnpm 10 dlx",
    "/home/u/.cache/pnpm/dlx/cd0ea13ca4b13246a13ff1b5790a3f078ec90f69fa67140d32bafbc07768dd69/1a122236397-3c0e54/node_modules/.bin/argent",
  ],
  [
    "pnpm 12 dlx",
    "/home/u/.cache/pnpm/dlx/df10ba076369000ba7320066b779de49/mv1czvz1-2cfyw/node_modules/.bin/argent",
  ],
  ["pnpm 8 dlx", "/home/u/.local/share/pnpm/store/v3/tmp/dlx-3943361/node_modules/.bin/argent"],
  ["yarn 4 dlx", "/tmp/xfs-fc85fa55/argent"],
  ["bunx", "/tmp/bunx-1000-@swmansion/argent@latest/node_modules/.bin/argent"],
  [
    "npx on Windows",
    "C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\0ba8f3802715c416\\node_modules\\.bin\\argent.cmd",
  ],
  [
    "pnpm dlx on Windows",
    "C:\\Users\\u\\AppData\\Local\\pnpm-cache\\dlx\\df10ba07\\mv1czvz1-2cfyw\\node_modules\\.bin\\argent.cmd",
  ],
  ["yarn dlx on Windows", "C:\\Users\\u\\AppData\\Local\\Temp\\xfs-fc85fa55\\argent.cmd"],
  [
    "bunx on Windows",
    "C:\\Users\\u\\AppData\\Local\\Temp\\bunx-2214567-@swmansion\\argent@latest\\node_modules\\.bin\\argent.exe",
  ],
];

const GLOBAL_BINS: Array<[string, string]> = [
  ["npm", "/usr/local/bin/argent"],
  ["npm prefix in a dir named dlx", "/home/u/dlx/npm-global/bin/argent"],
  ["pnpm", "/home/u/.local/share/pnpm/argent"],
  ["yarn classic", "/home/u/.yarn/bin/argent"],
  ["bun", "/home/u/.bun/bin/argent"],
  ["npm on Windows", "C:\\Users\\u\\AppData\\Roaming\\npm\\argent.cmd"],
  ["pnpm on Windows", "C:\\Users\\u\\AppData\\Local\\pnpm\\argent.cmd"],
];

describe("isGloballyInstalled — temp package runners", () => {
  beforeEach(() => {
    childProcessMock.execFileSync.mockReset();
  });

  it.each(TEMP_RUNNER_BINS)("ignores the copy %s puts on PATH", (_runner, bin) => {
    whichFinds(bin);
    expect(isGloballyInstalled()).toBe(false);
  });

  it.each(GLOBAL_BINS)("counts a %s global install", (_pm, bin) => {
    whichFinds(bin);
    expect(isGloballyInstalled()).toBe(true);
  });

  it.each(TEMP_RUNNER_BINS)("finds a global install behind the copy %s runs", (_runner, bin) => {
    whichFinds(bin, "/usr/local/bin/argent");
    expect(isGloballyInstalled()).toBe(true);
  });
});

describe("init under pnpm dlx", () => {
  const savedAgent = process.env.npm_config_user_agent;

  afterEach(() => {
    if (savedAgent === undefined) delete process.env.npm_config_user_agent;
    else process.env.npm_config_user_agent = savedAgent;
  });

  it("installs argent globally when the only copy on PATH is pnpm dlx's own", async () => {
    process.env.npm_config_user_agent = "pnpm/12.10.1 npm/? node/v26.10.0 linux x64";
    whichFinds(TEMP_RUNNER_BINS.find(([runner]) => runner === "pnpm 12 dlx")![1]);
    vi.mocked(runShellCommand).mockResolvedValue(undefined);
    const tel = {
      trackPackageAction: vi.fn(async () => {}),
      finalize: vi.fn(async () => {}),
    } as unknown as InitTelemetry;

    await runInstall({
      installMode: "global",
      fromTar: null,
      nonInteractive: true,
      version: "0.0.0",
      tel,
    });

    expect(runShellCommand).toHaveBeenCalledWith({
      bin: "pnpm",
      args: ["add", "-g", "@swmansion/argent"],
    });
  });
});
