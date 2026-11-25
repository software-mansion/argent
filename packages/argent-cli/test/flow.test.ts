import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";
import { e2e as flow, exitAfterFlush, parseRunArgs } from "../src/e2e.js";
import { e2e, flow as flowAlias } from "../src/index.js";
import { ToolInvocationError } from "@argent/tools-client";
import { FlagParseException } from "../src/flag-parser.js";
import type { ResolvedToolsUrl } from "@argent/tools-client";

const toolsClientMock = vi.hoisted(() => ({
  callTool: vi.fn(),
  baseUrl: vi.fn(async () => ({ url: "http://127.0.0.1:4141", token: "tok" })),
}));
// Identity materialization; a spy so tests can assert it is only invoked for
// the failed-snapshot artifacts that --output actually copies.
const materializeArtifactsMock = vi.hoisted(() =>
  vi.fn(async (data: unknown) => ({ result: data, images: [] }))
);
const getResolvedToolsUrlMock = vi.hoisted(() =>
  vi.fn(async (): Promise<ResolvedToolsUrl> => ({
    url: null,
    source: "none",
  }))
);

vi.mock("@argent/tools-client", async (importOriginal) => ({
  // Keep the real isArtifactHandle — the display-path fallback under test
  // must recognize genuine wire handles.
  ...(await importOriginal<typeof import("@argent/tools-client")>()),
  createToolsClient: vi.fn(() => toolsClientMock),
  getResolvedToolsUrl: getResolvedToolsUrlMock,
  materializeArtifacts: materializeArtifactsMock,
}));

// The help lists `macos` from this flag, the host and the link, and reads the
// link only with the flag on, off macOS. Off here, so no test depends on the
// host or on the developer's flags files: test/e2e-help-platform.test.ts covers
// that line. Every other flag reads as it does in production.
vi.mock("@argent/configuration-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argent/configuration-core")>();
  const isFeatureEnabled: typeof actual.isFeatureEnabled = (name, ...rest) =>
    name === "macos-apps" ? false : actual.isFeatureEnabled(name, ...rest);
  return { ...actual, isFeatureEnabled };
});

interface StepFixture {
  index: number;
  kind: string;
  status: "pass" | "fail" | "skip" | "error";
  reason?: string;
  warning?: string;
  tool?: string;
  flow?: string;
  message?: string;
  snapshotKey?: string;
  target?: string;
  scriptLog?: string;
  scriptLogTruncated?: boolean;
  artifacts?: Record<string, unknown>;
  /** Tool-step payload; a nested run's report for e2e-execute. */
  result?: unknown;
}

/** A wire artifact handle as the tool-server emits it (image/png). */
function handle(hostPath?: string): Record<string, unknown> {
  return {
    __argentArtifact: true,
    id: "art-1",
    filename: "art.png",
    mimeType: "image/png",
    size: 4,
    ...(hostPath ? { hostPath } : {}),
  };
}

/**
 * Whether a mode-000 file is actually unreadable to this process. `access(R_OK)`
 * succeeds for root regardless of mode (some CI containers run as root), and
 * Windows has no POSIX mode bits at all — in both cases the fixture would be
 * readable and the assertion would pass for the wrong reason. Skip the
 * unreadable-file cases there rather than let them go green vacuously.
 */
const canDenyRead = process.platform !== "win32" && process.getuid?.() !== 0;

/**
 * Whether this filesystem folds case (APFS and NTFS do, ext4 does not). Probed
 * rather than assumed from the platform, since macOS volumes can be formatted
 * either way. Only where it folds does a mis-cased spelling open a real file
 * and reach the on-disk-spelling guard, so the cases that need it are skipped
 * elsewhere instead of passing for the wrong reason.
 */
const caseInsensitiveFs = ((): boolean => {
  const probe = fs.mkdtempSync(path.join(tmpdir(), "argent-cli-case-"));
  try {
    fs.writeFileSync(path.join(probe, "probe.yaml"), "");
    return fs.existsSync(path.join(probe, "PROBE.yaml"));
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
})();

/** What fetch rejects with when nothing listens at the tool-server's address. */
function connectRefused(): TypeError {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:47899"), {
      code: "ECONNREFUSED",
      syscall: "connect",
    }),
  });
}

const UNREACHABLE_ENV_MESSAGE =
  "Could not reach the tool-server at http://127.0.0.1:47899 (set by ARGENT_TOOLS_URL): " +
  "connection refused.\nStart that tool-server, or unset ARGENT_TOOLS_URL to use the local one.";

const UPLOAD_REFUSED_MESSAGE =
  "Upload to http://127.0.0.1:47899/upload failed: 413 Request Entity Too Large. A proxy " +
  "between the client and the tool-server limits the size of a request body. The proxy must " +
  "accept a body of at least 1 MB on POST /upload, for example client_max_body_size 1m in nginx";

/** What the tools client throws when a proxy refuses a fragment's upload, before it sends the flow. */
function uploadRefused(): ToolInvocationError {
  return new ToolInvocationError(UPLOAD_REFUSED_MESSAGE, {
    errorCode: "FILE_INPUT_UPLOAD_FAILED",
    errorKind: "validation",
  });
}

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const steps: StepFixture[] = [{ index: 0, kind: "tap", status: "pass" }];
  return {
    flow: "checkout",
    device: "SIM-1",
    executionPrerequisite: "",
    ok: true,
    passed: 1,
    failed: 0,
    skipped: 0,
    errored: 0,
    steps,
    ...overrides,
  };
}

const SKIPPED_DIRS = ["__baselines__", ".cache", "node_modules"];

/** Writes top.yaml and suite/nested.yaml, plus a sneaky.yaml in each skipped folder at both levels. */
async function writeSkippedDirsTree(root: string): Promise<void> {
  for (const dir of SKIPPED_DIRS) {
    for (const parent of [root, path.join(root, "suite")]) {
      await fsp.mkdir(path.join(parent, dir), { recursive: true });
      await fsp.writeFile(path.join(parent, dir, "sneaky.yaml"), "steps: []\n");
    }
  }
  await fsp.writeFile(path.join(root, "top.yaml"), "steps: []\n");
  await fsp.writeFile(path.join(root, "suite", "nested.yaml"), "steps: []\n");
}

const NOT_E2E_TESTS: Record<string, string> = {
  "docker-compose.yaml": "services:\n  web:\n    image: nginx\n",
  "list.yaml": "- a\n- b\n",
  "list-steps.yaml": "- steps: []\n",
  "comment-steps.yaml": "# steps go here\n",
  "scalar.yaml": "just text\n",
  "compose-version.yaml": 'version: "3.8"\nservices: {}\n',
  "float-version.yaml": "version: 3.8\nservices: {}\n",
  "broken-not-a-test.yaml": "services: {\n",
  "v1.yaml": "version: 1\nfoo: 1\n",
};

const KEPT_YAMLS: Record<string, string> = {
  "broken.yaml": "steps: {\n",
  "empty.yaml": "",
  "blank.yaml": "  \n\n",
  "zero-steps.yaml": "steps: []\n",
  "real.yaml": "steps:\n  - echo: hi\n",
  "steps-map.yaml": "steps:\n  tap: Login\n",
  "null-steps.yaml": "version: 1\nsteps:\n",
  "newer.yaml": "version: 2\nphases: []\n",
  "integer-version.yaml": "version: 3\nservices: {}\n",
  "header-version.yaml": "# header\nversion: 2\nphases: []\n",
};

async function writeShapeFixture(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries({ ...NOT_E2E_TESTS, ...KEPT_YAMLS })) {
    await fsp.writeFile(path.join(dir, name), content);
  }
}

describe("parseRunArgs", () => {
  it("returns documented defaults with just a flow path", () => {
    expect(parseRunArgs(["../flows/checkout.yaml"])).toEqual({
      flowRef: "../flows/checkout.yaml",
      updateBaselines: false,
      recursive: false,
      json: false,
      jsonStream: false,
    });
  });

  it("parses every run flag alongside the path", () => {
    expect(
      parseRunArgs([
        "checkout.yaml",
        "--device",
        "SIM-1",
        "--platform",
        "ios",
        "--update-baselines",
      ])
    ).toEqual({
      flowRef: "checkout.yaml",
      device: "SIM-1",
      platform: "ios",
      updateBaselines: true,
      recursive: false,
      json: false,
      jsonStream: false,
    });
    expect(parseRunArgs(["--json", "checkout.yaml"]).json).toBe(true);
    expect(parseRunArgs(["--json-stream", "checkout.yaml"]).jsonStream).toBe(true);
  });

  it("accepts -r and --recursive in any position", () => {
    expect(parseRunArgs(["flows", "-r"]).recursive).toBe(true);
    expect(parseRunArgs(["--recursive", "flows"]).recursive).toBe(true);
    expect(parseRunArgs(["flows"]).recursive).toBe(false);
  });

  it("throws when --recursive is given an inline value", () => {
    expect(() => parseRunArgs(["flows", "--recursive=1"])).toThrow(FlagParseException);
    expect(() => parseRunArgs(["flows", "--recursive=1"])).toThrow(
      "--recursive does not take a value"
    );
  });

  it("throws when --device is the final token", () => {
    expect(() => parseRunArgs(["checkout.yaml", "--device"])).toThrow(FlagParseException);
    expect(() => parseRunArgs(["checkout.yaml", "--device"])).toThrow("--device requires a value");
  });

  it("throws when --platform is the final token", () => {
    expect(() => parseRunArgs(["checkout.yaml", "--platform"])).toThrow(
      "--platform requires a value"
    );
  });

  it("throws on a --platform value that is not a selectable platform", () => {
    for (const bad of ["iOS", "macOS", "web", "android-tv"]) {
      expect(() => parseRunArgs(["checkout.yaml", "--platform", bad])).toThrow(FlagParseException);
      expect(() => parseRunArgs(["checkout.yaml", "--platform", bad])).toThrow(
        `--platform must be "ios", "android", "chromium", "vega", "macos" or "ios-remote", got "${bad}"`
      );
      expect(() => parseRunArgs(["checkout.yaml", `--platform=${bad}`])).toThrow(
        FlagParseException
      );
    }
    // macos passes with the macos-apps flag off, where the help does not list
    // it: the tool-server answers with why no Mac app is listed.
    for (const good of ["ios", "android", "chromium", "vega", "macos", "ios-remote"]) {
      expect(parseRunArgs(["checkout.yaml", "--platform", good]).platform).toBe(good);
    }
  });

  it("treats a following flag as a missing value, not as the value", () => {
    expect(() => parseRunArgs(["checkout.yaml", "--device", "--json"])).toThrow(
      "--device requires a value"
    );
    expect(() => parseRunArgs(["checkout.yaml", "--platform", "--update-baselines"])).toThrow(
      "--platform requires a value"
    );
  });

  it("throws on a separately supplied empty value, like the --flag= form", () => {
    for (const flag of ["--device", "--output"]) {
      expect(() => parseRunArgs(["checkout.yaml", flag, ""])).toThrow(FlagParseException);
      expect(() => parseRunArgs(["checkout.yaml", flag, ""])).toThrow(`${flag} requires a value`);
    }
    expect(() => parseRunArgs(["checkout.yaml", "--platform", ""])).toThrow(
      '--platform must be "ios", "android", "chromium", "vega", "macos" or "ios-remote", got ""'
    );
  });

  it("collects repeated --env values, splitting each on its first =", () => {
    expect(
      parseRunArgs([
        "checkout.yaml",
        "--env",
        "A=1",
        "--env=URL=https://x.test/?q=a=b",
        "--env",
        "A=2",
        "--env",
        "EMPTY=",
      ]).env
    ).toEqual({ A: "2", URL: "https://x.test/?q=a=b", EMPTY: "" });
  });

  it.each(["NOEQUALS", "=value", "1A=x", "A-B=x", "__proto__=x"])("refuses --env %s", (entry) => {
    expect(() => parseRunArgs(["checkout.yaml", "--env", entry])).toThrow(/--env takes NAME=value/);
  });

  it("accepts the --flag=value form for every value-taking flag", () => {
    expect(
      parseRunArgs(["checkout.yaml", "--device=SIM-1", "--platform=ios", "--output=dir"])
    ).toEqual({
      flowRef: "checkout.yaml",
      device: "SIM-1",
      platform: "ios",
      output: "dir",
      updateBaselines: false,
      recursive: false,
      json: false,
      jsonStream: false,
    });
  });

  it("mixes = and space-separated forms freely", () => {
    expect(parseRunArgs(["checkout.yaml", "--device=SIM-1", "--platform", "ios"])).toEqual({
      flowRef: "checkout.yaml",
      device: "SIM-1",
      platform: "ios",
      updateBaselines: false,
      recursive: false,
      json: false,
      jsonStream: false,
    });
  });

  it("does not consume the next token when the value was inline", () => {
    // Guards the index bookkeeping: --device=SIM-1 must not swallow --json.
    const out = parseRunArgs(["checkout.yaml", "--device=SIM-1", "--json"]);
    expect(out.device).toBe("SIM-1");
    expect(out.json).toBe(true);
  });

  it("rejects combining --json and --json-stream", () => {
    expect(() => parseRunArgs(["checkout.yaml", "--json", "--json-stream"])).toThrow(
      "--json and --json-stream cannot be combined"
    );
  });

  it("throws when a boolean flag is given an inline value", () => {
    expect(() => parseRunArgs(["checkout.yaml", "--json=true"])).toThrow(FlagParseException);
    expect(() => parseRunArgs(["checkout.yaml", "--json=true"])).toThrow(
      "--json does not take a value"
    );
    expect(() => parseRunArgs(["checkout.yaml", "--json-stream=true"])).toThrow(
      "--json-stream does not take a value"
    );
    expect(() => parseRunArgs(["checkout.yaml", "--update-baselines=1"])).toThrow(
      "--update-baselines does not take a value"
    );
  });

  it("throws when an inline value is empty", () => {
    expect(() => parseRunArgs(["checkout.yaml", "--device="])).toThrow("--device requires a value");
  });

  it("rejects unknown flags instead of silently dropping them", () => {
    expect(() => parseRunArgs(["checkout.yaml", "--verbose"])).toThrow(FlagParseException);
    expect(() => parseRunArgs(["checkout.yaml", "--verbose"])).toThrow(/Unknown flag/);
    // A typo'd value flag must not fall back to device auto-detection.
    expect(() => parseRunArgs(["checkout.yaml", "--platfrom=ios"])).toThrow(/Unknown flag/);
  });

  it("rejects extra positional arguments", () => {
    expect(() => parseRunArgs(["checkout.yaml", "extra.yaml"])).toThrow(
      "e2e run accepts one e2e test name, YAML file path, or directory path"
    );
  });

  it("takes everything after -- as the flow, so a name may start with a hyphen", () => {
    // The flow-name charset admits a leading "-", so without the marker such a
    // saved flow would be addressable by path only.
    expect(() => parseRunArgs(["-nightly"])).toThrow(/Unknown flag/);
    expect(parseRunArgs(["--device", "SIM-1", "--", "-nightly"])).toEqual({
      flowRef: "-nightly",
      device: "SIM-1",
      updateBaselines: false,
      recursive: false,
      json: false,
      jsonStream: false,
    });
    // The marker relaxes flag parsing, not the one-positional rule.
    expect(() => parseRunArgs(["--", "a", "b"])).toThrow(
      "e2e run accepts one e2e test name, YAML file path, or directory path"
    );
  });

  it("counts an empty positional as the flow, not as a token to skip past", () => {
    // A truthiness test here would take "extra.yaml" as the flow and run a file
    // the operator never named at that position.
    expect(() => parseRunArgs(["", "extra.yaml"])).toThrow(
      "e2e run accepts one e2e test name, YAML file path, or directory path"
    );
  });
});

describe("argent e2e run", () => {
  let tempRoot: string;
  let checkoutPath: string;
  let bundleDirPath: string;
  let unreadablePath: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logs: string[];
  let errs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  const opts = { paths: {} as never };

  beforeAll(async () => {
    tempRoot = await fsp.mkdtemp(path.join(tmpdir(), "argent-cli-flow-"));
    checkoutPath = path.join(tempRoot, "checkout.yaml");
    await fsp.writeFile(checkoutPath, "steps: []\n", "utf8");
    // The two paths `run`'s filesystem acceptance check rejects after the name
    // checks pass — both need real inodes, so they are built here rather than
    // faked: a directory that looks like a flow, and an unreadable file.
    bundleDirPath = path.join(tempRoot, "bundle.yaml");
    await fsp.mkdir(bundleDirPath, { recursive: true });
    // A flow saved where a bare name resolves. Deliberately not named
    // "checkout": the name-vs-path tests below need a stem that exists under
    // .argent/flows and nowhere else, so a `run saved.yaml` that fell back to
    // the flows directory would be caught rather than passing by coincidence.
    await fsp.mkdir(path.join(tempRoot, ".argent", "flows"), { recursive: true });
    await fsp.writeFile(
      path.join(tempRoot, ".argent", "flows", "saved.yaml"),
      "steps: []\n",
      "utf8"
    );
    unreadablePath = path.join(tempRoot, "noperm.yaml");
    await fsp.writeFile(unreadablePath, "steps: []\n", "utf8");
    await fsp.chmod(unreadablePath, 0o000);
  });

  afterAll(async () => {
    // Restore the mode before removing the tree: `rm` itself only needs the
    // parent's write bit, but a stray 0o000 file is a trap for anything that
    // later walks tmpdir, so never leave one behind if the rm is interrupted.
    await fsp.chmod(unreadablePath, 0o600).catch(() => {});
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getResolvedToolsUrlMock.mockResolvedValue({ url: null, source: "none" });
    toolsClientMock.callTool.mockResolvedValue({ data: report() });
    logs = [];
    errs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
    errSpy = vi.spyOn(console, "error").mockImplementation((...a) => void errs.push(a.join(" ")));
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("sends a named YAML file to the tool-server even when it is not an e2e test", async () => {
    const composePath = path.join(tempRoot, "named-non-test", "docker-compose.yaml");
    await fsp.mkdir(path.dirname(composePath), { recursive: true });
    await fsp.writeFile(composePath, "services: {}\n");

    await expect(flow(["run", composePath], opts)).rejects.toThrow("process.exit:0");

    expect(toolsClientMock.callTool).toHaveBeenCalledTimes(1);
    expect(
      (toolsClientMock.callTool.mock.calls[0]![1] as { e2e_test_path: string }).e2e_test_path
    ).toBe(composePath);
  });

  it("resolves the YAML path and forwards flags to e2e-execute", async () => {
    // Downward-relative from the flow's own directory: a relative spelling
    // that climbs out of cwd would contain ".." segments, which the CLI now
    // rejects. process.cwd() after chdir is fully symlink-resolved (macOS
    // tmpdir sits behind /var -> /private/var), so expectations use realpath.
    const runRoot = await fsp.realpath(tempRoot);
    const previousCwd = process.cwd();
    try {
      process.chdir(tempRoot);
      await expect(
        flow(
          ["run", "checkout.yaml", "--device", "SIM-1", "--platform", "ios", "--update-baselines"],
          opts
        )
      ).rejects.toThrow("process.exit:0");
    } finally {
      process.chdir(previousCwd);
    }

    expect(toolsClientMock.callTool).toHaveBeenCalledWith(
      "e2e-execute",
      {
        e2e_test_path: path.join(runRoot, "checkout.yaml"),
        project_root: runRoot,
        prerequisiteAcknowledged: true,
        device: "SIM-1",
        platform: "ios",
        updateBaselines: true,
      },
      { onProgress: expect.any(Function) }
    );
    expect(logs.join("\n")).toContain("PASS — 1 passed, 0 failed, 0 errored, 0 skipped");
  });

  it("prints a script step's log live, under the step line the event produced", async () => {
    const steps: StepFixture[] = [
      { index: 0, kind: "echo", status: "pass", message: "seeding" },
      {
        index: 1,
        kind: "script",
        status: "pass",
        target: "scripts/seed.mjs",
        scriptLog: "creating order\norder 4711 created\n",
        scriptLogTruncated: true,
      },
    ];
    toolsClientMock.callTool.mockImplementation(
      async (_tool: string, _payload: unknown, opts?: { onProgress?: (e: unknown) => void }) => {
        for (const step of steps) opts?.onProgress?.(step);
        return { data: report({ steps, passed: 1 }) };
      }
    );

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:0");

    const out = logs.join("\n");
    expect(out).toContain("✓  1 script scripts/seed.mjs");
    expect(out).toContain("       │ creating order");
    expect(out).toContain("       │ order 4711 created");
    expect(out).toContain("       │ … output truncated");
    expect(out.match(/script scripts\/seed\.mjs/g)).toHaveLength(1);
    expect(out).toContain("PASS (started on SIM-1) — 1 passed");
  });

  it("repeats a single run's failing step above its verdict", async () => {
    const steps: StepFixture[] = [
      { index: 0, kind: "tap", status: "pass", target: '"Cart"' },
      { index: 1, kind: "tap", status: "fail", target: '"Checkout"', reason: "no match" },
      { index: 2, kind: "await", status: "skip", target: 'visible "Paid"' },
    ];
    toolsClientMock.callTool.mockImplementation(
      async (_tool: string, _payload: unknown, opts?: { onProgress?: (e: unknown) => void }) => {
        for (const step of steps) opts?.onProgress?.(step);
        return { data: report({ steps, ok: false, passed: 1, failed: 1, skipped: 1 }) };
      }
    );

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:1");

    expect(logs.slice(-5)).toEqual([
      '  ·  3 await visible "Paid"',
      "",
      '  ✗ step 2 tap "Checkout"',
      "    no match",
      "\nFAIL (started on SIM-1) — 1 passed, 1 failed, 0 errored, 1 skipped",
    ]);
    expect(logs.join("\n")).not.toContain("re-run:");
  });

  it("exits 2 without calling the tool when --device is missing its value", async () => {
    await expect(flow(["run", "checkout", "--device"], opts)).rejects.toThrow("process.exit:2");

    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    expect(errs.join("\n")).toContain("--device requires a value");
  });

  it("exits 2 without calling the tool when --platform is followed by another flag", async () => {
    await expect(flow(["run", "checkout", "--platform", "--json"], opts)).rejects.toThrow(
      "process.exit:2"
    );

    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    expect(errs.join("\n")).toContain("--platform requires a value");
  });

  it("forwards --flag=value forms to e2e-execute like the space-separated ones", async () => {
    await expect(
      flow(["run", checkoutPath, "--platform=ios", "--device=SIM-1"], opts)
    ).rejects.toThrow("process.exit:0");

    expect(toolsClientMock.callTool).toHaveBeenCalledWith(
      "e2e-execute",
      {
        e2e_test_path: checkoutPath,
        project_root: process.cwd(),
        prerequisiteAcknowledged: true,
        device: "SIM-1",
        platform: "ios",
      },
      { onProgress: expect.any(Function) }
    );
  });

  it("exits 2 without calling the tool when a boolean flag is given a value", async () => {
    await expect(flow(["run", "checkout", "--json=x"], opts)).rejects.toThrow("process.exit:2");

    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    expect(errs.join("\n")).toContain("--json does not take a value");
  });

  it("exits 2 without calling the tool on a typo'd flag instead of auto-detecting a device", async () => {
    await expect(flow(["run", "checkout", "--platfrom=ios"], opts)).rejects.toThrow(
      "process.exit:2"
    );

    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    expect(errs.join("\n")).toContain("Unknown flag");
  });

  it("exits 2 when no flow name or path is given", async () => {
    await expect(flow(["run"], opts)).rejects.toThrow("process.exit:2");
    expect(errs.join("\n")).toContain(
      "requires an e2e test name, a YAML file path, or a directory path"
    );
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  // A --json reader parses stderr as records, so a usage error there is one
  // record and no help, whichever token the parser stopped at.
  it.each([
    [["run", "checkout", "--json", "--device"], "--device requires a value"],
    [["run", "checkout", "--json", "--bogus"], "Unknown flag: --bogus"],
    [
      ["run", "--json"],
      "argent e2e run <test|test.yaml|dir> requires an e2e test name, a YAML file path, or a directory path.",
    ],
  ])("writes only an error record for the usage error in %j", async (argv, message) => {
    await expect(flow(argv, opts)).rejects.toThrow("process.exit:2");

    expect(logs).toEqual([]);
    expect(errs.join("\n").split("\n")).toHaveLength(1);
    expect(JSON.parse(errs[0]!)).toEqual({ event: "error", error: message });
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("runs a saved flow named on the command line from .argent/flows", async () => {
    const runRoot = await fsp.realpath(tempRoot);
    const previousCwd = process.cwd();
    try {
      process.chdir(tempRoot);
      await expect(flow(["run", "saved", "--device", "SIM-1"], opts)).rejects.toThrow(
        "process.exit:0"
      );
    } finally {
      process.chdir(previousCwd);
    }

    expect(toolsClientMock.callTool).toHaveBeenCalledWith(
      "e2e-execute",
      {
        // A name is sent as the path it resolves to, never as a `name` source:
        // one identity keys the report, __baselines__/, and --output whichever
        // form the operator typed.
        e2e_test_path: path.join(runRoot, ".argent", "flows", "saved.yaml"),
        project_root: runRoot,
        prerequisiteAcknowledged: true,
        device: "SIM-1",
      },
      { onProgress: expect.any(Function) }
    );
  });

  it("resolves a name and its spelled-out path to the same e2e_test_path", async () => {
    const previousCwd = process.cwd();
    const sent = async (ref: string): Promise<unknown> => {
      toolsClientMock.callTool.mockClear();
      await expect(flow(["run", ref], opts)).rejects.toThrow("process.exit:0");
      return (toolsClientMock.callTool.mock.calls[0]![1] as { e2e_test_path: string })
        .e2e_test_path;
    };
    try {
      process.chdir(tempRoot);
      expect(await sent("saved")).toBe(await sent(path.join(".argent", "flows", "saved.yaml")));
    } finally {
      process.chdir(previousCwd);
    }
  });

  describe("names across .argent/e2e and .argent/flows", () => {
    let project: string;

    beforeAll(async () => {
      project = path.join(tempRoot, "both-dirs-project");
      await fsp.mkdir(path.join(project, ".argent", "e2e"), { recursive: true });
      await fsp.mkdir(path.join(project, ".argent", "flows"), { recursive: true });
      for (const [dir, name] of [
        ["e2e", "fresh"],
        ["e2e", "both"],
        ["flows", "both"],
        ["flows", "old"],
      ]) {
        await fsp.writeFile(path.join(project, ".argent", dir!, `${name}.yaml`), "steps: []\n");
      }
    });

    async function runIn(argv: string[]): Promise<string> {
      const previousCwd = process.cwd();
      try {
        process.chdir(project);
        await expect(flow(argv, opts)).rejects.toThrow("process.exit:0");
      } finally {
        process.chdir(previousCwd);
      }
      return (toolsClientMock.callTool.mock.calls[0]![1] as { e2e_test_path: string })
        .e2e_test_path;
    }

    it("runs a name saved under .argent/e2e", async () => {
      const root = await fsp.realpath(project);
      expect(await runIn(["run", "fresh"])).toBe(path.join(root, ".argent", "e2e", "fresh.yaml"));
      expect(errs).toEqual([]);
    });

    it("runs a name saved only under the legacy .argent/flows", async () => {
      const root = await fsp.realpath(project);
      expect(await runIn(["run", "old"])).toBe(path.join(root, ".argent", "flows", "old.yaml"));
      expect(errs).toEqual([]);
    });

    it("reads .argent/e2e first and warns about the shadowed legacy file", async () => {
      const root = await fsp.realpath(project);
      expect(await runIn(["run", "both"])).toBe(path.join(root, ".argent", "e2e", "both.yaml"));
      expect(errs).toEqual([
        "warning: .argent/flows/both.yaml is not used: .argent/e2e/both.yaml has the same name " +
          "and is read first.",
      ]);
    });

    it("gives the shadow warning as a JSON record under --json", async () => {
      await runIn(["run", "both", "--json"]);
      expect(errs.map((line) => JSON.parse(line))).toEqual([
        {
          event: "warning",
          warning:
            ".argent/flows/both.yaml is not used: .argent/e2e/both.yaml has the same name and " +
            "is read first.",
        },
      ]);
      expect(JSON.parse(logs.join("\n"))).toMatchObject({ ok: true });
    });

    // A nested `e2e-execute name:` resolves on the tool-server, which reports
    // its own shadow warning only in that step's result, at any depth.
    const shadowedNested =
      ".argent/flows/frag.yaml is not used: .argent/e2e/frag.yaml is read first.";
    const nestedRun = (): Record<string, unknown> =>
      report({
        steps: [
          {
            index: 0,
            kind: "tool",
            status: "pass",
            tool: "flow-execute",
            result: report({
              steps: [
                {
                  index: 0,
                  kind: "tool",
                  status: "pass",
                  tool: "e2e-execute",
                  result: report({ warning: shadowedNested }),
                },
              ],
              warning: shadowedNested,
            }),
          },
        ],
      });

    it("prints a nested step's shadow warning once on stderr", async () => {
      toolsClientMock.callTool.mockResolvedValue({ data: nestedRun() });
      await runIn(["run", "fresh"]);
      expect(errs).toEqual([`warning: ${shadowedNested}`]);
    });

    it("gives a nested step's warning as a JSON record under --json", async () => {
      toolsClientMock.callTool.mockResolvedValue({ data: nestedRun() });
      await runIn(["run", "fresh", "--json"]);
      expect(errs.map((line) => JSON.parse(line))).toEqual([
        { event: "warning", warning: shadowedNested },
      ]);
    });

    it("prints nested step warnings for each test of a directory run", async () => {
      toolsClientMock.callTool.mockResolvedValue({ data: nestedRun() });
      const previousCwd = process.cwd();
      try {
        process.chdir(project);
        await expect(flow(["run", ".argent/e2e"], opts)).rejects.toThrow("process.exit:0");
      } finally {
        process.chdir(previousCwd);
      }
      expect(errs).toEqual([`warning: ${shadowedNested}`, `warning: ${shadowedNested}`]);
    });
  });

  // `argent flow` is a silent alias (D7): every mode prints exactly what
  // `argent e2e` prints and exits the same way.
  it.each([
    ["a passing run", ["run", "saved"], () => report()],
    ["a passing run under --json", ["run", "saved", "--json"], () => report()],
    ["a passing run under --json-stream", ["run", "saved", "--json-stream"], () => report()],
    [
      "a failing run",
      ["run", "saved"],
      () =>
        report({
          ok: false,
          passed: 0,
          failed: 1,
          steps: [{ index: 0, kind: "tap", status: "fail", reason: "not found" }],
        }),
    ],
    [
      "a failing run under --json",
      ["run", "saved", "--json"],
      () => report({ ok: false, passed: 0, failed: 1 }),
    ],
    ["a missing name", ["run", "nosuch"], () => report()],
    ["a usage error under --json", ["run", "--json"], () => report()],
    ["help", ["--help"], () => report()],
    ["list", ["list"], () => report()],
    ["an unknown subcommand", ["frobnicate"], () => report()],
  ])("prints the same for `flow` and `e2e` on %s", async (_label, argv, data) => {
    const capture = async (command: typeof e2e) => {
      logs.length = 0;
      errs.length = 0;
      toolsClientMock.callTool.mockResolvedValue({ data: data() });
      let exit = "returned";
      const previousCwd = process.cwd();
      try {
        process.chdir(tempRoot);
        await command(argv, opts);
      } catch (err) {
        exit = (err as Error).message;
      } finally {
        process.chdir(previousCwd);
      }
      return { logs: [...logs], errs: [...errs], exit };
    };
    const viaE2e = await capture(e2e);
    const viaFlow = await capture(flowAlias);
    expect(viaFlow).toEqual(viaE2e);
    expect(viaE2e.logs.join("\n") + viaE2e.errs.join("\n")).not.toContain("argent flow");
  });

  it("says where a name looked when no flow is saved under it", async () => {
    const runRoot = await fsp.realpath(tempRoot);
    const previousCwd = process.cwd();
    try {
      process.chdir(tempRoot);
      await expect(flow(["run", "nosuchflow"], opts)).rejects.toThrow("process.exit:2");
    } finally {
      process.chdir(previousCwd);
    }

    expect(errs.join("\n")).toContain(
      `E2E test file not found: ${path.join(runRoot, ".argent", "e2e", "nosuchflow.yaml")}`
    );
    expect(errs.join("\n")).toContain("argent e2e list");
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("reads a .yaml argument as a path only — never falling back to .argent/flows", async () => {
    const runRoot = await fsp.realpath(tempRoot);
    const previousCwd = process.cwd();
    try {
      // "saved.yaml" exists under .argent/flows and nowhere else. An argument
      // carrying an extension is a path, so this must miss: letting it fall
      // back would make the meaning of a path depend on what happens to be
      // saved, and a later ./saved.yaml would silently re-point the run.
      process.chdir(tempRoot);
      await expect(flow(["run", "saved.yaml"], opts)).rejects.toThrow("process.exit:2");
    } finally {
      process.chdir(previousCwd);
    }

    expect(errs.join("\n")).toContain(
      `E2E test file not found: ${path.join(runRoot, "saved.yaml")}`
    );
    expect(errs.join("\n")).not.toContain(path.join(".argent", "flows", "saved.yaml"));
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    // Refused, but not blindly: the flow it names is saved one directory down,
    // so the message points at the name form rather than leaving the operator
    // to guess why a file they can see was not found.
    expect(errs.join("\n")).toContain("did you mean: argent e2e run saved");
  });

  it("does not offer the name form for a missing path with no saved flow behind it", async () => {
    const previousCwd = process.cwd();
    try {
      process.chdir(tempRoot);
      await expect(flow(["run", "nosuchflow.yaml"], opts)).rejects.toThrow("process.exit:2");
    } finally {
      process.chdir(previousCwd);
    }

    expect(errs.join("\n")).toContain("E2E test file not found");
    // Matched case-insensitively: every other recovery in this file spells the
    // phrase "Did you mean", so a capitalized hint must fail this too.
    expect(errs.join("\n")).not.toMatch(/did you mean/i);
    expect(errs.join("\n")).not.toContain("is saved under");
  });

  it("offers the on-disk spelling of a mis-cased path, not the one that was typed", async () => {
    // A hint built from the operator's spelling would say `run Saved` — which
    // `run`'s own byte-exact spelling check then refuses on a case-folding
    // filesystem, costing a second failure and pushing them to the path form
    // for a flow that is perfectly addressable by name. Reading the directory
    // entry settles the spelling once, on every filesystem.
    const previousCwd = process.cwd();
    try {
      process.chdir(tempRoot);
      await expect(flow(["run", "Saved.yaml"], opts)).rejects.toThrow("process.exit:2");
    } finally {
      process.chdir(previousCwd);
    }

    expect(errs.join("\n")).toContain("did you mean: argent e2e run saved");
    expect(errs.join("\n")).not.toContain("run Saved");
  });

  // Only a case-folding filesystem opens `.argent/flows/Saved.yaml` for an
  // on-disk `saved.yaml` and so reaches the spelling guard; see caseInsensitiveFs.
  it.skipIf(!caseInsensitiveFs)(
    "suggests the name form when a name matched only case-insensitively",
    async () => {
      const previousCwd = process.cwd();
      try {
        process.chdir(tempRoot);
        await expect(flow(["run", "Saved"], opts)).rejects.toThrow("process.exit:2");
      } finally {
        process.chdir(previousCwd);
      }

      // The operator typed a name, so the recovery is a name — not a path into a
      // directory they never spelled out.
      expect(errs.join("\n")).toContain("E2E test path must name the file as it appears on disk");
      expect(errs.join("\n")).toContain("Did you mean: argent e2e run saved");
      expect(errs.join("\n")).not.toContain(`Did you mean: argent e2e run ${path.join(".argent")}`);
      expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    }
  );

  it("does not offer a same-stem sibling when the missing path is already in the flows dir", async () => {
    const previousCwd = process.cwd();
    try {
      // A nested miss: `saved.yaml` exists at the top of .argent/flows, but it
      // is a different flow from the sub/saved.yaml that was asked for, and
      // the operator plainly knows where flows live.
      process.chdir(tempRoot);
      await expect(
        flow(["run", path.join(".argent", "flows", "sub", "saved.yaml")], opts)
      ).rejects.toThrow("process.exit:2");
    } finally {
      process.chdir(previousCwd);
    }

    expect(errs.join("\n")).toContain("E2E test file not found");
    expect(errs.join("\n")).not.toMatch(/did you mean/i);
  });

  it("keeps the trailing-separator hint a path when trimming would read as a name", async () => {
    const previousCwd = process.cwd();
    try {
      process.chdir(tempRoot);
      await expect(flow(["run", "saved/"], opts)).rejects.toThrow("process.exit:2");
    } finally {
      process.chdir(previousCwd);
    }

    // Trimming leaves "saved", which now addresses .argent/flows/saved.yaml —
    // a different file from the ./saved this argument names, and one that would
    // actually run. The recovery must not re-point the operator there.
    expect(errs.join("\n")).toContain("must not end in a path separator");
    expect(errs.join("\n")).toContain(`Did you mean: argent e2e run .${path.sep}saved`);
    expect(errs.join("\n")).not.toMatch(/Did you mean: argent e2e run saved$/m);
  });

  it("names the flow-name charset for a bare argument that is neither a name nor a path", async () => {
    await expect(flow(["run", "my flow"], opts)).rejects.toThrow("process.exit:2");

    expect(errs.join("\n")).toContain(
      'E2E test name must contain only letters, numbers, "_", or "-": my flow'
    );
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("rejects missing and invalid YAML paths before routing or tool invocation", async () => {
    await expect(flow(["run", path.join(tempRoot, "missing.yaml")], opts)).rejects.toThrow(
      "process.exit:2"
    );
    expect(errs.join("\n")).toContain("E2E test file not found");

    errs.length = 0;
    await expect(flow(["run", path.join(tempRoot, "checkout.yml")], opts)).rejects.toThrow(
      "process.exit:2"
    );
    expect(errs.join("\n")).toContain("E2E test path must end in .yaml");

    errs.length = 0;
    await expect(flow(["run", path.join(tempRoot, "unsafe name.yaml")], opts)).rejects.toThrow(
      "process.exit:2"
    );
    expect(errs.join("\n")).toContain("E2E test filename must have a non-empty name");
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("names the lowercase requirement when only the extension's case is wrong", async () => {
    await expect(flow(["run", path.join(tempRoot, "Checkout.YAML")], opts)).rejects.toThrow(
      "process.exit:2"
    );

    expect(errs.join("\n")).toContain("E2E test extension must be lowercase .yaml, not .YAML");
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  // The lowercase-.yaml guard checks the SUPPLIED spelling, but stat matches
  // by the filesystem's rules — on APFS/NTFS a lowercase retyping of
  // "Upper.YAML" finds the file, and without the exact-basename check the run
  // would proceed under a flow name ("upper") no file on disk carries, mis-
  // keying __baselines__/ and --output. These fixtures probe the filesystem
  // rather than assume it: on a case-sensitive one (ext4 CI) the lowercase
  // spelling is simply ENOENT. Both branches assert the contract that
  // matters — rejected either way, e2e-execute never invoked — and the
  // case-insensitive branch additionally pins the message, since there the
  // supplied path looks perfectly valid to the operator.
  it("refuses a case-insensitive extension match, telling the operator to rename the file", async () => {
    const caseRoot = path.join(tempRoot, "case-ext-project");
    await fsp.mkdir(caseRoot, { recursive: true });
    await fsp.writeFile(path.join(caseRoot, "Upper.YAML"), "steps: []\n");
    const lowercase = path.join(caseRoot, "upper.yaml");
    const caseInsensitiveFs = await fsp.stat(lowercase).then(
      () => true,
      () => false
    );

    await expect(flow(["run", lowercase], opts)).rejects.toThrow("process.exit:2");

    const out = errs.join("\n");
    if (caseInsensitiveFs) {
      // The real name is itself unrunnable (uppercase extension), so the
      // recovery must be a rename — not a Did-you-mean that would be refused.
      expect(out).toContain("E2E test path must name the file as it appears on disk");
      expect(out).toContain('"Upper.YAML"');
      expect(out).toContain("Rename Upper.YAML to upper.yaml");
    } else {
      expect(out).toContain("E2E test file not found");
    }
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("refuses a case-insensitive stem match, hinting the file's real (runnable) name", async () => {
    const caseRoot = path.join(tempRoot, "case-stem-project");
    await fsp.mkdir(caseRoot, { recursive: true });
    await fsp.writeFile(path.join(caseRoot, "Checkout.yaml"), "steps: []\n");
    const lowercase = path.join(caseRoot, "checkout.yaml");
    const caseInsensitiveFs = await fsp.stat(lowercase).then(
      () => true,
      () => false
    );

    await expect(flow(["run", lowercase], opts)).rejects.toThrow("process.exit:2");

    const out = errs.join("\n");
    if (caseInsensitiveFs) {
      // "Checkout.yaml" passes every name guard, so here the hint can be the
      // command that actually works.
      expect(out).toContain("E2E test path must name the file as it appears on disk");
      expect(out).toContain(`Did you mean: argent e2e run ${path.join(caseRoot, "Checkout.yaml")}`);
    } else {
      expect(out).toContain("E2E test file not found");
    }
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("still runs a symlinked flow under the link's own name", async () => {
    // Pins the exact-basename check to the directory listing rather than
    // realpath: realpath would rewrite the link to its target's name and
    // refuse a spelling `flow run` has always accepted (and `flow list`
    // advertises).
    const linkRoot = path.join(tempRoot, "run-symlink-project");
    await fsp.mkdir(linkRoot, { recursive: true });
    await fsp.writeFile(path.join(linkRoot, "target-flow.yaml"), "steps: []\n");
    await fsp.symlink(path.join(linkRoot, "target-flow.yaml"), path.join(linkRoot, "linked.yaml"));

    await expect(flow(["run", path.join(linkRoot, "linked.yaml")], opts)).rejects.toThrow(
      "process.exit:0"
    );

    expect(toolsClientMock.callTool).toHaveBeenCalledTimes(1);
    expect(errs).toEqual([]);
  });

  it.each([[".yaml"], ["dir/.yaml"], [".YAML"]])(
    "names the missing stem when the path %s is only the extension",
    async (supplied) => {
      await expect(flow(["run", supplied], opts)).rejects.toThrow("process.exit:2");

      expect(errs.join("\n")).toContain("E2E test filename must have a non-empty name");
      expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
      expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    }
  );

  it("rejects a path with a .. segment before resolving, routing, or tool invocation", async () => {
    // Assembled with the separator directly — path.join would collapse the
    // ".." lexically before the CLI ever saw it, which is the exact behavior
    // under test. Nothing named "nope" exists, so realpath fails and the
    // generic recovery line is printed instead of a Did-you-mean hint.
    const supplied = [tempRoot, "nope", "..", "checkout.yaml"].join(path.sep);
    await expect(flow(["run", supplied], opts)).rejects.toThrow("process.exit:2");

    const out = errs.join("\n");
    expect(out).toContain('E2E test path must not contain ".." segments');
    expect(out).toContain("Pass the fully resolved path to the e2e test's YAML.");
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("hints the kernel-resolved target when .. follows a symlinked directory", async () => {
    // The reviewer's repro shape: flows/link -> decoy/inner, so the kernel
    // opens decoy/login.yaml for "flows/link/../login.yaml" while path.resolve
    // would have collapsed it to flows/login.yaml — a different file. Both
    // files exist to prove the hint names the kernel's target, not the
    // lexical one.
    const dotdotRoot = path.join(tempRoot, "dotdot-project");
    const flowsDir = path.join(dotdotRoot, "flows");
    const decoyDir = path.join(dotdotRoot, "decoy");
    await fsp.mkdir(path.join(decoyDir, "inner"), { recursive: true });
    await fsp.mkdir(flowsDir, { recursive: true });
    await fsp.writeFile(path.join(decoyDir, "login.yaml"), "steps: []\n");
    await fsp.writeFile(path.join(flowsDir, "login.yaml"), "steps: []\n");
    await fsp.symlink(path.join(decoyDir, "inner"), path.join(flowsDir, "link"), "dir");
    const supplied = [flowsDir, "link", "..", "login.yaml"].join(path.sep);

    await expect(flow(["run", supplied], opts)).rejects.toThrow("process.exit:2");

    // realpath'd expectation: on macOS tmpdir itself sits behind a symlink
    // (/var -> /private/var), so the hint's path differs from the joined one.
    const kernelTarget = await fsp.realpath(path.join(decoyDir, "login.yaml"));
    const out = errs.join("\n");
    expect(out).toContain('E2E test path must not contain ".." segments');
    expect(out).toContain(`Did you mean: argent e2e run ${kernelTarget}`);
    // Readability pin: a path a shell passes through verbatim stays bare —
    // quoting is reserved for paths that need it.
    expect(out).not.toContain("argent e2e run '");
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("shell-quotes the .. hint when the resolved path would be mangled by a shell", async () => {
    // The hint is a command to paste into a terminal — unquoted, the space in
    // the resolved path would word-split into a truncated path plus a stray
    // argument the CLI then rejects. The dir name also embeds a single quote
    // to pin the '\'' splice, the one escape the single-quote wrapping needs.
    const quoteRoot = path.join(tempRoot, "o'brien lab");
    const flowsDir = path.join(quoteRoot, "flows");
    await fsp.mkdir(flowsDir, { recursive: true });
    await fsp.writeFile(path.join(quoteRoot, "login.yaml"), "steps: []\n");
    const supplied = [flowsDir, "..", "login.yaml"].join(path.sep);

    await expect(flow(["run", supplied], opts)).rejects.toThrow("process.exit:2");

    // realpath'd prefix: macOS tmpdir sits behind /var -> /private/var. The
    // expectation is written out literally rather than derived through any
    // quoting helper, so the test cannot inherit a helper bug.
    const realRoot = await fsp.realpath(tempRoot);
    expect(errs.join("\n")).toContain(
      `Did you mean: argent e2e run '${realRoot}/o'\\''brien lab/login.yaml'`
    );
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("keeps the supplied basename in the .. hint for a symlinked flow", async () => {
    // realpath of the whole path would rewrite linked.yaml to its target's
    // name — a hint that silently renames the flow (report name,
    // __baselines__/ key, --output dir) out from under the user. Only the
    // directories are dishonest under "..", so only they get resolved.
    const linkRoot = path.join(tempRoot, "dotdot-symlink-project");
    const flowsDir = path.join(linkRoot, "flows");
    await fsp.mkdir(path.join(flowsDir, "extra"), { recursive: true });
    await fsp.writeFile(path.join(flowsDir, "target-flow.yaml"), "steps: []\n");
    await fsp.symlink(path.join(flowsDir, "target-flow.yaml"), path.join(flowsDir, "linked.yaml"));
    const supplied = [flowsDir, "extra", "..", "linked.yaml"].join(path.sep);

    await expect(flow(["run", supplied], opts)).rejects.toThrow("process.exit:2");

    const hinted = path.join(await fsp.realpath(flowsDir), "linked.yaml");
    expect(errs.join("\n")).toContain(`Did you mean: argent e2e run ${hinted}`);
    // Pasting the hint back must actually work: the path exists, keeps the
    // link's own name, and passes run's exact-basename guard.
    await expect(flow(["run", hinted], opts)).rejects.toThrow("process.exit:0");
    expect(toolsClientMock.callTool).toHaveBeenCalledTimes(1);
  });

  it("falls back to the generic .. recovery when the reassembled path does not exist", async () => {
    // The parent realpath alone is not enough for a hint: reassembled with
    // the supplied basename it must name something kernel-reachable, or the
    // hint would be a command that cannot work.
    const ghostRoot = path.join(tempRoot, "dotdot-ghost-project");
    await fsp.mkdir(path.join(ghostRoot, "present"), { recursive: true });
    const supplied = [ghostRoot, "present", "..", "ghost.yaml"].join(path.sep);

    await expect(flow(["run", supplied], opts)).rejects.toThrow("process.exit:2");

    const out = errs.join("\n");
    expect(out).toContain('E2E test path must not contain ".." segments');
    expect(out).toContain("Pass the fully resolved path to the e2e test's YAML.");
    expect(out).not.toContain("Did you mean");
  });

  it.each([["/"], ["\\"], ["//"]])(
    "rejects a flow path with trailing separator %j before resolve drops it",
    async (trailer) => {
      // checkout.yaml exists, and path.resolve drops the trailing separator
      // lexically — so without the guard the CLI would stat the real file and
      // run it, even though the kernel refuses to open "checkout.yaml/"
      // (ENOTDIR). The hint is the same string minus the separators.
      await expect(flow(["run", checkoutPath + trailer], opts)).rejects.toThrow("process.exit:2");

      const out = errs.join("\n");
      expect(out).toContain("E2E test path must not end in a path separator");
      expect(out).toContain(`Did you mean: argent e2e run ${checkoutPath}`);
      expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
      expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    }
  );

  it("shell-quotes the trailing-separator hint when the trimmed path contains a space", async () => {
    // Same defect class as the .. hint: the echoed path is pasted into a
    // shell command, and a space would word-split it. Nothing needs to exist
    // on disk for this guard, so the fixture is just a string.
    const trimmed = path.join(tempRoot, "low space", "lab.yaml");

    await expect(flow(["run", trimmed + path.sep], opts)).rejects.toThrow("process.exit:2");

    const out = errs.join("\n");
    expect(out).toContain("E2E test path must not end in a path separator");
    expect(out).toContain(`Did you mean: argent e2e run '${trimmed}'`);
  });

  it("lets the .. guard win when a path has both a .. segment and a trailing separator", async () => {
    // Both dishonest-path predicates match. The ".." recovery (a fully
    // resolved path) also cures the trailing separator, while the
    // separator-stripped hint would leave the ".." standing — so the ".."
    // complaint must be the one printed.
    const supplied = [tempRoot, "nope", "..", "checkout.yaml", ""].join(path.sep);
    await expect(flow(["run", supplied], opts)).rejects.toThrow("process.exit:2");

    const out = errs.join("\n");
    expect(out).toContain('E2E test path must not contain ".." segments');
    expect(out).not.toContain("E2E test path must not end in a path separator");
  });

  it("dispatches a path that is only separators to directory mode, not the separator guard", async () => {
    // "/" names the root directory honestly — there is no separator-stripped
    // spelling to hint at — so it batches like any other directory and fails
    // discovery (root holds no flows) rather than drawing a shape complaint.
    await expect(flow(["run", "/"], opts)).rejects.toThrow("process.exit:2");

    const out = errs.join("\n");
    expect(out).toContain("No e2e tests found in /");
    expect(out).not.toContain("E2E test path must not end in a path separator");
  });

  it("exits 2 on an empty directory named like a flow instead of handing it to e2e-execute", async () => {
    // A directory — even one named `bundle.yaml` — dispatches to directory
    // mode (the isDirectory() branch runs before any file check), so it is
    // never handed to e2e-execute as a file; empty, it fails discovery
    // before routing is consulted or a client is built.
    await expect(flow(["run", bundleDirPath], opts)).rejects.toThrow("process.exit:2");

    expect(errs.join("\n")).toContain(`No e2e tests found in ${bundleDirPath}`);
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  // Skipped as root / on Windows, where a mode-000 file is still readable —
  // see canDenyRead.
  it.skipIf(!canDenyRead)(
    "exits 2 on an unreadable flow file rather than letting e2e-execute hit EACCES",
    async () => {
      // The exit code is the contract, not just the wording: without the
      // readability probe the EACCES surfaces out of the tool call instead,
      // which exits 1 — a CI wrapper that tells a usage error (2) from a run
      // failure (1) would silently reclassify an unreadable file as a failing run.
      await expect(flow(["run", unreadablePath], opts)).rejects.toThrow("process.exit:2");

      expect(errs.join("\n")).toContain(`Could not read e2e test file: ${unreadablePath}`);
      expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
      expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    }
  );

  it("lists runnable YAML paths without consulting remote routing", async () => {
    const listRoot = path.join(tempRoot, "list-project");
    const flowsDir = path.join(listRoot, ".argent", "e2e");
    await fsp.mkdir(flowsDir, { recursive: true });
    await Promise.all([
      fsp.writeFile(path.join(flowsDir, "z-last.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "a-first.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "ignored.yml"), "steps: []\n"),
    ]);
    getResolvedToolsUrlMock.mockResolvedValue({
      url: "http://example.test:4141",
      source: "env",
    });
    const previousCwd = process.cwd();
    try {
      process.chdir(listRoot);
      await flow(["list"], opts);
    } finally {
      process.chdir(previousCwd);
    }

    expect(logs.join("\n")).toBe(
      [".argent/e2e/a-first.yaml", ".argent/e2e/z-last.yaml"].join("\n")
    );
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("lists nested flows at any depth — paths `flow run` accepts", async () => {
    // run's name contract binds the filename only, so a YAML under an
    // intermediate directory is just as runnable as a top-level one — a
    // non-recursive listing would hide it.
    const listRoot = path.join(tempRoot, "list-nested-project");
    const flowsDir = path.join(listRoot, ".argent", "e2e");
    await fsp.mkdir(path.join(flowsDir, "suite", "deep"), { recursive: true });
    await fsp.mkdir(path.join(flowsDir, "x"));
    await Promise.all([
      fsp.writeFile(path.join(flowsDir, "top.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "suite", "checkout.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "suite", "deep", "login.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "x-y.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "x", "z.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "a.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "B.yaml"), "steps: []\n"),
    ]);
    const previousCwd = process.cwd();
    try {
      process.chdir(listRoot);
      await flow(["list"], opts);

      // Deterministic: sorted over the full relative paths, not walk order.
      expect(logs.join("\n")).toBe(
        [
          ".argent/e2e/B.yaml",
          ".argent/e2e/a.yaml",
          ".argent/e2e/suite/checkout.yaml",
          ".argent/e2e/suite/deep/login.yaml",
          ".argent/e2e/top.yaml",
          ".argent/e2e/x-y.yaml",
          ".argent/e2e/x/z.yaml",
        ].join("\n")
      );

      // The other half of the agreement: the deepest advertised path runs.
      await expect(flow(["run", ".argent/e2e/suite/deep/login.yaml"], opts)).rejects.toThrow(
        "process.exit:0"
      );
      expect(toolsClientMock.callTool).toHaveBeenCalledTimes(1);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("never lists the inside of __baselines__, a dot-directory or node_modules, at any depth", async () => {
    const listRoot = path.join(tempRoot, "list-skipped-project");
    await writeSkippedDirsTree(path.join(listRoot, ".argent", "e2e"));
    const previousCwd = process.cwd();
    try {
      process.chdir(listRoot);
      await flow(["list"], opts);
    } finally {
      process.chdir(previousCwd);
    }

    expect(logs.join("\n")).toBe(
      [".argent/e2e/suite/nested.yaml", ".argent/e2e/top.yaml"].join("\n")
    );
  });

  it("lists only YAML files with the shape of an e2e test, and keeps broken and empty ones", async () => {
    const listRoot = path.join(tempRoot, "list-shape-project");
    await writeShapeFixture(path.join(listRoot, ".argent", "e2e"));
    const previousCwd = process.cwd();
    try {
      process.chdir(listRoot);
      await flow(["list"], opts);
    } finally {
      process.chdir(previousCwd);
    }

    expect(logs.join("\n")).toBe(
      Object.keys(KEPT_YAMLS)
        .sort()
        .map((name) => `.argent/e2e/${name}`)
        .join("\n")
    );
  });

  it("warns about empty files and files with a syntax error, on stderr and under --json", async () => {
    const listRoot = path.join(tempRoot, "list-warning-project");
    await writeShapeFixture(path.join(listRoot, ".argent", "e2e"));
    const legacyDir = path.join(listRoot, ".argent", "flows");
    await fsp.mkdir(legacyDir, { recursive: true });
    await fsp.writeFile(path.join(legacyDir, "empty.yaml"), "");
    await fsp.writeFile(path.join(legacyDir, "real.yaml"), "steps: []\n");
    const previousCwd = process.cwd();
    try {
      process.chdir(listRoot);
      await flow(["list"], opts);

      expect(logs).toEqual([
        [
          ".argent/e2e/blank.yaml",
          ".argent/e2e/broken.yaml",
          ".argent/e2e/empty.yaml",
          ".argent/e2e/header-version.yaml",
          ".argent/e2e/integer-version.yaml",
          ".argent/e2e/newer.yaml",
          ".argent/e2e/null-steps.yaml",
          ".argent/e2e/real.yaml",
          ".argent/e2e/steps-map.yaml",
          ".argent/e2e/zero-steps.yaml",
          ".argent/flows/empty.yaml",
          ".argent/flows/real.yaml",
        ].join("\n"),
      ]);
      expect(errs).toEqual([
        "warning: .argent/e2e/blank.yaml is empty",
        "warning: .argent/e2e/broken.yaml has a YAML syntax error",
        "warning: .argent/e2e/empty.yaml is empty",
        "warning: .argent/flows/empty.yaml is shadowed by .argent/e2e/empty.yaml when run by name",
        "warning: .argent/flows/empty.yaml is empty",
        "warning: .argent/flows/real.yaml is shadowed by .argent/e2e/real.yaml when run by name",
        "note: 2 tests listed from .argent/flows (legacy); move them to .argent/e2e",
      ]);

      logs.length = 0;
      errs.length = 0;
      await flow(["list", "--json"], opts);
    } finally {
      process.chdir(previousCwd);
    }

    expect(errs).toEqual([]);
    expect(JSON.parse(logs.join("\n")).e2eTests).toStrictEqual([
      { path: ".argent/e2e/blank.yaml", name: "blank", legacy: false, warning: "empty" },
      { path: ".argent/e2e/broken.yaml", name: "broken", legacy: false, warning: "syntax-error" },
      { path: ".argent/e2e/empty.yaml", name: "empty", legacy: false, warning: "empty" },
      { path: ".argent/e2e/header-version.yaml", name: "header-version", legacy: false },
      { path: ".argent/e2e/integer-version.yaml", name: "integer-version", legacy: false },
      { path: ".argent/e2e/newer.yaml", name: "newer", legacy: false },
      { path: ".argent/e2e/null-steps.yaml", name: "null-steps", legacy: false },
      { path: ".argent/e2e/real.yaml", name: "real", legacy: false },
      { path: ".argent/e2e/steps-map.yaml", name: "steps-map", legacy: false },
      { path: ".argent/e2e/zero-steps.yaml", name: "zero-steps", legacy: false },
      {
        path: ".argent/flows/empty.yaml",
        name: "empty",
        legacy: true,
        shadowedBy: ".argent/e2e/empty.yaml",
        warning: "empty",
      },
      {
        path: ".argent/flows/real.yaml",
        name: "real",
        legacy: true,
        shadowedBy: ".argent/e2e/real.yaml",
      },
    ]);
  });

  it("emits no YAML warning for a file with an unknown tag", async () => {
    const listRoot = path.join(tempRoot, "list-tag-project");
    await fsp.mkdir(listRoot, { recursive: true });
    await fsp.writeFile(path.join(listRoot, "tagged.yaml"), "steps: []\nValue: !Ref X\n");
    const warnSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      await flow(["list", listRoot], opts);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }

    expect(logs.join("\n")).toBe(path.join(listRoot, "tagged.yaml"));
  });

  it.each([
    { command: "run <dir>", flags: [], count: 1 },
    { command: "run <dir> --recursive", flags: ["--recursive"], count: 5 },
  ])("lists the same tests that `$command` runs", async ({ flags, count }) => {
    const root = path.join(tempRoot, "list-run-agreement");
    await writeSkippedDirsTree(root);
    await writeSkippedDirsTree(path.join(root, ".argent", "e2e"));
    await fsp.mkdir(path.join(root, "suite", "deep"), { recursive: true });
    await fsp.writeFile(path.join(root, "suite", "deep", "deeper.yaml"), "steps: []\n");
    await fsp.writeFile(path.join(root, "suite", "docker-compose.yaml"), "services: {}\n");

    await flow(["list", root, ...flags], opts);
    const listed = logs.join("\n").split("\n");
    await expect(flow(["run", root, ...flags], opts)).rejects.toThrow("process.exit:0");

    const ran = toolsClientMock.callTool.mock.calls.map(
      (c) => (c[1] as { e2e_test_path: string }).e2e_test_path
    );
    expect(ran).toHaveLength(count);
    expect(listed).toEqual(ran);
  });

  it("omits .yaml files whose names `flow run` would reject — and `run` does reject them", async () => {
    const listRoot = path.join(tempRoot, "list-unsafe-project");
    const flowsDir = path.join(listRoot, ".argent", "e2e");
    await fsp.mkdir(flowsDir, { recursive: true });
    await Promise.all([
      fsp.writeFile(path.join(flowsDir, "sign.in.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "ok (copy).yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "sign-in.yaml"), "steps: []\n"),
    ]);
    const previousCwd = process.cwd();
    try {
      process.chdir(listRoot);
      await flow(["list"], opts);

      // Silently omitted, like non-.yaml entries — every printed path is runnable.
      expect(logs.join("\n")).toBe(".argent/e2e/sign-in.yaml");

      // The omissions are agreements, not gaps: the very fixtures `list`
      // hides must be ones `run` refuses, or the omission would be hiding
      // runnable paths. Pin both halves against the same files.
      for (const unsafe of ["sign.in.yaml", "ok (copy).yaml"]) {
        errs.length = 0;
        await expect(flow(["run", `.argent/e2e/${unsafe}`], opts)).rejects.toThrow(
          "process.exit:2"
        );
        expect(errs.join("\n")).toContain("E2E test filename must have a non-empty name");
      }
      expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("omits a directory named like a flow, which `flow run` rejects as not a file", async () => {
    const listRoot = path.join(tempRoot, "list-dir-project");
    const flowsDir = path.join(listRoot, ".argent", "e2e");
    await fsp.mkdir(path.join(flowsDir, "bundle.yaml"), { recursive: true });
    await fsp.writeFile(path.join(flowsDir, "checkout.yaml"), "steps: []\n");
    const previousCwd = process.cwd();
    try {
      process.chdir(listRoot);
      await flow(["list"], opts);
    } finally {
      process.chdir(previousCwd);
    }

    expect(logs.join("\n")).toBe(".argent/e2e/checkout.yaml");
  });

  // Skipped as root / on Windows, where a mode-000 file is still readable —
  // see canDenyRead.
  it.skipIf(!canDenyRead)(
    "omits an unreadable flow file, which `flow run` rejects as unreadable",
    async () => {
      const listRoot = path.join(tempRoot, "list-noperm-project");
      const flowsDir = path.join(listRoot, ".argent", "e2e");
      await fsp.mkdir(flowsDir, { recursive: true });
      const unreadable = path.join(flowsDir, "noperm.yaml");
      await fsp.writeFile(path.join(flowsDir, "checkout.yaml"), "steps: []\n");
      await fsp.writeFile(unreadable, "steps: []\n");
      await fsp.chmod(unreadable, 0o000);
      const previousCwd = process.cwd();
      try {
        process.chdir(listRoot);
        await flow(["list"], opts);
      } finally {
        process.chdir(previousCwd);
        // Restore before afterAll's rm walks the tree (see there).
        await fsp.chmod(unreadable, 0o600);
      }

      // stat() succeeds on it — only the readability probe keeps `list` from
      // advertising a path `flow run` then refuses.
      expect(logs.join("\n")).toBe(".argent/e2e/checkout.yaml");
    }
  );

  it("lists a symlink to a flow file, which `flow run` accepts, but not a broken one", async () => {
    const listRoot = path.join(tempRoot, "list-symlink-project");
    const flowsDir = path.join(listRoot, ".argent", "e2e");
    await fsp.mkdir(flowsDir, { recursive: true });
    await fsp.writeFile(path.join(tempRoot, "shared-flow.yaml"), "steps: []\n");
    await fsp.symlink(path.join(tempRoot, "shared-flow.yaml"), path.join(flowsDir, "linked.yaml"));
    await fsp.symlink(path.join(tempRoot, "missing-flow.yaml"), path.join(flowsDir, "broken.yaml"));
    const previousCwd = process.cwd();
    try {
      process.chdir(listRoot);
      await flow(["list"], opts);
    } finally {
      process.chdir(previousCwd);
    }

    expect(logs.join("\n")).toBe(".argent/e2e/linked.yaml");
  });

  it.each(["--help", "-h"])("prints the help for list %s instead of listing", async (flag) => {
    const listRoot = path.join(tempRoot, "list-help-project");
    await fsp.mkdir(path.join(listRoot, ".argent", "e2e"), { recursive: true });
    await fsp.writeFile(path.join(listRoot, ".argent", "e2e", "a.yaml"), "steps: []\n");
    const previousCwd = process.cwd();
    try {
      process.chdir(listRoot);
      await flow(["list", flag], opts);
    } finally {
      process.chdir(previousCwd);
    }

    expect(logs.join("\n")).toContain("Usage: argent e2e <subcommand> [options]");
    expect(logs.join("\n")).not.toContain(".argent/e2e/a.yaml");
  });

  it("prints the no-flows message when no entry in the directory is runnable", async () => {
    const listRoot = path.join(tempRoot, "list-empty-project");
    const flowsDir = path.join(listRoot, ".argent", "e2e");
    await fsp.mkdir(path.join(flowsDir, "bundle.yaml"), { recursive: true });
    const previousCwd = process.cwd();
    try {
      process.chdir(listRoot);
      await flow(["list"], opts);
    } finally {
      process.chdir(previousCwd);
    }

    expect(logs).toEqual([]);
    expect(errs).toEqual(["No e2e tests found in .argent/e2e or .argent/flows"]);
  });

  it("lists both e2e test directories as bare paths, with legacy and shadow notes on stderr", async () => {
    const listRoot = path.join(tempRoot, "list-both-dirs-project");
    const e2eDir = path.join(listRoot, ".argent", "e2e");
    const legacyDir = path.join(listRoot, ".argent", "flows");
    await fsp.mkdir(path.join(legacyDir, "suite"), { recursive: true });
    await fsp.mkdir(e2eDir, { recursive: true });
    await Promise.all([
      fsp.writeFile(path.join(e2eDir, "checkout.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(legacyDir, "checkout.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(legacyDir, "login.yaml"), "steps: []\n"),
      // Only a top-level file is reachable by name, so a nested one is never shadowed.
      fsp.writeFile(path.join(legacyDir, "suite", "checkout.yaml"), "steps: []\n"),
    ]);
    const previousCwd = process.cwd();
    try {
      process.chdir(listRoot);
      await flow(["list"], opts);
    } finally {
      process.chdir(previousCwd);
    }

    expect(logs.join("\n")).toBe(
      [
        ".argent/e2e/checkout.yaml",
        ".argent/flows/checkout.yaml",
        ".argent/flows/login.yaml",
        ".argent/flows/suite/checkout.yaml",
      ].join("\n")
    );
    expect(errs).toEqual([
      "warning: .argent/flows/checkout.yaml is shadowed by .argent/e2e/checkout.yaml when run by name",
      "note: 3 tests listed from .argent/flows (legacy); move them to .argent/e2e",
    ]);
  });

  it("keeps list stdout to bare paths for a legacy-only project, so it pipes into xargs", async () => {
    const listRoot = path.join(tempRoot, "list-legacy-only-project");
    const legacyDir = path.join(listRoot, ".argent", "flows");
    await fsp.mkdir(legacyDir, { recursive: true });
    await fsp.writeFile(path.join(legacyDir, "a.yaml"), "steps: []\n");
    const previousCwd = process.cwd();
    try {
      process.chdir(listRoot);
      await flow(["list"], opts);
    } finally {
      process.chdir(previousCwd);
    }

    expect(logs).toEqual([".argent/flows/a.yaml"]);
    expect(logs.join("\n")).not.toMatch(/[ ()]/);
    expect(errs).toEqual([
      "note: 1 test listed from .argent/flows (legacy); move it to .argent/e2e",
    ]);
  });

  it("prints the list as JSON with --json, in the plain order and with no stderr notes", async () => {
    const listRoot = path.join(tempRoot, "list-json-project");
    const e2eDir = path.join(listRoot, ".argent", "e2e");
    const legacyDir = path.join(listRoot, ".argent", "flows");
    await fsp.mkdir(path.join(e2eDir, "suite"), { recursive: true });
    await fsp.mkdir(legacyDir, { recursive: true });
    await Promise.all([
      fsp.writeFile(path.join(e2eDir, "login.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(e2eDir, "suite", "pay.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(legacyDir, "login.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(legacyDir, "signup.yaml"), "steps: []\n"),
    ]);
    const previousCwd = process.cwd();
    try {
      process.chdir(listRoot);
      await flow(["list"], opts);
      const plainPaths = [...logs];
      logs.length = 0;
      errs.length = 0;
      await flow(["list", "--json"], opts);

      expect(errs).toEqual([]);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toBe(JSON.stringify(JSON.parse(logs[0]!), null, 2));
      const { e2eTests } = JSON.parse(logs[0]!);
      expect(e2eTests).toEqual([
        { path: ".argent/e2e/login.yaml", name: "login", legacy: false },
        { path: ".argent/e2e/suite/pay.yaml", legacy: false },
        {
          path: ".argent/flows/login.yaml",
          name: "login",
          legacy: true,
          shadowedBy: ".argent/e2e/login.yaml",
        },
        { path: ".argent/flows/signup.yaml", name: "signup", legacy: true },
      ]);
      expect(e2eTests.map((t: { path: string }) => t.path).join("\n")).toBe(plainPaths.join("\n"));
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("lets an e2e test with a broken steps value shadow the legacy test of the same name", async () => {
    const listRoot = path.join(tempRoot, "list-broken-steps-shadow");
    const e2eDir = path.join(listRoot, ".argent", "e2e");
    const legacyDir = path.join(listRoot, ".argent", "flows");
    await fsp.mkdir(e2eDir, { recursive: true });
    await fsp.mkdir(legacyDir, { recursive: true });
    await fsp.writeFile(path.join(e2eDir, "login.yaml"), "version: 1\nsteps:\n  echo: hi\n");
    await fsp.writeFile(path.join(legacyDir, "login.yaml"), "steps:\n  - echo: legacy\n");
    const previousCwd = process.cwd();
    try {
      process.chdir(listRoot);
      await flow(["list"], opts);

      expect(errs).toContain(
        "warning: .argent/flows/login.yaml is shadowed by .argent/e2e/login.yaml when run by name"
      );

      logs.length = 0;
      await flow(["list", "--json"], opts);
    } finally {
      process.chdir(previousCwd);
    }

    expect(JSON.parse(logs.join("\n")).e2eTests).toStrictEqual([
      { path: ".argent/e2e/login.yaml", name: "login", legacy: false },
      {
        path: ".argent/flows/login.yaml",
        name: "login",
        legacy: true,
        shadowedBy: ".argent/e2e/login.yaml",
      },
    ]);
  });

  it.each([
    {
      label: "neither e2e test directory exists",
      dirs: [],
      stdout: [],
      stderr: [
        "warning: no .argent/e2e or .argent/flows directory in the current working directory",
      ],
      doc: { e2eTests: [], warning: "no-e2e-directory" },
    },
    {
      label: "only .argent/flows exists",
      dirs: [".argent/flows"],
      test: ".argent/flows/a.yaml",
      stdout: [".argent/flows/a.yaml"],
      stderr: ["note: 1 test listed from .argent/flows (legacy); move it to .argent/e2e"],
      doc: { e2eTests: [{ path: ".argent/flows/a.yaml", name: "a", legacy: true }] },
    },
    {
      label: "the e2e test directories are empty",
      dirs: [".argent/e2e", ".argent/flows"],
      stdout: [],
      stderr: ["No e2e tests found in .argent/e2e or .argent/flows"],
      doc: { e2eTests: [] },
    },
  ])(
    "prints list and list --json when $label",
    async ({ label, dirs, test, stdout, stderr, doc }) => {
      const listRoot = path.join(tempRoot, `list-${label.replaceAll(" ", "-")}`);
      await fsp.mkdir(listRoot, { recursive: true });
      for (const dir of dirs) await fsp.mkdir(path.join(listRoot, dir), { recursive: true });
      if (test) await fsp.writeFile(path.join(listRoot, test), "steps: []\n");
      const previousCwd = process.cwd();
      try {
        process.chdir(listRoot);
        await flow(["list"], opts);
        expect(logs).toEqual(stdout);
        expect(errs).toEqual(stderr);
        logs.length = 0;
        errs.length = 0;
        await flow(["list", "--json"], opts);
      } finally {
        process.chdir(previousCwd);
      }

      expect(errs).toEqual([]);
      expect(logs).toEqual([JSON.stringify(doc, null, 2)]);
    }
  );

  it.skipIf(!canDenyRead)(
    "fails list and list --json with exit 2 when .argent/e2e cannot be read",
    async () => {
      const listRoot = path.join(tempRoot, "list-locked-e2e-dir");
      const locked = path.join(listRoot, ".argent", "e2e");
      await fsp.mkdir(locked, { recursive: true });
      await fsp.chmod(locked, 0o000);
      const previousCwd = process.cwd();
      try {
        process.chdir(listRoot);
        await expect(flow(["list"], opts)).rejects.toThrow("process.exit:2");
        expect(logs).toEqual([]);
        expect(errs).toEqual(["Could not read e2e test directory: .argent/e2e"]);
        errs.length = 0;
        await expect(flow(["list", "--json"], opts)).rejects.toThrow("process.exit:2");
      } finally {
        process.chdir(previousCwd);
        await fsp.chmod(locked, 0o755);
      }

      expect(logs).toEqual([]);
      expect(errs.map((line) => JSON.parse(line))).toEqual([
        { event: "error", error: "Could not read e2e test directory: .argent/e2e" },
      ]);
    }
  );

  it.each([
    [["--frobnicate"], "Unknown flag: --frobnicate"],
    [["one", "two"], 'unexpected argument "two"; e2e list takes at most one directory path'],
    [[""], "e2e list requires a non-empty directory path"],
    [["-r"], "e2e list --recursive requires a directory path"],
    [["--recursive"], "e2e list --recursive requires a directory path"],
  ])("rejects `list %s` as a usage error with exit 2", async (args, message) => {
    await expect(flow(["list", ...args], opts)).rejects.toThrow("process.exit:2");
    expect(logs).toEqual([]);
    expect(errs.join("\n")).toBe(`Error: ${message}\nRun \`argent e2e --help\`.`);

    for (const jsonArgs of [
      ["--json", ...args],
      [...args, "--json"],
    ]) {
      errs.length = 0;
      await expect(flow(["list", ...jsonArgs], opts)).rejects.toThrow("process.exit:2");
      expect(logs).toEqual([]);
      expect(errs).toHaveLength(1);
      expect(JSON.parse(errs[0]!)).toEqual({ event: "error", error: message });
    }
  });

  it.each([[["--json", "--help"]], [["-h"]]])("prints the help for `list %s`", async (args) => {
    await flow(["list", ...args], opts);

    expect(logs.join("\n")).toContain("Usage: argent e2e");
    expect(logs.join("\n")).toContain("list [dir] [-r] [--json]");
  });

  describe("list <dir>", () => {
    let listRoot: string;
    let previousCwd: string;
    beforeEach(async () => {
      listRoot = path.join(tempRoot, "list-dir-project");
      const testsDir = path.join(listRoot, "tests", "e2e");
      await fsp.mkdir(path.join(testsDir, "suite"), { recursive: true });
      await fsp.mkdir(path.join(testsDir, "__baselines__"), { recursive: true });
      await fsp.mkdir(path.join(listRoot, ".argent", "e2e"), { recursive: true });
      await fsp.mkdir(path.join(listRoot, ".argent", "flows"), { recursive: true });
      await fsp.mkdir(path.join(listRoot, "empty"), { recursive: true });
      await fsp.mkdir(path.join(listRoot, "nested-only", "sub"), { recursive: true });
      await Promise.all([
        fsp.writeFile(path.join(testsDir, "login.yaml"), "steps: []\n"),
        fsp.writeFile(path.join(testsDir, "suite", "pay.yaml"), "steps: []\n"),
        fsp.writeFile(path.join(testsDir, "notes.yml"), "steps: []\n"),
        fsp.writeFile(path.join(testsDir, "__baselines__", "old.yaml"), "steps: []\n"),
        fsp.writeFile(path.join(listRoot, ".argent", "e2e", "saved.yaml"), "steps: []\n"),
        fsp.writeFile(path.join(listRoot, ".argent", "flows", "login.yaml"), "steps: []\n"),
        fsp.writeFile(path.join(listRoot, "file.yaml"), "steps: []\n"),
        fsp.writeFile(path.join(listRoot, "nested-only", "sub", "a.yaml"), "steps: []\n"),
      ]);
      previousCwd = process.cwd();
      process.chdir(listRoot);
    });
    afterEach(() => {
      process.chdir(previousCwd);
    });

    it("lists only the tests in the directory, relative to the current directory or absolute", async () => {
      await flow(["list", "-r", "tests/e2e"], opts);

      expect(logs.join("\n")).toBe(["tests/e2e/login.yaml", "tests/e2e/suite/pay.yaml"].join("\n"));
      expect(errs).toEqual([]);

      logs.length = 0;
      await flow(["list", "-r", "./tests/e2e"], opts);

      expect(logs.join("\n")).toBe(["tests/e2e/login.yaml", "tests/e2e/suite/pay.yaml"].join("\n"));

      logs.length = 0;
      const absolute = path.join(listRoot, "tests", "e2e");
      await flow(["list", "-r", "--", absolute], opts);

      expect(logs.join("\n")).toBe(
        [path.join(absolute, "login.yaml"), path.join(absolute, "suite", "pay.yaml")].join("\n")
      );
    });

    it("lists only the tests directly in the directory without -r", async () => {
      await flow(["list", "tests/e2e"], opts);

      expect(logs).toEqual(["tests/e2e/login.yaml"]);
      expect(errs).toEqual([]);

      logs.length = 0;
      await flow(["list", "tests/e2e", "--json"], opts);

      expect(JSON.parse(logs.join("\n"))).toEqual({ e2eTests: [{ path: "tests/e2e/login.yaml" }] });
    });

    it.each([
      [["-r", "tests/e2e"]],
      [["tests/e2e", "-r"]],
      [["--recursive", "tests/e2e"]],
      [["tests/e2e", "--recursive"]],
    ])("lists the tests in subdirectories too for `list %s`", async (args) => {
      await flow(["list", ...args], opts);

      expect(logs.join("\n")).toBe(["tests/e2e/login.yaml", "tests/e2e/suite/pay.yaml"].join("\n"));
      expect(errs).toEqual([]);
    });

    it("skips __baselines__, dot-directories and node_modules below the directory, at any depth", async () => {
      await writeSkippedDirsTree(path.join(listRoot, "skips"));

      await flow(["list", "skips", "-r"], opts);

      expect(logs.join("\n")).toBe(["skips/suite/nested.yaml", "skips/top.yaml"].join("\n"));
    });

    it("skips YAML files that are not e2e tests", async () => {
      await writeShapeFixture(path.join(listRoot, "shapes"));

      await flow(["list", "shapes"], opts);

      expect(logs.join("\n")).toBe(
        Object.keys(KEPT_YAMLS)
          .sort()
          .map((name) => path.join("shapes", name))
          .join("\n")
      );
    });

    it("warns about empty files and files with a syntax error, on stderr and under --json", async () => {
      await writeShapeFixture(path.join(listRoot, "shapes"));
      const listed = Object.keys(KEPT_YAMLS)
        .sort()
        .map((name) => path.join("shapes", name));

      await flow(["list", "shapes"], opts);

      expect(logs).toEqual([listed.join("\n")]);
      expect(errs).toEqual([
        "warning: shapes/blank.yaml is empty",
        "warning: shapes/broken.yaml has a YAML syntax error",
        "warning: shapes/empty.yaml is empty",
      ]);

      logs.length = 0;
      errs.length = 0;
      await flow(["list", "shapes", "--json"], opts);

      expect(errs).toEqual([]);
      expect(JSON.parse(logs.join("\n")).e2eTests).toStrictEqual([
        { path: "shapes/blank.yaml", warning: "empty" },
        { path: "shapes/broken.yaml", warning: "syntax-error" },
        { path: "shapes/empty.yaml", warning: "empty" },
        { path: "shapes/header-version.yaml" },
        { path: "shapes/integer-version.yaml" },
        { path: "shapes/newer.yaml" },
        { path: "shapes/null-steps.yaml" },
        { path: "shapes/real.yaml" },
        { path: "shapes/steps-map.yaml" },
        { path: "shapes/zero-steps.yaml" },
      ]);
    });

    it("enters .argent but no other dot-directory, so `list . -r` reaches .argent/e2e and .argent/flows", async () => {
      const root = path.join(tempRoot, "list-dot-project");
      const e2eDir = path.join(root, ".argent", "e2e");
      await fsp.mkdir(path.join(e2eDir, ".cache"), { recursive: true });
      await fsp.mkdir(path.join(e2eDir, "__baselines__"), { recursive: true });
      await fsp.mkdir(path.join(root, ".argent", "flows"), { recursive: true });
      await fsp.mkdir(path.join(root, ".github", "workflows"), { recursive: true });
      await Promise.all([
        fsp.writeFile(path.join(e2eDir, "saved.yaml"), "steps: []\n"),
        fsp.writeFile(path.join(e2eDir, ".cache", "t.yaml"), "steps: []\n"),
        fsp.writeFile(path.join(e2eDir, "__baselines__", "b.yaml"), "steps: []\n"),
        fsp.writeFile(path.join(root, ".argent", "flows", "login.yaml"), "steps: []\n"),
        fsp.writeFile(path.join(root, ".github", "workflows", "ci.yaml"), "steps: []\n"),
      ]);
      process.chdir(root);

      await flow(["list", ".", "-r"], opts);

      expect(logs.join("\n")).toBe(
        [".argent/e2e/saved.yaml", ".argent/flows/login.yaml"].join("\n")
      );
    });

    it("lists the tests in a nested .argent/e2e", async () => {
      const nested = path.join(listRoot, "packages", "app", ".argent", "e2e");
      await fsp.mkdir(nested, { recursive: true });
      await fsp.writeFile(path.join(nested, "smoke.yaml"), "steps: []\n");

      await flow(["list", "packages", "-r"], opts);

      expect(logs).toEqual(["packages/app/.argent/e2e/smoke.yaml"]);
    });

    it.each(SKIPPED_DIRS)("lists a directory named %s when it is the one passed", async (dir) => {
      await writeSkippedDirsTree(path.join(listRoot, "skips"));

      await flow(["list", path.join("skips", dir)], opts);

      expect(logs).toEqual([path.join("skips", dir, "sneaky.yaml")]);
    });

    it.each([[["./-dash"]], [["--", "-dash"]]])(
      "prints a path that starts with a dash as ./ for `list %s`",
      async (args) => {
        await fsp.mkdir(path.join(listRoot, "-dash"), { recursive: true });
        await fsp.writeFile(path.join(listRoot, "-dash", "d.yaml"), "steps: []\n");

        await flow(["list", ...args], opts);

        expect(logs).toEqual(["./-dash/d.yaml"]);
      }
    );

    it.skipIf(!canDenyRead)("rejects an unreadable directory with exit 2", async () => {
      const locked = path.join(listRoot, "locked");
      await fsp.mkdir(locked, { recursive: true });
      await fsp.chmod(locked, 0o000);
      try {
        await expect(flow(["list", "locked"], opts)).rejects.toThrow("process.exit:2");
      } finally {
        await fsp.chmod(locked, 0o755);
      }
      expect(logs).toEqual([]);
      expect(errs).toEqual(["Could not read e2e test directory: locked"]);
    });

    it.each([[["--json", "-r", "tests/e2e"]], [["tests/e2e", "--json", "--recursive"]]])(
      "prints only the path of each entry for `list %s`",
      async (args) => {
        await flow(["list", ...args], opts);

        expect(errs).toEqual([]);
        expect(JSON.parse(logs.join("\n"))).toEqual({
          e2eTests: [{ path: "tests/e2e/login.yaml" }, { path: "tests/e2e/suite/pay.yaml" }],
        });
      }
    );

    it("reports an empty directory on stderr, keeps stdout empty and exits 0", async () => {
      await flow(["list", "empty", "-r"], opts);
      expect(logs).toEqual([]);
      expect(errs).toEqual(["No e2e tests found in empty"]);

      errs.length = 0;
      await flow(["list", "empty", "-r", "--json"], opts);
      expect(JSON.parse(logs.join("\n"))).toEqual({ e2eTests: [] });
      expect(errs).toEqual([]);
    });

    it("suggests -r when the directory holds tests only in subdirectories", async () => {
      await flow(["list", "nested-only"], opts);
      expect(logs).toEqual([]);
      expect(errs).toEqual([
        "No e2e tests found in nested-only\nPass -r/--recursive to include subdirectories.",
      ]);

      errs.length = 0;
      await flow(["list", "nested-only", "--json"], opts);
      expect(JSON.parse(logs.join("\n"))).toEqual({ e2eTests: [] });
      expect(errs).toEqual([]);

      logs.length = 0;
      await flow(["list", "nested-only", "-r"], opts);
      expect(logs).toEqual(["nested-only/sub/a.yaml"]);
      expect(errs).toEqual([]);
    });

    it.each([
      ["missing", "E2E test directory not found: missing"],
      ["file.yaml", "E2E test path is not a directory: file.yaml"],
      [
        "tests/../tests/e2e",
        'E2E test directory must not contain ".." segments - they are collapsed without following symlinks, so the path can name a different directory than the one your shell opens: tests/../tests/e2e\nPass the fully resolved path to the directory.',
      ],
    ])("rejects `list %s` with exit 2", async (dir, message) => {
      await expect(flow(["list", dir], opts)).rejects.toThrow("process.exit:2");
      expect(logs).toEqual([]);
      expect(errs).toEqual([message]);

      errs.length = 0;
      await expect(flow(["list", "--json", dir], opts)).rejects.toThrow("process.exit:2");
      expect(logs).toEqual([]);
      expect(errs).toHaveLength(1);
      expect(JSON.parse(errs[0]!)).toEqual({ event: "error", error: message });
    });
  });

  it.skipIf(!canDenyRead).each([
    [".argent/e2e", ".argent/e2e"],
    [".argent/flows", ".argent/flows"],
    ["the .argent directory", ".argent"],
  ])("fails when %s cannot be read instead of calling it absent", async (_, locked) => {
    const listRoot = path.join(tempRoot, `list-unreadable-${locked.replace(/\W/g, "")}`);
    for (const dir of [".argent/e2e", ".argent/flows"]) {
      await fsp.mkdir(path.join(listRoot, dir), { recursive: true });
      await fsp.writeFile(path.join(listRoot, dir, "checkout.yaml"), "steps: []\n");
    }
    const lockedDir = path.join(listRoot, locked);
    await fsp.chmod(lockedDir, 0o000);
    const previousCwd = process.cwd();
    try {
      process.chdir(listRoot);
      await expect(flow(["list"], opts)).rejects.toThrow("process.exit:2");
    } finally {
      process.chdir(previousCwd);
      // Restore before afterAll's rm walks the tree (see there).
      await fsp.chmod(lockedDir, 0o700);
    }

    const first = locked === ".argent/flows" ? ".argent/flows" : ".argent/e2e";
    expect(errs).toEqual([`Could not read e2e test directory: ${first}`]);
    expect(logs).toEqual([]);
  });

  it("treats an e2e test directory path that is a file as absent, as `run <name>` does", async () => {
    const listRoot = path.join(tempRoot, "list-notdir-project");
    await fsp.mkdir(path.join(listRoot, ".argent", "flows"), { recursive: true });
    await fsp.writeFile(path.join(listRoot, ".argent", "e2e"), "not a directory\n");
    await fsp.writeFile(path.join(listRoot, ".argent", "flows", "checkout.yaml"), "steps: []\n");
    const previousCwd = process.cwd();
    try {
      process.chdir(listRoot);
      await flow(["list"], opts);
    } finally {
      process.chdir(previousCwd);
    }

    expect(logs).toEqual([".argent/flows/checkout.yaml"]);
    expect(errs).toEqual([
      "note: 1 test listed from .argent/flows (legacy); move it to .argent/e2e",
    ]);
  });

  describe("list with suite.config.yaml", () => {
    let root: string;
    let previousCwd: string;
    beforeEach(async () => {
      root = await fsp.mkdtemp(path.join(tempRoot, "list-suite-"));
      previousCwd = process.cwd();
      process.chdir(root);
    });
    afterEach(() => {
      process.chdir(previousCwd);
    });

    async function writeTree(files: Record<string, string>): Promise<void> {
      for (const [rel, text] of Object.entries(files)) {
        await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
        await fsp.writeFile(path.join(root, rel), text);
      }
    }

    async function listBoth(args: string[]): Promise<{
      stdout: string[];
      stderr: string[];
      json: string[];
      jsonStderr: string[];
    }> {
      await expect(flow(["list", ...args], opts)).resolves.toBeUndefined();
      const plain = { stdout: [...logs], stderr: [...errs] };
      logs.length = 0;
      errs.length = 0;
      await expect(flow(["list", ...args, "--json"], opts)).resolves.toBeUndefined();
      const out = { ...plain, json: [...logs], jsonStderr: [...errs] };
      logs.length = 0;
      errs.length = 0;
      return out;
    }

    const e2eTestsOf = (json: string[]): unknown => JSON.parse(json.join("\n")).e2eTests;

    it("lists a suite in the run order of a directory run, with its directory as suite", async () => {
      await writeTree({
        ".argent/e2e/a.yaml": "steps: []\n",
        ".argent/e2e/posts/suite.config.yaml": "tests:\n  - delete\n  - add\n",
        ".argent/e2e/posts/add.yaml": "steps: []\n",
        ".argent/e2e/posts/b/x.yaml": "steps: []\n",
        ".argent/e2e/posts/delete.yaml": "steps: []\n",
        ".argent/e2e/z.yaml": "steps: []\n",
      });

      const out = await listBoth([]);

      const order = [
        ".argent/e2e/a.yaml",
        ".argent/e2e/posts/delete.yaml",
        ".argent/e2e/posts/add.yaml",
        ".argent/e2e/posts/b/x.yaml",
        ".argent/e2e/z.yaml",
      ];
      expect(out.stdout).toEqual([order.join("\n")]);
      expect(out.stderr).toEqual([]);
      expect(out.jsonStderr).toEqual([]);
      expect(e2eTestsOf(out.json)).toStrictEqual([
        { path: ".argent/e2e/a.yaml", name: "a", legacy: false },
        { path: ".argent/e2e/posts/delete.yaml", legacy: false, suite: ".argent/e2e/posts" },
        { path: ".argent/e2e/posts/add.yaml", legacy: false, suite: ".argent/e2e/posts" },
        { path: ".argent/e2e/posts/b/x.yaml", legacy: false },
        { path: ".argent/e2e/z.yaml", name: "z", legacy: false },
      ]);

      await expect(flow(["run", ".argent/e2e", "--recursive"], opts)).rejects.toThrow(
        "process.exit:0"
      );
      const ran = toolsClientMock.callTool.mock.calls.map(
        (c) => (c[1] as { e2e_test_path: string }).e2e_test_path
      );
      expect(ran.map((p) => path.relative(process.cwd(), p))).toEqual(order);
    });

    it("lists a suite without tests in file name order", async () => {
      await writeTree({
        "tests/posts/suite.config.yaml": "continueOnFailure: true\n",
        "tests/posts/b.yaml": "steps: []\n",
        "tests/posts/a.yaml": "steps: []\n",
      });

      const out = await listBoth(["tests", "-r"]);

      expect(out.stdout).toEqual(["tests/posts/a.yaml\ntests/posts/b.yaml"]);
      expect(out.stderr).toEqual([]);
      expect(out.jsonStderr).toEqual([]);
      expect(e2eTestsOf(out.json)).toStrictEqual([
        { path: "tests/posts/a.yaml", suite: "tests/posts" },
        { path: "tests/posts/b.yaml", suite: "tests/posts" },
      ]);
    });

    it("leaves the tests of an invalid suite off stdout, warns on stderr and exits 0", async () => {
      await writeTree({
        "tests/a.yaml": "steps: []\n",
        "tests/posts/suite.config.yaml": "bogus: 1\n",
        "tests/posts/add.yaml": "steps: []\n",
        "tests/posts/delete.yaml": "",
        "tests/z.yaml": "steps: []\n",
      });

      const out = await listBoth(["tests", "-r"]);

      expect(out.stdout).toEqual(["tests/a.yaml\ntests/z.yaml"]);
      expect(out.stderr).toEqual([
        'warning: tests/posts/suite.config.yaml: unknown key "bogus"; the allowed keys are tests and continueOnFailure',
        "  not listed: tests/posts/add.yaml",
        "  not listed: tests/posts/delete.yaml",
      ]);
      expect(out.jsonStderr).toEqual([]);
      expect(e2eTestsOf(out.json)).toStrictEqual([
        { path: "tests/a.yaml" },
        { path: "tests/posts/add.yaml", suite: "tests/posts", warning: "invalid-suite-config" },
        { path: "tests/posts/delete.yaml", suite: "tests/posts", warning: "invalid-suite-config" },
        { path: "tests/z.yaml" },
      ]);
    });

    it("leaves a file that tests does not name off stdout and keeps it under --json after its suite", async () => {
      await writeTree({
        "tests/posts/suite.config.yaml": "tests:\n  - zed\n  - add\n",
        "tests/posts/add.yaml": "steps: []\n",
        "tests/posts/draft.yaml": "",
        "tests/posts/zed.yaml": "steps: []\n",
        "tests/z.yaml": "steps: []\n",
      });

      const out = await listBoth(["tests", "-r"]);

      expect(out.stdout).toEqual(["tests/posts/zed.yaml\ntests/posts/add.yaml\ntests/z.yaml"]);
      expect(out.stderr).toEqual([
        "warning: tests/posts/draft.yaml is not listed in the tests of tests/posts/suite.config.yaml and does not run",
      ]);
      expect(out.jsonStderr).toEqual([]);
      expect(e2eTestsOf(out.json)).toStrictEqual([
        { path: "tests/posts/zed.yaml", suite: "tests/posts" },
        { path: "tests/posts/add.yaml", suite: "tests/posts" },
        { path: "tests/posts/draft.yaml", suite: "tests/posts", warning: "not-in-suite" },
        { path: "tests/z.yaml" },
      ]);
    });

    it("prints only the warnings when every test is left out", async () => {
      await writeTree({
        "tests/suite.config.yaml": "tests: []\n",
        "tests/a.yaml": "steps: []\n",
      });

      const out = await listBoth(["tests"]);

      expect(out.stdout).toEqual([]);
      expect(out.stderr).toEqual([
        "warning: tests/suite.config.yaml: tests must be a non-empty list of test names",
        "  not listed: tests/a.yaml",
      ]);
      expect(e2eTestsOf(out.json)).toStrictEqual([
        { path: "tests/a.yaml", suite: "tests", warning: "invalid-suite-config" },
      ]);
    });

    it("warns about a suite that names a test gone from a directory with no test", async () => {
      await writeTree({
        "tests/posts/suite.config.yaml": "tests:\n  - checkout\n",
        "tests/smoke.yaml": "steps: []\n",
      });

      const out = await listBoth(["tests", "-r"]);

      expect(out.stdout).toEqual(["tests/smoke.yaml"]);
      expect(out.stderr).toEqual([
        'warning: tests/posts/suite.config.yaml: tests entry "checkout" names no e2e test in this directory',
      ]);
      expect(out.jsonStderr).toEqual([]);
      expect(e2eTestsOf(out.json)).toStrictEqual([
        {
          path: "tests/posts/suite.config.yaml",
          suite: "tests/posts",
          warning: "invalid-suite-config",
        },
        { path: "tests/smoke.yaml" },
      ]);
    });

    it("warns about an invalid suite config in .argent/e2e that has no test", async () => {
      await writeTree({ ".argent/e2e/posts/suite.config.yaml": "bogus: 1\n" });

      const out = await listBoth([]);

      expect(out.stdout).toEqual([]);
      expect(out.stderr).toEqual([
        'warning: .argent/e2e/posts/suite.config.yaml: unknown key "bogus"; the allowed keys are tests and continueOnFailure',
      ]);
      expect(e2eTestsOf(out.json)).toStrictEqual([
        {
          path: ".argent/e2e/posts/suite.config.yaml",
          legacy: false,
          suite: ".argent/e2e/posts",
          warning: "invalid-suite-config",
        },
      ]);
    });

    it.each([
      { label: "relative", dir: "own", shown: "own" },
      { label: "relative with a trailing slash", dir: "own/", shown: "own" },
      { label: "starting with a dash", dir: "./-own", shown: "./-own" },
    ])("gives suite the form of path for a $label dir", async ({ dir, shown }) => {
      const base = dir.replace(/^\.\//, "").replace(/\/$/, "");
      await writeTree({
        [`${base}/suite.config.yaml`]: "",
        [`${base}/a.yaml`]: "steps: []\n",
        [`${base}/sub/suite.config.yaml`]: "",
        [`${base}/sub/b.yaml`]: "steps: []\n",
      });

      const out = await listBoth([dir, "-r"]);

      expect(e2eTestsOf(out.json)).toStrictEqual([
        { path: `${shown}/a.yaml`, suite: shown },
        { path: `${shown}/sub/b.yaml`, suite: `${shown}/sub` },
      ]);
    });

    it("gives suite an absolute path for an absolute dir", async () => {
      await writeTree({
        "own/suite.config.yaml": "",
        "own/sub/suite.config.yaml": "",
        "own/a.yaml": "steps: []\n",
        "own/sub/b.yaml": "steps: []\n",
      });
      const absolute = path.join(root, "own");

      const out = await listBoth([absolute, "-r"]);

      expect(out.stdout).toEqual([
        [path.join(absolute, "a.yaml"), path.join(absolute, "sub", "b.yaml")].join("\n"),
      ]);
      expect(e2eTestsOf(out.json)).toStrictEqual([
        { path: path.join(absolute, "a.yaml"), suite: absolute },
        { path: path.join(absolute, "sub", "b.yaml"), suite: path.join(absolute, "sub") },
      ]);
    });

    it("keeps a nested suite separate from its parent suite", async () => {
      await writeTree({
        "tests/posts/suite.config.yaml": "",
        "tests/posts/x.yaml": "steps: []\n",
        "tests/posts/other/c.yaml": "steps: []\n",
        "tests/posts/sub/suite.config.yaml": "tests:\n  - b\n  - a\n",
        "tests/posts/sub/a.yaml": "steps: []\n",
        "tests/posts/sub/b.yaml": "steps: []\n",
      });

      const out = await listBoth(["tests", "-r"]);

      expect(out.stdout).toEqual([
        [
          "tests/posts/other/c.yaml",
          "tests/posts/sub/b.yaml",
          "tests/posts/sub/a.yaml",
          "tests/posts/x.yaml",
        ].join("\n"),
      ]);
      expect(e2eTestsOf(out.json)).toStrictEqual([
        { path: "tests/posts/other/c.yaml" },
        { path: "tests/posts/sub/b.yaml", suite: "tests/posts/sub" },
        { path: "tests/posts/sub/a.yaml", suite: "tests/posts/sub" },
        { path: "tests/posts/x.yaml", suite: "tests/posts" },
      ]);
    });

    it("follows a suite in .argent/flows and counts only the listed tests as legacy", async () => {
      await writeTree({
        ".argent/e2e/x.yaml": "steps: []\n",
        ".argent/flows/posts/suite.config.yaml": "tests:\n  - b\n  - a\n",
        ".argent/flows/posts/a.yaml": "steps: []\n",
        ".argent/flows/posts/b.yaml": "steps: []\n",
        ".argent/flows/posts/c.yaml": "steps: []\n",
      });

      const out = await listBoth([]);

      expect(out.stdout).toEqual([
        [".argent/e2e/x.yaml", ".argent/flows/posts/b.yaml", ".argent/flows/posts/a.yaml"].join(
          "\n"
        ),
      ]);
      expect(out.stderr).toEqual([
        "warning: .argent/flows/posts/c.yaml is not listed in the tests of .argent/flows/posts/suite.config.yaml and does not run",
        "note: 2 tests listed from .argent/flows (legacy); move them to .argent/e2e",
      ]);
      expect(out.jsonStderr).toEqual([]);
      expect(e2eTestsOf(out.json)).toStrictEqual([
        { path: ".argent/e2e/x.yaml", name: "x", legacy: false },
        { path: ".argent/flows/posts/b.yaml", legacy: true, suite: ".argent/flows/posts" },
        { path: ".argent/flows/posts/a.yaml", legacy: true, suite: ".argent/flows/posts" },
        {
          path: ".argent/flows/posts/c.yaml",
          legacy: true,
          suite: ".argent/flows/posts",
          warning: "not-in-suite",
        },
      ]);
    });

    it("shadows a legacy test by a test that tests does not name, since run by name ignores the suite", async () => {
      await writeTree({
        ".argent/e2e/suite.config.yaml": "tests:\n  - a\n",
        ".argent/e2e/a.yaml": "steps: []\n",
        ".argent/e2e/b.yaml": "steps: []\n",
        ".argent/flows/b.yaml": "steps: []\n",
      });

      const out = await listBoth([]);

      expect(out.stdout).toEqual([".argent/e2e/a.yaml\n.argent/flows/b.yaml"]);
      expect(out.stderr).toEqual([
        "warning: .argent/e2e/b.yaml is not listed in the tests of .argent/e2e/suite.config.yaml and does not run",
        "warning: .argent/flows/b.yaml is shadowed by .argent/e2e/b.yaml when run by name",
        "note: 1 test listed from .argent/flows (legacy); move it to .argent/e2e",
      ]);
      expect(out.jsonStderr).toEqual([]);
      expect(e2eTestsOf(out.json)).toStrictEqual([
        { path: ".argent/e2e/a.yaml", name: "a", legacy: false, suite: ".argent/e2e" },
        {
          path: ".argent/e2e/b.yaml",
          name: "b",
          legacy: false,
          suite: ".argent/e2e",
          warning: "not-in-suite",
        },
        {
          path: ".argent/flows/b.yaml",
          name: "b",
          legacy: true,
          shadowedBy: ".argent/e2e/b.yaml",
        },
      ]);
    });

    it("keeps the exact output for directories without a suite.config.yaml file", async () => {
      await writeTree({
        ".argent/e2e/b.yaml": "steps: []\n",
        ".argent/e2e/a.yaml": "",
        ".argent/e2e/posts/x.yaml": "steps: []\n",
        ".argent/flows/b.yaml": "steps: []\n",
      });

      const out = await listBoth([]);

      expect(out.stdout).toEqual([
        [
          ".argent/e2e/a.yaml",
          ".argent/e2e/b.yaml",
          ".argent/e2e/posts/x.yaml",
          ".argent/flows/b.yaml",
        ].join("\n"),
      ]);
      expect(out.stderr).toEqual([
        "warning: .argent/e2e/a.yaml is empty",
        "warning: .argent/flows/b.yaml is shadowed by .argent/e2e/b.yaml when run by name",
        "note: 1 test listed from .argent/flows (legacy); move it to .argent/e2e",
      ]);
      expect(out.jsonStderr).toEqual([]);
      expect(out.json).toEqual([
        JSON.stringify(
          {
            e2eTests: [
              { path: ".argent/e2e/a.yaml", name: "a", legacy: false, warning: "empty" },
              { path: ".argent/e2e/b.yaml", name: "b", legacy: false },
              { path: ".argent/e2e/posts/x.yaml", legacy: false },
              {
                path: ".argent/flows/b.yaml",
                name: "b",
                legacy: true,
                shadowedBy: ".argent/e2e/b.yaml",
              },
            ],
          },
          null,
          2
        ),
      ]);
    });
  });

  it("renders the report — echo lines unnumbered, real steps numbered, reasons and fragment tags shown — and exits 1 on failure", async () => {
    toolsClientMock.callTool.mockResolvedValue({
      data: report({
        executionPrerequisite: "App on the login screen",
        ok: false,
        passed: 1,
        failed: 1,
        skipped: 1,
        steps: [
          { index: 0, kind: "echo", status: "pass", message: "Opening settings" },
          { index: 1, kind: "tap", status: "pass" },
          { index: 2, kind: "assert", status: "fail", reason: "never visible", flow: "login" },
          { index: 3, kind: "tool", tool: "screenshot", status: "skip" },
        ],
      }),
    });

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:1");

    const out = logs.join("\n");
    expect(out).toContain('E2E test "checkout" on SIM-1');
    expect(out).toContain("assumes: App on the login screen");
    // Echo is narration — no index; numbering starts at the first real step.
    expect(out).toContain("› Opening settings");
    expect(out).toMatch(/✓ {2}1 tap/);
    expect(out).toMatch(/✗ {2}2 assert \[login\] — never visible/);
    expect(out).toMatch(/· {2}3 tool screenshot/);
    expect(out).toContain("FAIL — 1 passed, 1 failed, 0 errored, 1 skipped");
  });

  it("names each baseline a run could not write in its recap", async () => {
    toolsClientMock.callTool.mockResolvedValue({
      data: report({
        ok: false,
        baselineWrites: ["/p/a.png", { path: "/p/b.png", error: "EACCES: permission denied" }],
      }),
    });

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:1");
    const lines = logs.join("\n").split("\n");
    expect(lines.slice(-4)).toEqual([
      "  ✗ baselines not written",
      "    /p/b.png: EACCES: permission denied",
      "",
      "FAIL — 1 passed, 0 failed, 0 errored, 0 skipped",
    ]);
  });

  it("names an unwritten baseline under the failing step of a run that also failed a step", async () => {
    toolsClientMock.callTool.mockResolvedValue({
      data: report({
        ok: false,
        passed: 0,
        failed: 1,
        steps: [{ index: 0, kind: "tap", status: "fail", reason: "no element" }],
        baselineWrites: [{ path: "/p/b.png", error: "EACCES: permission denied" }],
      }),
    });

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:1");
    const lines = logs.join("\n").split("\n");
    expect(lines.slice(-5)).toEqual([
      "  ✗ step 1 tap",
      "    no element",
      "    baseline not written: /p/b.png: EACCES: permission denied",
      "",
      "FAIL — 0 passed, 1 failed, 0 errored, 0 skipped",
    ]);
  });

  it("renders legacy warnings with the ⚠ glyph and counts them in the summary", async () => {
    toolsClientMock.callTool.mockResolvedValue({
      data: report({
        steps: [{ index: 0, kind: "snapshot", status: "pass", warning: "no baseline; adopted" }],
      }),
    });

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:0");

    const out = logs.join("\n");
    expect(out).toMatch(/⚠ {2}1 snapshot/);
    expect(out).toContain("⚠ no baseline; adopted");
    expect(out).toContain("1 warning");
  });

  it("prints the raw report with --json", async () => {
    await expect(flow(["run", checkoutPath, "--json"], opts)).rejects.toThrow("process.exit:0");
    expect(JSON.parse(logs.join("\n"))).toEqual(report());
  });

  it("prints each progress step followed by one final result with --json-stream", async () => {
    let finish!: () => void;
    const finalGate = new Promise<void>((resolve) => (finish = resolve));
    const step = { index: 0, kind: "tap", status: "pass" };
    const finalReport = report({ steps: [step] });
    toolsClientMock.callTool.mockImplementation(
      async (
        _name: string,
        _payload: unknown,
        options?: { onProgress?: (event: unknown) => void }
      ) => {
        options?.onProgress?.(step);
        await finalGate;
        return { data: finalReport };
      }
    );

    const running = flow(["run", checkoutPath, "--json-stream"], opts);
    await vi.waitFor(() => {
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0]!)).toEqual({ event: "progress", data: step });
    });
    finish();
    await expect(running).rejects.toThrow("process.exit:0");

    const records = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toEqual([
      { event: "progress", data: step },
      { event: "result", data: finalReport },
    ]);
    expect(errs).toEqual([]);
  });

  it("prints one final result and exits 1 for a failed report with --json-stream", async () => {
    const failedReport = report({
      ok: false,
      passed: 0,
      failed: 1,
      steps: [{ index: 0, kind: "assert", status: "fail", reason: "not visible" }],
    });
    toolsClientMock.callTool.mockResolvedValue({ data: failedReport });

    await expect(flow(["run", checkoutPath, "--json-stream"], opts)).rejects.toThrow(
      "process.exit:1"
    );

    expect(logs.map((line) => JSON.parse(line))).toEqual([{ event: "result", data: failedReport }]);
  });

  it("prints a structured error on stdout and diagnostics on stderr with --json-stream", async () => {
    toolsClientMock.callTool.mockRejectedValue(
      new ToolInvocationError("invalid flow", {
        errorCode: "FLOW_FILE_INVALID",
        errorKind: "validation",
      })
    );

    await expect(flow(["run", checkoutPath, "--json-stream"], opts)).rejects.toThrow(
      "process.exit:1"
    );

    expect(logs.map((line) => JSON.parse(line))).toEqual([
      {
        event: "error",
        error: "invalid flow",
        error_code: "FLOW_FILE_INVALID",
        error_kind: "validation",
      },
    ]);
    expect(errs).toEqual(["invalid flow"]);
  });

  it("prints a JSON error object on stderr when the server rejects the flow under --json", async () => {
    // --json owns stdout for the report alone, so a run with no report leaves
    // it empty and carries the same record --json-stream would, on stderr.
    toolsClientMock.callTool.mockRejectedValue(
      new ToolInvocationError("invalid flow", {
        errorCode: "FLOW_FILE_INVALID",
        errorKind: "validation",
      })
    );

    await expect(flow(["run", checkoutPath, "--json"], opts)).rejects.toThrow("process.exit:1");

    expect(logs).toEqual([]);
    expect(errs).toHaveLength(1);
    expect(JSON.parse(errs[0]!)).toEqual({
      event: "error",
      error: "invalid flow",
      error_code: "FLOW_FILE_INVALID",
      error_kind: "validation",
    });
  });

  it("rejects --json with --json-stream without writing human text to stdout", async () => {
    await expect(flow(["run", checkoutPath, "--json", "--json-stream"], opts)).rejects.toThrow(
      "process.exit:2"
    );

    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    expect(logs.map((line) => JSON.parse(line))).toEqual([
      { event: "error", error: "--json and --json-stream cannot be combined" },
    ]);
    expect(errs.join("\n")).toContain("--json and --json-stream cannot be combined");
    expect(errs.join("\n")).toContain("Usage: argent e2e");
  });

  it("keeps help off stdout after --json-stream selects machine mode", async () => {
    await flow(["run", checkoutPath, "--json-stream", "--help"], opts);

    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
    expect(errs.join("\n")).toContain("Usage: argent e2e");
    expect(errs.join("\n")).toContain("--json-stream");
  });

  it("emits a structured error for a pre-flight refusal in streaming mode", async () => {
    const missing = path.join(path.dirname(checkoutPath), "missing.yaml");
    await expect(flow(["run", missing, "--json-stream"], opts)).rejects.toThrow("process.exit:2");

    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    expect(logs.map((line) => JSON.parse(line))).toEqual([
      { event: "error", error: expect.stringContaining(`E2E test file not found: ${missing}`) },
    ]);
  });

  it("emits a structured error and exits 2 when artifact export fails in streaming mode", async () => {
    toolsClientMock.callTool.mockResolvedValue({ data: report() });
    toolsClientMock.baseUrl.mockRejectedValueOnce(new Error("tool server unreachable"));

    await expect(
      flow(["run", checkoutPath, "--json-stream", "--output", path.join(tempRoot, "out")], opts)
    ).rejects.toThrow("process.exit:2");

    expect(logs.map((line) => JSON.parse(line))).toEqual([
      { event: "error", error: "tool server unreachable" },
    ]);
    expect(errs).toEqual(["tool server unreachable"]);
  });

  it("emits a structured error for a primitive non-report in streaming mode", async () => {
    toolsClientMock.callTool.mockResolvedValue({ data: "not-a-report" });

    await expect(flow(["run", checkoutPath, "--json-stream"], opts)).rejects.toThrow(
      "process.exit:2"
    );

    expect(logs.map((line) => JSON.parse(line))).toEqual([
      { event: "error", error: '"checkout" did not produce a run report.' },
    ]);
    expect(errs.join("\n")).toContain('"checkout" did not produce a run report.');
  });

  it("renders failed-snapshot handles as server paths without fetching when --output is absent", async () => {
    toolsClientMock.callTool.mockResolvedValue({
      data: report({
        ok: false,
        passed: 0,
        failed: 1,
        steps: [
          {
            index: 0,
            kind: "snapshot",
            status: "fail",
            reason: "1.2% differs",
            snapshotKey: "home__ios-390x844",
            artifacts: {
              baseline: handle("/srv/base.png"),
              current: handle("/srv/cur.png"),
              diff: handle("/srv/diff.png"),
            },
          },
        ],
      }),
    });

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:1");

    // Nothing to download: paths come straight off the handles, and the
    // server URL is never even resolved.
    expect(materializeArtifactsMock).not.toHaveBeenCalled();
    expect(toolsClientMock.baseUrl).not.toHaveBeenCalled();
    const out = logs.join("\n");
    expect(out).toContain("baseline: /srv/base.png");
    expect(out).toContain("current: /srv/cur.png");
    expect(out).toContain("diff: /srv/diff.png");
  });

  it("never materializes tool-step results (the CLI renders no images)", async () => {
    toolsClientMock.callTool.mockResolvedValue({
      data: report({
        steps: [
          {
            index: 0,
            kind: "tool",
            tool: "screenshot",
            status: "pass",
            result: { image: handle("/srv/shot.png") },
          },
        ],
      }),
    });

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:0");

    expect(materializeArtifactsMock).not.toHaveBeenCalled();
    const out = logs.join("\n");
    expect(out).toMatch(/✓ {2}1 tool screenshot/);
    expect(out).toContain("PASS — 1 passed");
  });

  it("materializes only the failed snapshot's artifacts when --output is set", async () => {
    const failedArtifacts = { baseline: handle("/srv/base.png") };
    toolsClientMock.callTool.mockResolvedValue({
      data: report({
        ok: false,
        failed: 1,
        steps: [
          {
            index: 0,
            kind: "tool",
            tool: "screenshot",
            status: "pass",
            result: { image: handle("/srv/shot.png") },
          },
          {
            index: 1,
            kind: "snapshot",
            status: "fail",
            snapshotKey: "home__ios-390x844",
            artifacts: failedArtifacts,
          },
        ],
      }),
    });

    await expect(flow(["run", checkoutPath, "--output", "flow-artifacts"], opts)).rejects.toThrow(
      "process.exit:1"
    );

    // One materialization, scoped to the failed snapshot's artifacts object —
    // not the whole report (which would pull the tool-step screenshot too).
    expect(toolsClientMock.baseUrl).toHaveBeenCalledTimes(1);
    expect(materializeArtifactsMock).toHaveBeenCalledTimes(1);
    expect(materializeArtifactsMock).toHaveBeenCalledWith(failedArtifacts, {
      toolsUrl: "http://127.0.0.1:4141",
      authToken: "tok",
    });
  });

  it("emits string artifact paths in --json without --output (hostPath, or filename)", async () => {
    toolsClientMock.callTool.mockResolvedValue({
      data: report({
        ok: false,
        passed: 0,
        failed: 1,
        steps: [
          {
            index: 0,
            kind: "snapshot",
            status: "fail",
            snapshotKey: "home__ios-390x844",
            artifacts: { baseline: handle("/srv/base.png"), diff: handle() },
          },
        ],
      }),
    });

    await expect(flow(["run", checkoutPath, "--json"], opts)).rejects.toThrow("process.exit:1");

    expect(materializeArtifactsMock).not.toHaveBeenCalled();
    const parsed = JSON.parse(logs.join("\n")) as {
      steps: { artifacts?: Record<string, unknown> }[];
    };
    // Strings, not handle objects: hostPath when present, filename otherwise.
    expect(parsed.steps[0]?.artifacts).toEqual({ baseline: "/srv/base.png", diff: "art.png" });
  });

  it("prints legacy string artifact paths as-is (pre-handle tool-server)", async () => {
    toolsClientMock.callTool.mockResolvedValue({
      data: report({
        ok: false,
        passed: 0,
        failed: 1,
        steps: [
          {
            index: 0,
            kind: "snapshot",
            status: "fail",
            artifacts: { baseline: "/tmp/snaps/home.png", diff: "/tmp/snaps/home-diff.png" },
          },
        ],
      }),
    });

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:1");

    expect(materializeArtifactsMock).not.toHaveBeenCalled();
    const out = logs.join("\n");
    expect(out).toContain("baseline: /tmp/snaps/home.png");
    expect(out).toContain("diff: /tmp/snaps/home-diff.png");
  });

  it("exits 1 with the error message when the tool call fails", async () => {
    toolsClientMock.callTool.mockRejectedValue(new Error("tool-server unreachable"));

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:1");
    expect(errs.join("\n")).toContain("tool-server unreachable");
  });

  // A routed tool-server that refuses the connection ran nothing, so the run
  // is a setup error (exit 2) that names the address and where it came from,
  // not undici's bare "fetch failed".
  it("reports a routed tool-server that refuses the connection as unreachable", async () => {
    getResolvedToolsUrlMock.mockResolvedValue({ url: "http://127.0.0.1:47899", source: "env" });
    toolsClientMock.callTool.mockRejectedValue(connectRefused());

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:2");

    expect(logs).toEqual(['E2E test "checkout"', "  ✗ not run (tool-server unreachable)"]);
    expect(errs).toEqual([UNREACHABLE_ENV_MESSAGE]);
  });

  it.each([
    [
      "a link",
      { url: "http://10.0.0.5:4141", source: "link" },
      "ENOTFOUND",
      "Could not reach the tool-server at http://10.0.0.5:4141 (set by argent link): host not found.\n" +
        "Start the tool-server on the linked machine, or run `argent unlink`.",
    ],
    [
      "ARGENT_TOOLS_URL over a link",
      {
        url: "http://127.0.0.1:47899",
        source: "env",
        shadowedLink: {
          url: "http://10.0.0.5:4141",
          host: "10.0.0.5",
          port: 4141,
          createdAt: "2026-10-01T00:00:00.000Z",
        },
      },
      "UND_ERR_CONNECT_TIMEOUT",
      "Could not reach the tool-server at http://127.0.0.1:47899 (set by ARGENT_TOOLS_URL): timed out.\n" +
        "Start that tool-server, or unset ARGENT_TOOLS_URL and run `argent unlink` to use the local one. " +
        "A link to http://10.0.0.5:4141 is also configured and takes over once the env var is unset.",
    ],
  ] as const)(
    "names where the unreachable address came from for %s",
    async (_case, routing, code, message) => {
      getResolvedToolsUrlMock.mockResolvedValue(routing);
      toolsClientMock.callTool.mockRejectedValue(
        new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) })
      );

      await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:2");

      expect(errs).toEqual([message]);
    }
  );

  it("writes an unreachable tool-server as a record a script can branch on under --json", async () => {
    getResolvedToolsUrlMock.mockResolvedValue({ url: "http://127.0.0.1:47899", source: "env" });
    toolsClientMock.callTool.mockRejectedValue(connectRefused());

    await expect(flow(["run", checkoutPath, "--json"], opts)).rejects.toThrow("process.exit:2");

    expect(logs).toEqual([]);
    expect(errs.map((line) => JSON.parse(line))).toEqual([
      {
        event: "error",
        error: UNREACHABLE_ENV_MESSAGE,
        error_code: "TOOL_SERVER_UNREACHABLE",
        error_kind: "network",
      },
    ]);
  });

  it("ends the stream on an unreachable tool-server with the same record under --json-stream", async () => {
    getResolvedToolsUrlMock.mockResolvedValue({ url: "http://127.0.0.1:47899", source: "env" });
    toolsClientMock.callTool.mockRejectedValue(connectRefused());

    await expect(flow(["run", checkoutPath, "--json-stream"], opts)).rejects.toThrow(
      "process.exit:2"
    );

    expect(logs.map((line) => JSON.parse(line))).toEqual([
      {
        event: "error",
        error: UNREACHABLE_ENV_MESSAGE,
        error_code: "TOOL_SERVER_UNREACHABLE",
        error_kind: "network",
      },
    ]);
    expect(errs).toEqual([UNREACHABLE_ENV_MESSAGE]);
  });

  // A refused upload ends the call before the tool-server gets the flow, so
  // nothing ran: the flow is rejected with its own verdict and code.
  it("reports a refused fragment upload as a flow that did not run", async () => {
    toolsClientMock.callTool.mockRejectedValue(uploadRefused());

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:1");

    expect(logs).toEqual(['E2E test "checkout"', "  ✗ not run (upload failed)"]);
    expect(errs).toEqual([UPLOAD_REFUSED_MESSAGE]);
  });

  it("writes a refused fragment upload as a record with its code under --json", async () => {
    toolsClientMock.callTool.mockRejectedValue(uploadRefused());

    await expect(flow(["run", checkoutPath, "--json"], opts)).rejects.toThrow("process.exit:1");

    expect(logs).toEqual([]);
    expect(errs.map((line) => JSON.parse(line))).toEqual([
      {
        event: "error",
        error: UPLOAD_REFUSED_MESSAGE,
        error_code: "FILE_INPUT_UPLOAD_FAILED",
        error_kind: "validation",
      },
    ]);
  });

  // Not every refused connect is a missing tool-server: with no routing it is
  // the auto-started local one, and an open socket can end with the same
  // codes after the run started. Both stay run errors, and a failure that is
  // not a connect never reads the routing.
  it.each([
    [
      "a refused connect to the local tool-server",
      { url: null, source: "none" },
      "ECONNREFUSED",
      "connect",
      true,
    ],
    [
      "a timeout on an open socket",
      { url: "http://127.0.0.1:47899", source: "env" },
      "ETIMEDOUT",
      "read",
      false,
    ],
  ] as const)("keeps %s a run error", async (_case, routing, code, syscall, readsRouting) => {
    getResolvedToolsUrlMock.mockResolvedValue(routing);
    toolsClientMock.callTool.mockRejectedValue(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error(`${syscall} ${code}`), { code, syscall }),
      })
    );

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:1");

    expect(logs).toEqual(['E2E test "checkout"', "  ✗ did not finish (run error)"]);
    expect(errs).toEqual(["fetch failed"]);
    expect(getResolvedToolsUrlMock).toHaveBeenCalledTimes(readsRouting ? 1 : 0);
  });

  // fail()'s message-only call sites hand it no error object, and under
  // --json each must still reach stderr as a record, never as prose.
  it("writes a missing flow file as an error record under --json", async () => {
    const missing = path.join(tempRoot, "missing.yaml");

    await expect(flow(["run", missing, "--json"], opts)).rejects.toThrow("process.exit:2");

    expect(logs).toEqual([]);
    expect(errs.map((line) => JSON.parse(line))).toEqual([
      { event: "error", error: `E2E test file not found: ${missing}` },
    ]);
  });

  it("writes a wrong flow extension as an error record under --json", async () => {
    const yml = path.join(tempRoot, "checkout.yml");

    await expect(flow(["run", yml, "--json"], opts)).rejects.toThrow("process.exit:2");

    expect(logs).toEqual([]);
    expect(errs.map((line) => JSON.parse(line))).toEqual([
      { event: "error", error: `E2E test path must end in .yaml: ${yml}` },
    ]);
  });

  it("writes a reply that is not a run report as an error record under --json", async () => {
    toolsClientMock.callTool.mockResolvedValue({ data: { flow: "checkout", notice: "x" } });

    await expect(flow(["run", checkoutPath, "--json"], opts)).rejects.toThrow("process.exit:2");

    expect(logs).toEqual([]);
    expect(errs.map((line) => JSON.parse(line))).toEqual([
      { event: "error", error: '"checkout" did not produce a run report.' },
    ]);
  });

  // Same ledger contract the directory run keeps: stdout alone says how the
  // run ended. Live step lines make the gap worse here than in a batch — the
  // last thing an archived log shows is a passing step, so a run that died
  // reads as one that succeeded and got truncated.
  it("gives a run that dies mid-stream a verdict under its step lines", async () => {
    toolsClientMock.callTool.mockImplementationOnce(
      async (
        _tool: string,
        _payload: unknown,
        callOpts?: { onProgress?: (e: unknown) => void }
      ) => {
        callOpts?.onProgress?.({ index: 0, kind: "tap", status: "pass" });
        throw new Error("tool-server unreachable");
      }
    );

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:1");

    expect(logs.join("\n").split("\n")).toEqual([
      'E2E test "checkout"',
      expect.stringMatching(/^ {2}✓ {2}1 tap/),
      "  ✗ did not finish (run error)",
    ]);
  });

  it("names the flow before the verdict when the run failed before any step", async () => {
    toolsClientMock.callTool.mockRejectedValue(new Error("tool-server unreachable"));

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:1");

    expect(logs.join("\n").split("\n")).toEqual([
      'E2E test "checkout"',
      "  ✗ did not finish (run error)",
    ]);
  });

  // A failure the server did NOT scope to this call: the run died, so it reads
  // as one that did not finish, never as a rejection. Two signals reach here —
  // a kind other than validation, and the absent kind a pre-signal server sends.
  it.each([
    ["marks as something other than validation", { errorKind: "subprocess" }],
    ["leaves unset, as a pre-signal server does", {}],
  ])("does not read a server error the signal %s as a rejection", async (_case, signal) => {
    toolsClientMock.callTool.mockRejectedValue(new ToolInvocationError("boot failed", signal));

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:1");

    expect(logs.join("\n").split("\n")).toEqual([
      'E2E test "checkout"',
      "  ✗ did not finish (run error)",
    ]);
  });

  // Shapes the renderers cannot walk, all of which the guard is the only thing
  // turning away. Three reach the CLI's top-level catch as a raw TypeError with
  // stdout left empty — a nullish value on the `steps` read, a non-array
  // `steps` on the first iteration, a nullish element on the first field read
  // off it. The fourth is quieter and worse: a primitive element throws
  // nowhere, so the verdict falls to the value's own `ok`, which the rows below
  // set true: a PASS and an exit 0 on a report the run never got.
  it.each([
    ["a null", null],
    ["an absent", undefined],
    ["a primitive", "flow-execute is not implemented"],
    ["a numeric steps", { flow: "checkout", ok: true, steps: 42 }],
    ["a null steps", { flow: "checkout", ok: true, steps: null }],
    ["an object steps", { flow: "checkout", ok: true, steps: {} }],
    ["a null-element steps", { flow: "checkout", ok: true, steps: [null] }],
    ["a primitive-element steps", { flow: "checkout", ok: true, steps: ["tap"] }],
  ])("treats %s wire value as no report rather than crashing", async (_case, data) => {
    toolsClientMock.callTool.mockResolvedValue({ data });

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:2");
    expect(errs.join("\n")).toContain('"checkout" did not produce a run report');
    expect(logs.join("\n").split("\n")).toEqual([
      'E2E test "checkout"',
      "  ✗ did not finish (no run report)",
    ]);
  });

  // The other side of that guard: an empty step list is what the server sends
  // for a flow with no steps, so it has to stay a report. Reading it as one
  // more unwalkable shape would fail a passing flow — and in a batch, stop it.
  it("counts a report with no steps as a report", async () => {
    toolsClientMock.callTool.mockResolvedValue({
      data: report({ steps: [], passed: 0 }),
    });

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:0");
    expect(logs.join("\n")).toContain("PASS");
    expect(logs.join("\n")).not.toContain("no run report");
  });

  it("gives a report-less run a verdict on stdout", async () => {
    toolsClientMock.callTool.mockResolvedValue({
      data: { flow: "checkout", notice: "prerequisite", executionPrerequisite: "logged in" },
    });

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:2");

    expect(logs.join("\n").split("\n")).toEqual([
      'E2E test "checkout"',
      "  ✗ did not finish (no run report)",
    ]);
  });

  // A server that streamed steps and then answered with something that is not
  // a report has already had the header printed for it by the first event.
  it("does not repeat the header when a streamed run ends without a report", async () => {
    toolsClientMock.callTool.mockImplementationOnce(
      async (
        _tool: string,
        _payload: unknown,
        callOpts?: { onProgress?: (e: unknown) => void }
      ) => {
        callOpts?.onProgress?.({ index: 0, kind: "tap", status: "pass" });
        return { data: { flow: "checkout", notice: "prereq" } };
      }
    );

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:2");

    expect(logs.join("\n").split("\n")).toEqual([
      'E2E test "checkout"',
      expect.stringMatching(/^ {2}✓ {2}1 tap/),
      "  ✗ did not finish (no run report)",
    ]);
  });

  // The wording tells the reader which file to open, so it comes from the
  // failure code — `validation` marks any rejection scoped to one call, device
  // resolution included, and cannot license a claim about the YAML.
  it.each([
    ["FLOW_FILE_INVALID", "not run (invalid e2e test)"],
    ["FLOW_FILE_NEWER_VERSION", "not run (needs a newer Argent)"],
    ["FLOW_DEVICE_RESOLUTION", "not run (no device resolved)"],
    ["FLOW_REQUIREMENTS_UNMET", "not run (requires not met)"],
    ["A_CODE_THIS_CLI_DOES_NOT_MAP", "not run (rejected)"],
  ])("renders a %s rejection of a single flow as %j", async (errorCode, verdict) => {
    toolsClientMock.callTool.mockRejectedValue(
      new ToolInvocationError("rejected", { errorCode, errorKind: "validation" })
    );

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:1");

    expect(logs.join("\n").split("\n")).toEqual(['E2E test "checkout"', `  ✗ ${verdict}`]);
  });

  // The negative control the ledger needs: a verdict marks the runs that
  // earned one, so completeness cannot be met by verdicting everything.
  it("leaves a passing run's stdout free of any failure verdict", async () => {
    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:0");

    expect(logs.join("\n")).not.toContain("✗");
  });

  // A single run's --json is the report itself, so a run that produced none
  // has nothing to print: stdout stays empty rather than gaining the prose
  // verdict, which would be the one thing `| jq` cannot survive.
  it.each([
    ["produces no report", { data: { flow: "checkout", notice: "prereq" } }, "process.exit:2"],
    ["is rejected", new ToolInvocationError("nope", { errorKind: "validation" }), "process.exit:1"],
  ])("prints no prose on stdout under --json when the run %s", async (_case, outcome, exitCode) => {
    if (outcome instanceof Error) toolsClientMock.callTool.mockRejectedValue(outcome);
    else toolsClientMock.callTool.mockResolvedValue(outcome);

    await expect(flow(["run", checkoutPath, "--json"], opts)).rejects.toThrow(exitCode);

    expect(logs).toEqual([]);
  });

  // The --json-stream half of the same guard: streaming owns stdout, and the
  // error record it ends on is the whole account of the failure.
  it.each([
    [
      "is rejected",
      new ToolInvocationError("nope", { errorCode: "FLOW_FILE_INVALID", errorKind: "validation" }),
      "process.exit:1",
      {
        event: "error",
        error: "nope",
        error_code: "FLOW_FILE_INVALID",
        error_kind: "validation",
      },
    ],
    [
      "produces no report",
      { data: { flow: "checkout", notice: "prereq" } },
      "process.exit:2",
      { event: "error", error: '"checkout" did not produce a run report.' },
    ],
  ])(
    "keeps stdout NDJSON-only under --json-stream when the run %s",
    async (_case, outcome, exitCode, record) => {
      if (outcome instanceof Error) toolsClientMock.callTool.mockRejectedValue(outcome);
      else toolsClientMock.callTool.mockResolvedValue(outcome);

      await expect(flow(["run", checkoutPath, "--json-stream"], opts)).rejects.toThrow(exitCode);

      expect(logs.map((line) => JSON.parse(line))).toEqual([record]);
    }
  );

  it("exits 2 on an unknown subcommand", async () => {
    await expect(flow(["frobnicate"], opts)).rejects.toThrow("process.exit:2");
    expect(errs.join("\n")).toContain('Unknown e2e subcommand "frobnicate"');
  });

  it("prints help and returns (no exit) with no subcommand", async () => {
    await flow([], opts);
    expect(logs.join("\n")).toContain("Usage: argent e2e");
    expect(logs.join("\n")).toContain(
      "filename (minus .yaml) names the run's report and artifacts"
    );
    expect(logs.join("\n")).toContain('contain only letters, numbers, "_", or "-"');
    expect(logs.join("\n")).toContain("the one that `argent link` or ARGENT_TOOLS_URL names");
    expect(logs.join("\n")).toContain("--json-stream");
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("prints help instead of running when --help follows the flow name", async () => {
    await flow(["run", "checkout", "--help"], opts);
    expect(logs.join("\n")).toContain("Options (run):");
    expect(logs.join("\n")).toContain(
      "--platform <p>         ios | android | chromium | vega | ios-remote — narrow"
    );
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("prints help instead of running when -h trails other run flags", async () => {
    await flow(["run", "checkout", "--device", "SIM-1", "-h"], opts);
    expect(logs.join("\n")).toContain("Usage: argent e2e");
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });
});

describe("argent e2e run <dir>", () => {
  let tempRoot: string;
  let flowsDir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logs: string[];
  let errs: string[];
  /** Both streams in the order a terminal or a `2>&1` log interleaves them. */
  let merged: ["out" | "err", string][];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  const opts = { paths: {} as never };

  beforeAll(async () => {
    tempRoot = await fsp.mkdtemp(path.join(tmpdir(), "argent-cli-flow-dir-"));
    flowsDir = path.join(tempRoot, "flows");
    // Two runnable top-level flows plus every kind of entry discovery must
    // ignore: wrong extension, unsafe stem, a directory named like a flow,
    // and (non-recursively) anything nested.
    await fsp.mkdir(path.join(flowsDir, "sub"), { recursive: true });
    await fsp.mkdir(path.join(flowsDir, ".hidden"), { recursive: true });
    await fsp.mkdir(path.join(flowsDir, "node_modules"), { recursive: true });
    await fsp.mkdir(path.join(flowsDir, "__baselines__"), { recursive: true });
    await fsp.mkdir(path.join(flowsDir, "sub", "__baselines__"), { recursive: true });
    await fsp.mkdir(path.join(flowsDir, "bundle.yaml"), { recursive: true });
    await Promise.all([
      fsp.writeFile(path.join(flowsDir, "a-login.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "b-checkout.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "notes.yml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "bad name.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "sub", "c-search.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, ".hidden", "hidden.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "node_modules", "dep.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "__baselines__", "base.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "sub", "__baselines__", "base.yaml"), "steps: []\n"),
    ]);
  });

  afterAll(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getResolvedToolsUrlMock.mockResolvedValue({ url: null, source: "none" });
    toolsClientMock.callTool.mockResolvedValue({ data: report() });
    logs = [];
    errs = [];
    merged = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...a) => {
      logs.push(a.join(" "));
      merged.push(["out", a.join(" ")]);
    });
    errSpy = vi.spyOn(console, "error").mockImplementation((...a) => {
      errs.push(a.join(" "));
      merged.push(["err", a.join(" ")]);
    });
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit);
  });

  afterEach(() => {
    vi.useRealTimers();
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("runs each top-level flow in order without live progress and exits 0 when all pass", async () => {
    await expect(flow(["run", flowsDir], opts)).rejects.toThrow("process.exit:0");

    // Only the two safe top-level .yaml files, in lexicographic order, and
    // never with onProgress (batch output is failures-only).
    expect(toolsClientMock.callTool).toHaveBeenCalledTimes(2);
    expect(toolsClientMock.callTool).toHaveBeenNthCalledWith(1, "e2e-execute", {
      e2e_test_path: path.join(flowsDir, "a-login.yaml"),
      project_root: process.cwd(),
      prerequisiteAcknowledged: true,
    });
    expect(toolsClientMock.callTool).toHaveBeenNthCalledWith(2, "e2e-execute", {
      e2e_test_path: path.join(flowsDir, "b-checkout.yaml"),
      project_root: process.cwd(),
      prerequisiteAcknowledged: true,
    });
    const out = logs.join("\n");
    expect(out).toContain("[1/2] a-login.yaml");
    expect(out).toContain("[2/2] b-checkout.yaml");
    expect(out).toContain("PASS (started on SIM-1) — 1 passed, 0 failed, 0 errored, 0 skipped");
    // Passing steps stay silent in batch mode.
    expect(out).not.toMatch(/✓ {2}1 tap/);
    expect(out).not.toContain("Failed e2e tests");
    expect(out).toContain("PASS — 2 e2e tests: 2 passed, 0 failed, 0 skipped");
  });

  it("skips a flow whose requires: excludes the target and runs the rest", async () => {
    toolsClientMock.callTool
      .mockRejectedValueOnce(
        new ToolInvocationError("[Tool:e2e-execute] excludes device SIM-1 (ios)", {
          errorCode: "FLOW_REQUIREMENTS_UNMET",
          errorKind: "validation",
        })
      )
      .mockResolvedValueOnce({ data: report() });

    await expect(flow(["run", flowsDir], opts)).rejects.toThrow("process.exit:0");

    expect(logs).toContain("  · skipped (requires not met)\n    excludes device SIM-1 (ios)");
    expect(logs.at(-1)).toMatch(/^\nPASS — 2 e2e tests: 1 passed, 0 failed, 1 skipped/);
    expect(errs).toEqual([]);
  });

  it("exits 2 with a NONE RAN verdict when requires: skipped every flow", async () => {
    toolsClientMock.callTool.mockRejectedValue(
      new ToolInvocationError("[Tool:e2e-execute] excludes device SIM-1 (ios)", {
        errorCode: "FLOW_REQUIREMENTS_UNMET",
        errorKind: "validation",
      })
    );

    await expect(flow(["run", flowsDir], opts)).rejects.toThrow("process.exit:2");

    expect(logs.at(-1)).toMatch(/^\nNONE RAN — 2 e2e tests: 0 passed, 0 failed, 2 skipped/);
    expect(errs).toEqual([`No e2e test in ${flowsDir} ran on the selected target.`]);
  });

  it("reports a requires: skip with its reason, and ok: false when nothing ran, under --json", async () => {
    toolsClientMock.callTool.mockRejectedValue(
      new ToolInvocationError("[Tool:e2e-execute] excludes device SIM-1 (ios)", {
        errorCode: "FLOW_REQUIREMENTS_UNMET",
        errorKind: "validation",
      })
    );

    await expect(flow(["run", flowsDir, "--json"], opts)).rejects.toThrow("process.exit:2");

    const out = JSON.parse(logs.join("\n"));
    expect(out).toMatchObject({ ok: false, total: 2, skipped: 2 });
    expect(out.e2eTests[0]).toEqual({
      path: "a-login.yaml",
      status: "skip",
      reason: "excludes device SIM-1 (ios)",
    });
  });

  it("ends each flow verdict with its run time and the batch verdict with the batch time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    toolsClientMock.callTool.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 45_000);
      return { data: report({ durationMs: 44_000 }) };
    });

    await expect(flow(["run", flowsDir], opts)).rejects.toThrow("process.exit:0");

    expect(logs).toContain(
      "  PASS (started on SIM-1) — 1 passed, 0 failed, 0 errored, 0 skipped (44.0s)"
    );
    expect(logs.at(-1)).toBe("\nPASS — 2 e2e tests: 2 passed, 0 failed, 0 skipped (1m 30s)");
  });

  it("prints a passing script's output, the only record a green batch run leaves", async () => {
    toolsClientMock.callTool.mockResolvedValue({
      data: report({
        steps: [
          {
            index: 0,
            kind: "script",
            status: "pass",
            target: "scripts/seed.mjs",
            scriptLog: "seeded order 4711\n",
          },
          { index: 1, kind: "tap", status: "pass" },
        ],
        passed: 2,
      }),
    });

    await expect(flow(["run", flowsDir], opts)).rejects.toThrow("process.exit:0");

    const out = logs.join("\n");
    expect(out).toContain("✓  1 script scripts/seed.mjs");
    expect(out).toContain("│ seeded order 4711");
    // The widened gate still admits only the script step, not its neighbour.
    expect(out).not.toMatch(/✓ {2}2 tap/);
  });

  it("rejects directory runs with --json-stream", async () => {
    await expect(flow(["run", flowsDir, "--json-stream"], opts)).rejects.toThrow("process.exit:2");

    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    expect(logs.map((line) => JSON.parse(line))).toEqual([
      {
        event: "error",
        error: "--json-stream supports a single e2e test; directory runs are not supported.",
      },
    ]);
    expect(errs.join("\n")).toContain(
      "--json-stream supports a single e2e test; directory runs are not supported"
    );
  });

  it("rejects a misspelled --platform before running any flow in the batch", async () => {
    await expect(flow(["run", flowsDir, "--platform", "iOS"], opts)).rejects.toThrow(
      "process.exit:2"
    );

    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    expect(errs.join("\n")).toContain(
      '--platform must be "ios", "android", "chromium", "vega", "macos" or "ios-remote", got "iOS"'
    );
  });

  it("rejects a misspelled --platform under --json with one error record and no aggregate", async () => {
    await expect(flow(["run", flowsDir, "--platform", "iOS", "--json"], opts)).rejects.toThrow(
      "process.exit:2"
    );

    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
    expect(errs.join("\n").split("\n")).toHaveLength(1);
    expect(JSON.parse(errs[0]!)).toEqual({
      event: "error",
      error:
        '--platform must be "ios", "android", "chromium", "vega", "macos" or "ios-remote", got "iOS"',
    });
  });

  it("forwards run flags to every flow in the batch", async () => {
    await expect(
      flow(["run", flowsDir, "--device", "SIM-1", "--platform", "ios", "--update-baselines"], opts)
    ).rejects.toThrow("process.exit:0");

    for (const call of toolsClientMock.callTool.mock.calls) {
      expect(call[1]).toMatchObject({ device: "SIM-1", platform: "ios", updateBaselines: true });
    }
  });

  it("continues after a failed flow, printing only its failing steps, and exits 1", async () => {
    toolsClientMock.callTool
      .mockResolvedValueOnce({
        data: report({
          flow: "a-login",
          ok: false,
          passed: 1,
          failed: 1,
          steps: [
            { index: 0, kind: "tap", status: "pass" },
            { index: 1, kind: "assert", status: "fail", reason: "never visible" },
          ],
        }),
      })
      .mockResolvedValueOnce({ data: report({ flow: "b-checkout" }) });

    await expect(flow(["run", flowsDir], opts)).rejects.toThrow("process.exit:1");

    expect(toolsClientMock.callTool).toHaveBeenCalledTimes(2);
    const out = logs.join("\n");
    // The failing step keeps its full-report number; the passing tap is silent.
    expect(out).toMatch(/✗ {2}2 assert — never visible/);
    expect(out).not.toMatch(/✓ {2}1 tap/);
    expect(out).toContain("FAIL (started on SIM-1) — 1 passed, 1 failed, 0 errored, 0 skipped");
    expect(out).toContain("FAIL — 2 e2e tests: 1 passed, 1 failed, 0 skipped");
  });

  it("stops the batch on a tool-call throw and counts the remaining flows skipped", async () => {
    toolsClientMock.callTool
      .mockResolvedValueOnce({ data: report({ flow: "a-login" }) })
      .mockRejectedValueOnce(new Error("tool-server unreachable"));

    await expect(flow(["run", flowsDir, "-r"], opts)).rejects.toThrow("process.exit:1");

    expect(toolsClientMock.callTool).toHaveBeenCalledTimes(2);
    expect(errs.join("\n")).toContain("tool-server unreachable");
    const out = logs.join("\n");
    expect(out).toContain(`[3/3] ${path.join("sub", "c-search.yaml")}`);
    expect(out).toContain("· not run (batch stopped)");
    expect(out).toContain("FAIL — 3 e2e tests: 1 passed, 1 failed, 1 skipped");
  });

  it("continues past a flow the tool-server rejects as invalid", async () => {
    toolsClientMock.callTool
      .mockRejectedValueOnce(
        new ToolInvocationError("flow file is not valid YAML", {
          errorCode: "FLOW_FILE_INVALID",
          errorKind: "validation",
        })
      )
      .mockResolvedValueOnce({ data: report({ flow: "b-checkout" }) });

    await expect(flow(["run", flowsDir], opts)).rejects.toThrow("process.exit:1");

    // A validation rejection is specific to that flow file — the batch ran on.
    expect(toolsClientMock.callTool).toHaveBeenCalledTimes(2);
    expect(errs.join("\n")).toContain("flow file is not valid YAML");
    const out = logs.join("\n");
    expect(out).not.toContain("not run (batch stopped)");
    expect(out).toContain("FAIL — 2 e2e tests: 1 passed, 1 failed, 0 skipped");
  });

  it("gives a rejected flow a verdict on stdout, not just a message on stderr", async () => {
    toolsClientMock.callTool
      .mockRejectedValueOnce(
        new ToolInvocationError("flow file is not valid YAML", {
          errorCode: "FLOW_FILE_INVALID",
          errorKind: "validation",
        })
      )
      .mockResolvedValueOnce({ data: report({ flow: "b-checkout" }) });

    await expect(flow(["run", flowsDir], opts)).rejects.toThrow("process.exit:1");

    const lines = logs.join("\n").split("\n");
    // stdout on its own is a complete ledger: each flow's outcome sits directly
    // under its `[i/n]` header. Without one, a redirected stdout log shows this
    // flow's header immediately followed by the next flow's — an entry that
    // reads as though it never ran, while the tally still counts a failure and
    // names no flow. Matched exactly: an indented line under a header is as
    // likely to be a failing step as an outcome.
    expect(lines[lines.indexOf("[1/2] a-login.yaml") + 1]).toBe("  ✗ not run (invalid e2e test)");
    expect(lines[lines.indexOf("[2/2] b-checkout.yaml") + 1]).toMatch(/^ {2}PASS /);
    // Only the flow that earned a verdict carries one, so the completeness
    // above is not met by verdicting everything. The count discriminates only
    // because the other flow passes cleanly: renderStepLine gives a failed step
    // the same `  ✗ ` prefix, which no count tells apart from a verdict.
    const perFlow = lines.slice(0, lines.indexOf("Failed e2e tests (1)"));
    expect(perFlow.filter((l) => l.startsWith("  ✗ "))).toHaveLength(1);
  });

  // One merged ledger: both runners print the verdict under the header and the
  // stderr detail after it, so `2>&1` on a batch reads like `2>&1` on one run.
  // Both branches that write to the two streams, since only one of them throws.
  it.each([
    [
      "is rejected",
      new ToolInvocationError("flow file is not valid YAML", {
        errorCode: "FLOW_FILE_INVALID",
        errorKind: "validation",
      }),
      "  ✗ not run (invalid e2e test)",
      "flow file is not valid YAML",
    ],
    [
      "answers without a report",
      { data: { flow: "a-login", notice: "prerequisite" } },
      "  ✗ did not finish (no run report)",
      '"a-login.yaml" did not produce a run report.',
    ],
  ])(
    "prints the verdict of a flow that %s ahead of the stderr detail",
    async (_case, outcome, verdict, detail) => {
      if (outcome instanceof Error) toolsClientMock.callTool.mockRejectedValueOnce(outcome);
      else toolsClientMock.callTool.mockResolvedValueOnce(outcome);

      await expect(flow(["run", flowsDir], opts)).rejects.toThrow("process.exit:1");

      expect(merged.slice(0, 3)).toEqual([
        ["out", "[1/2] a-login.yaml"],
        ["out", verdict],
        ["err", detail],
      ]);
    }
  );

  // The batch continuing past a rejection is the point of the feature, so the
  // entry that proves the verdict travels with the flow is a later one.
  it("gives a rejected flow that is not the first its own verdict", async () => {
    toolsClientMock.callTool
      .mockResolvedValueOnce({ data: report({ flow: "a-login" }) })
      .mockRejectedValueOnce(
        new ToolInvocationError("flow file is not valid YAML", {
          errorCode: "FLOW_FILE_INVALID",
          errorKind: "validation",
        })
      );

    await expect(flow(["run", flowsDir], opts)).rejects.toThrow("process.exit:1");

    const lines = logs.join("\n").split("\n");
    expect(lines[lines.indexOf("[2/2] b-checkout.yaml") + 1]).toBe(
      "  ✗ not run (invalid e2e test)"
    );
  });

  // `validation` is the wire signal for every rejection the server means for
  // one call, not a statement about the YAML — device resolution rejects that
  // way too, and a batch run with nothing booted would otherwise report every
  // flow file as broken.
  it.each([
    ["FLOW_FILE_INVALID", "not run (invalid e2e test)"],
    ["FLOW_ENTRY_UNRECOGNIZED", "not run (invalid e2e test)"],
    ["FLOW_E2E_HAS_PREREQUISITE", "not run (invalid e2e test)"],
    ["FLOW_FILE_NEWER_VERSION", "not run (needs a newer Argent)"],
    ["FLOW_DEVICE_RESOLUTION", "not run (no device resolved)"],
    ["A_CODE_THIS_CLI_DOES_NOT_MAP", "not run (rejected)"],
  ])("renders a %s rejection as %j", async (errorCode, verdict) => {
    toolsClientMock.callTool
      .mockRejectedValueOnce(
        new ToolInvocationError("rejected", { errorCode, errorKind: "validation" })
      )
      .mockResolvedValueOnce({ data: report({ flow: "b-checkout" }) });

    await expect(flow(["run", flowsDir], opts)).rejects.toThrow("process.exit:1");

    const lines = logs.join("\n").split("\n");
    expect(lines).toContain(`  ✗ ${verdict}`);
    // The batch's only ✗ above the recap. It counts because the other flow
    // passes cleanly: a failing step line carries the same prefix.
    const recap = lines.indexOf("Failed e2e tests (1)");
    expect(lines.slice(0, recap).filter((l) => l.startsWith("  ✗ "))).toHaveLength(1);
    expect(lines).toContain(`  ✗ a-login.yaml › ${verdict}`);
  });

  it("gives a report-less flow its own stdout verdict", async () => {
    toolsClientMock.callTool.mockResolvedValueOnce({
      data: { flow: "a-login", notice: "prerequisite" },
    });

    await expect(flow(["run", flowsDir], opts)).rejects.toThrow("process.exit:1");

    expect(logs.join("\n").split("\n")).toContain("  ✗ did not finish (no run report)");
  });

  // The aggregate is what a CI job reads for a batch, so the classification the
  // verdict is chosen from reaches it as data, under the names --json-stream
  // publishes. Without the two fields both rows below are one `status: "fail"`
  // with the same key set and a message assembled per failure.
  it.each([
    ["a rejection", { errorCode: "FLOW_DEVICE_RESOLUTION", errorKind: "validation" }],
    ["an infra failure", { errorCode: "CHROMIUM_ELECTRON_SPAWN_FAILED", errorKind: "subprocess" }],
  ])("carries the failure signal of %s into the --json aggregate", async (_case, signal) => {
    toolsClientMock.callTool.mockRejectedValueOnce(new ToolInvocationError("nope", signal));

    await expect(flow(["run", flowsDir, "--json"], opts)).rejects.toThrow("process.exit:1");

    // One document: the verdict is prose, and --json owns stdout.
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]).flows[0]).toEqual({
      path: "a-login.yaml",
      status: "fail",
      error: "nope",
      error_code: signal.errorCode,
      error_kind: signal.errorKind,
    });
  });

  it("names a baseline a flow could not write on its own line and in the recap", async () => {
    toolsClientMock.callTool.mockResolvedValueOnce({
      data: report({
        ok: false,
        baselineWrites: [{ path: "/p/b.png", error: "EACCES: permission denied" }],
      }),
    });

    await expect(flow(["run", flowsDir], opts)).rejects.toThrow("process.exit:1");
    const lines = logs.join("\n").split("\n");
    expect(
      lines.slice(lines.indexOf("[1/2] a-login.yaml"), lines.indexOf("[2/2] b-checkout.yaml"))
    ).toEqual([
      "[1/2] a-login.yaml",
      "  FAIL (started on SIM-1) — 1 passed, 0 failed, 0 errored, 0 skipped",
    ]);
    const recap = lines.indexOf("Failed e2e tests (1)");
    expect(lines.slice(recap + 2, recap + 4)).toEqual([
      "  ✗ a-login.yaml › baselines not written",
      "    /p/b.png: EACCES: permission denied",
    ]);
  });

  it("keeps --json a single document when a flow returns no report", async () => {
    toolsClientMock.callTool.mockResolvedValueOnce({
      data: { flow: "a-login", notice: "prerequisite" },
    });

    await expect(flow(["run", flowsDir, "--json"], opts)).rejects.toThrow("process.exit:1");

    expect(logs).toHaveLength(1);
    const aggregate = JSON.parse(logs[0]) as { flows: unknown[] };
    expect(aggregate).toMatchObject({ ok: false, failed: 1, skipped: 1 });
    // No failure signal on this one: nothing threw, so there is none to carry.
    expect(aggregate.flows[0]).toEqual({
      path: "a-login.yaml",
      status: "fail",
      error: '"a-login.yaml" did not produce a run report.',
    });
    expect(errs.map((line) => JSON.parse(line))).toEqual([
      { event: "error", error: '"a-login.yaml" did not produce a run report.' },
    ]);
  });

  it("writes a rejected flow's message on stderr as a record under --json", async () => {
    const message =
      "This flow is not self-contained, and it arrived as an upload. The steps below read or " +
      "write project files, which stay on the client:\n" +
      "  - step 1: run: frag.yaml\n" +
      "Run the flow on the computer that runs the tool-server, with no link and no " +
      "ARGENT_TOOLS_URL, so that the tool-server reads the files in place.";
    toolsClientMock.callTool
      .mockRejectedValueOnce(
        new ToolInvocationError(message, {
          errorCode: "FLOW_FILE_INVALID",
          errorKind: "validation",
        })
      )
      .mockResolvedValueOnce({ data: report({ flow: "b-checkout" }) });

    await expect(flow(["run", flowsDir, "--json"], opts)).rejects.toThrow("process.exit:1");

    expect(JSON.parse(logs.join("\n"))).toMatchObject({ ok: false, passed: 1, failed: 1 });
    // Every stderr line parses: the multi-line prose arrives escaped inside one record.
    const lines = errs.join("\n").split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        event: "error",
        error: message,
        error_code: "FLOW_FILE_INVALID",
        error_kind: "validation",
      },
    ]);
  });

  // A report the renderers cannot walk costs the batch twice over: the throw
  // lands past the try, so the flow gets no verdict AND the run ends with no
  // batch summary and no tally — the whole ledger, not one line of it. The
  // primitive-entry row is the shape that does not throw at all, and would
  // otherwise be counted a pass.
  it.each([
    ["are not a list", { flow: "a-login", ok: true, steps: 42 }],
    ["hold a null entry", { flow: "a-login", ok: true, steps: [null] }],
    ["hold a primitive entry", { flow: "a-login", ok: true, steps: ["tap"] }],
  ])("treats a flow whose steps %s as one that produced no report", async (_case, data) => {
    toolsClientMock.callTool.mockResolvedValueOnce({ data });

    await expect(flow(["run", flowsDir], opts)).rejects.toThrow("process.exit:1");

    const lines = logs.join("\n").split("\n");
    expect(lines[lines.indexOf("[1/2] a-login.yaml") + 1]).toBe(
      "  ✗ did not finish (no run report)"
    );
    expect(logs.join("\n")).toContain("FAIL — 2 e2e tests: 0 passed, 1 failed, 1 skipped");
  });

  // Two signals leave a rejection unscoped to the one call - a kind other than
  // validation, and the absent kind a pre-signal server sends. Each stops the
  // batch, so the verdict is the run's rather than a rejection's.
  it.each([
    ["marks as something other than validation", { errorKind: "subprocess" }],
    ["leaves unset, as a pre-signal server does", {}],
  ])("stops the batch on a server error the signal %s", async (_case, signal) => {
    toolsClientMock.callTool.mockRejectedValueOnce(
      new ToolInvocationError("simulator boot failed", signal)
    );

    await expect(flow(["run", flowsDir], opts)).rejects.toThrow("process.exit:1");

    expect(toolsClientMock.callTool).toHaveBeenCalledTimes(1);
    const lines = logs.join("\n").split("\n");
    expect(lines[lines.indexOf("[1/2] a-login.yaml") + 1]).toBe("  ✗ did not finish (run error)");
    expect(logs.join("\n")).toContain("FAIL — 2 e2e tests: 0 passed, 1 failed, 1 skipped");
  });

  it("stops at the first flow when the routed tool-server is unreachable, exiting 2", async () => {
    getResolvedToolsUrlMock.mockResolvedValue({ url: "http://127.0.0.1:47899", source: "env" });
    toolsClientMock.callTool.mockRejectedValue(connectRefused());

    await expect(flow(["run", flowsDir], opts)).rejects.toThrow("process.exit:2");

    expect(toolsClientMock.callTool).toHaveBeenCalledTimes(1);
    expect(errs).toEqual([UNREACHABLE_ENV_MESSAGE]);
    const lines = logs.join("\n").split("\n");
    expect(lines[lines.indexOf("[1/2] a-login.yaml") + 1]).toBe(
      "  ✗ not run (tool-server unreachable)"
    );
    expect(lines[lines.indexOf("[2/2] b-checkout.yaml") + 1]).toBe("  · not run (batch stopped)");
    const recap = lines.slice(lines.indexOf("Failed e2e tests (1)"));
    expect(recap).toContain("  ✗ a-login.yaml › not run (tool-server unreachable)");
    for (const line of UNREACHABLE_ENV_MESSAGE.split("\n")) expect(recap).toContain(`    ${line}`);
    expect(lines.at(-1)).toMatch(/^FAIL — 2 e2e tests: 0 passed, 1 failed, 1 skipped /);
  });

  it("carries an unreachable tool-server into the --json aggregate and stderr record", async () => {
    getResolvedToolsUrlMock.mockResolvedValue({ url: "http://127.0.0.1:47899", source: "env" });
    toolsClientMock.callTool.mockRejectedValue(connectRefused());

    await expect(flow(["run", flowsDir, "--json"], opts)).rejects.toThrow("process.exit:2");

    const signal = { error_code: "TOOL_SERVER_UNREACHABLE", error_kind: "network" };
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      ok: false,
      failed: 1,
      skipped: 1,
      flows: [
        { path: "a-login.yaml", status: "fail", error: UNREACHABLE_ENV_MESSAGE, ...signal },
        { path: "b-checkout.yaml", status: "skip" },
      ],
    });
    expect(errs.map((line) => JSON.parse(line))).toEqual([
      { event: "error", error: UNREACHABLE_ENV_MESSAGE, ...signal },
    ]);
  });

  // A refused upload depends on the size of that flow's own fragments. Each
  // later flow sends its own files, so the batch goes on.
  it("continues past a flow whose fragment upload is refused", async () => {
    toolsClientMock.callTool
      .mockRejectedValueOnce(uploadRefused())
      .mockResolvedValueOnce({ data: report({ flow: "b-checkout" }) });

    await expect(flow(["run", flowsDir], opts)).rejects.toThrow("process.exit:1");

    expect(toolsClientMock.callTool).toHaveBeenCalledTimes(2);
    expect(errs).toEqual([UPLOAD_REFUSED_MESSAGE]);
    const lines = logs.join("\n").split("\n");
    expect(lines[lines.indexOf("[1/2] a-login.yaml") + 1]).toBe("  ✗ not run (upload failed)");
    expect(lines[lines.indexOf("[2/2] b-checkout.yaml") + 1]).toMatch(/^ {2}PASS /);
    expect(lines).toContain("  ✗ a-login.yaml › not run (upload failed)");
    expect(lines.at(-1)).toMatch(/^FAIL — 2 e2e tests: 1 passed, 1 failed, 0 skipped /);
  });

  it("carries a refused fragment upload into the --json aggregate and runs the next flow", async () => {
    toolsClientMock.callTool
      .mockRejectedValueOnce(uploadRefused())
      .mockResolvedValueOnce({ data: report({ flow: "b-checkout" }) });

    await expect(flow(["run", flowsDir, "--json"], opts)).rejects.toThrow("process.exit:1");

    const signal = { error_code: "FILE_INPUT_UPLOAD_FAILED", error_kind: "validation" };
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      ok: false,
      passed: 1,
      failed: 1,
      skipped: 0,
      flows: [
        { path: "a-login.yaml", status: "fail", error: UPLOAD_REFUSED_MESSAGE, ...signal },
        { path: "b-checkout.yaml", status: "pass" },
      ],
    });
    expect(errs.map((line) => JSON.parse(line))).toEqual([
      { event: "error", error: UPLOAD_REFUSED_MESSAGE, ...signal },
    ]);
  });

  it("treats a non-report result as a failure that stops the batch", async () => {
    toolsClientMock.callTool.mockResolvedValueOnce({
      data: { flow: "a-login", notice: "prerequisite" },
    });

    await expect(flow(["run", flowsDir], opts)).rejects.toThrow("process.exit:1");

    expect(toolsClientMock.callTool).toHaveBeenCalledTimes(1);
    expect(errs.join("\n")).toContain('"a-login.yaml" did not produce a run report');
    expect(logs.join("\n")).toContain("FAIL — 2 e2e tests: 0 passed, 1 failed, 1 skipped");
  });

  it("ends a failed batch with the failed flows, each with a command that runs it alone", async () => {
    toolsClientMock.callTool
      .mockResolvedValueOnce({
        data: report({
          flow: "a-login",
          ok: false,
          passed: 1,
          failed: 1,
          steps: [
            { index: 0, kind: "echo", status: "pass", message: "logging in" },
            { index: 1, kind: "tap", status: "pass" },
            {
              index: 2,
              kind: "assert",
              status: "fail",
              target: 'visible "Home"',
              reason: 'no element matched selector text="Home"',
            },
          ],
        }),
      })
      .mockResolvedValueOnce({ data: report({ flow: "b-checkout" }) });
    vi.useFakeTimers({ toFake: ["Date"] });
    const previousCwd = process.cwd();
    try {
      process.chdir(tempRoot);
      await expect(flow(["run", "./flows", "--platform", "ios"], opts)).rejects.toThrow(
        "process.exit:1"
      );
    } finally {
      process.chdir(previousCwd);
    }

    // The recap follows the last flow's block and precedes the batch verdict,
    // which stays the last line, so `tail -1` still reads it.
    const lines = logs.join("\n").split("\n");
    expect(lines.slice(lines.indexOf("[2/2] b-checkout.yaml"))).toEqual([
      "[2/2] b-checkout.yaml",
      "  PASS (started on SIM-1) — 1 passed, 0 failed, 0 errored, 0 skipped",
      "",
      "Failed e2e tests (1)",
      "",
      '  ✗ a-login.yaml › step 2 assert visible "Home"',
      '    no element matched selector text="Home"',
      `    re-run: argent e2e run ${path.join("flows", "a-login.yaml")} --platform ios`,
      "",
      "FAIL — 2 e2e tests: 1 passed, 1 failed, 0 skipped (0.0s)",
    ]);
  });

  it("forwards --env to e2e-execute and repeats it, quoted, in the re-run line", async () => {
    const suiteDir = path.join(tempRoot, "env-suite");
    await fsp.mkdir(suiteDir, { recursive: true });
    await fsp.writeFile(path.join(suiteDir, "one.yaml"), "steps: []\n");
    toolsClientMock.callTool.mockRejectedValueOnce(new Error("tool stream ended"));

    await expect(
      flow(["run", suiteDir, "--env", "MODE=fast", "--env", "KEY={{secret:API_KEY}}"], opts)
    ).rejects.toThrow("process.exit:1");

    expect(toolsClientMock.callTool.mock.calls[0]![1]).toMatchObject({
      env: { MODE: "fast", KEY: "{{secret:API_KEY}}" },
    });
    expect(logs.join("\n")).toContain(
      `    re-run: argent e2e run ${path.join(suiteDir, "one.yaml")} --env MODE=fast --env 'KEY={{secret:API_KEY}}'`
    );
  });

  it("re-runs a flow outside the working directory by its absolute path, quoted", async () => {
    const suiteDir = path.join(tempRoot, "night suite");
    await fsp.mkdir(suiteDir, { recursive: true });
    await fsp.writeFile(path.join(suiteDir, "one.yaml"), "steps: []\n");
    toolsClientMock.callTool.mockRejectedValueOnce(new Error("tool stream ended"));

    await expect(flow(["run", suiteDir, "--device", "SIM-1"], opts)).rejects.toThrow(
      "process.exit:1"
    );

    expect(logs.join("\n")).toContain(
      `    re-run: argent e2e run '${path.join(suiteDir, "one.yaml")}' --device SIM-1`
    );
  });

  it("re-runs a flow whose name starts with a dash through ./, not as an option", async () => {
    const suiteDir = path.join(tempRoot, "dash-suite");
    await fsp.mkdir(suiteDir, { recursive: true });
    await fsp.writeFile(path.join(suiteDir, "-nightly.yaml"), "steps: []\n");
    toolsClientMock.callTool.mockResolvedValueOnce({
      data: report({ flow: "-nightly", ok: false, steps: [] }),
    });
    const previousCwd = process.cwd();
    try {
      process.chdir(suiteDir);
      await expect(flow(["run", "."], opts)).rejects.toThrow("process.exit:1");
    } finally {
      process.chdir(previousCwd);
    }

    const shown = `.${path.sep}-nightly.yaml`;
    const lines = logs.join("\n").split("\n");
    expect(lines).toContain("  ✗ -nightly.yaml › failed with no failing step");
    expect(lines).toContain(`    re-run: argent e2e run ${shown}`);
    expect(parseRunArgs([shown]).flowRef).toBe(shown);
  });

  it("quotes a path that starts with =, which zsh would expand to a command's path", async () => {
    const suiteDir = path.join(tempRoot, "=nightly");
    await fsp.mkdir(suiteDir, { recursive: true });
    await fsp.writeFile(path.join(suiteDir, "a-login.yaml"), "steps: []\n");
    toolsClientMock.callTool.mockResolvedValueOnce({
      data: report({ flow: "a-login", ok: false, steps: [] }),
    });
    const previousCwd = process.cwd();
    try {
      process.chdir(tempRoot);
      await expect(flow(["run", "=nightly", "--output", "=out"], opts)).rejects.toThrow(
        "process.exit:1"
      );
    } finally {
      process.chdir(previousCwd);
    }

    expect(logs.join("\n").split("\n")).toContain(
      `    re-run: argent e2e run '${path.join("=nightly", "a-login.yaml")}' --output '=out'`
    );
  });

  it("re-runs with the batch's --update-baselines, exporting where the batch exported", async () => {
    toolsClientMock.callTool
      .mockResolvedValueOnce({ data: report({ flow: "a-login", ok: false, steps: [] }) })
      .mockResolvedValueOnce({ data: report({ flow: "b-checkout" }) })
      .mockResolvedValueOnce({ data: report({ flow: "c-search", ok: false, steps: [] }) });
    const previousCwd = process.cwd();
    try {
      process.chdir(tempRoot);
      await expect(
        flow(["run", "./flows", "-r", "--update-baselines", "--output", "out"], opts)
      ).rejects.toThrow("process.exit:1");
    } finally {
      process.chdir(previousCwd);
    }

    const lines = logs.join("\n").split("\n");
    expect(lines).toContain(
      `    re-run: argent e2e run ${path.join("flows", "a-login.yaml")} --update-baselines --output out`
    );
    expect(lines).toContain(
      `    re-run: argent e2e run ${path.join("flows", "sub", "c-search.yaml")} --update-baselines --output ${path.join("out", "sub")}`
    );
  });

  it("re-runs with an --output that starts with a dash through ./, not as an option", async () => {
    toolsClientMock.callTool.mockResolvedValueOnce({
      data: report({ flow: "a-login", ok: false, steps: [] }),
    });

    await expect(flow(["run", flowsDir, "--output=-out"], opts)).rejects.toThrow("process.exit:1");

    const shown = `.${path.sep}-out`;
    expect(logs.join("\n")).toContain(
      `    re-run: argent e2e run ${path.join(flowsDir, "a-login.yaml")} --output ${shown}`
    );
    expect(parseRunArgs(["a-login.yaml", "--output", shown]).output).toBe(shown);
  });

  it("repeats a rejected flow's server message in the recap, as it went to stderr", async () => {
    toolsClientMock.callTool
      .mockResolvedValueOnce({ data: report({ flow: "a-login" }) })
      .mockRejectedValueOnce(
        new ToolInvocationError("flow file is not valid YAML: bad indentation (line 4)", {
          errorCode: "FLOW_FILE_INVALID",
          errorKind: "validation",
        })
      );

    await expect(flow(["run", flowsDir], opts)).rejects.toThrow("process.exit:1");

    expect(errs).toContain("flow file is not valid YAML: bad indentation (line 4)");
    const lines = logs.join("\n").split("\n");
    const entry = lines.indexOf("  ✗ b-checkout.yaml › not run (invalid e2e test)");
    expect(lines.slice(entry + 1, entry + 3)).toEqual([
      "    flow file is not valid YAML: bad indentation (line 4)",
      `    re-run: argent e2e run ${path.join(flowsDir, "b-checkout.yaml")}`,
    ]);
  });

  it("lists the flow that stopped the batch, but not the flows it never reached", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    toolsClientMock.callTool.mockRejectedValueOnce(new Error("tool stream ended without a result"));

    await expect(flow(["run", flowsDir, "-r"], opts)).rejects.toThrow("process.exit:1");

    const lines = logs.join("\n").split("\n");
    const recap = lines.slice(lines.indexOf("Failed e2e tests (1)"));
    expect(recap).toEqual([
      "Failed e2e tests (1)",
      "",
      "  ✗ a-login.yaml › did not finish (run error)",
      "    tool stream ended without a result",
      `    re-run: argent e2e run ${path.join(flowsDir, "a-login.yaml")}`,
      "",
      "FAIL — 3 e2e tests: 0 passed, 1 failed, 2 skipped (0.0s)",
    ]);
  });

  it("lists every failed flow in run order", async () => {
    toolsClientMock.callTool
      .mockResolvedValueOnce({
        data: report({
          flow: "a-login",
          ok: false,
          passed: 0,
          failed: 1,
          steps: [{ index: 0, kind: "tap", status: "fail", reason: "gone" }],
        }),
      })
      .mockResolvedValueOnce({ data: report({ flow: "b-checkout" }) })
      .mockResolvedValueOnce({ data: { flow: "c-search" } });

    await expect(flow(["run", flowsDir, "-r"], opts)).rejects.toThrow("process.exit:1");

    const entries = logs
      .join("\n")
      .split("\n")
      .filter((l) => l.includes(" › "));
    expect(entries).toEqual([
      "  ✗ a-login.yaml › step 1 tap",
      `  ✗ ${path.join("sub", "c-search.yaml")} › did not finish (no run report)`,
    ]);
  });

  it("finds nested flows with --recursive, skipping __baselines__, dot-directories and node_modules", async () => {
    await expect(flow(["run", flowsDir, "--recursive"], opts)).rejects.toThrow("process.exit:0");

    const flowPaths = toolsClientMock.callTool.mock.calls.map(
      (c) => (c[1] as { e2e_test_path: string }).e2e_test_path
    );
    expect(flowPaths).toEqual([
      path.join(flowsDir, "a-login.yaml"),
      path.join(flowsDir, "b-checkout.yaml"),
      path.join(flowsDir, "sub", "c-search.yaml"),
    ]);
    expect(logs.join("\n")).toContain(`[3/3] ${path.join("sub", "c-search.yaml")}`);
  });

  it("runs the tests in a nested .argent/e2e with --recursive, skipping other dot-directories", async () => {
    const root = path.join(tempRoot, "argent-mono");
    const nested = path.join(root, "app", ".argent", "e2e");
    await fsp.mkdir(nested, { recursive: true });
    await fsp.mkdir(path.join(root, ".github", "workflows"), { recursive: true });
    await fsp.writeFile(path.join(nested, "smoke.yaml"), "steps: []\n");
    await fsp.writeFile(path.join(root, ".github", "workflows", "ci.yaml"), "steps: []\n");

    await expect(flow(["run", root, "-r"], opts)).rejects.toThrow("process.exit:0");

    const flowPaths = toolsClientMock.callTool.mock.calls.map(
      (c) => (c[1] as { e2e_test_path: string }).e2e_test_path
    );
    expect(flowPaths).toEqual([path.join(nested, "smoke.yaml")]);
  });

  it("runs YAML files with a syntax error but not YAML files that are not e2e tests", async () => {
    const root = path.join(tempRoot, "shape-run");
    await writeShapeFixture(root);
    await writeShapeFixture(path.join(root, "sub"));
    const kept = Object.keys(KEPT_YAMLS);
    const ranPaths = () =>
      toolsClientMock.callTool.mock.calls.map(
        (c) => (c[1] as { e2e_test_path: string }).e2e_test_path
      );

    await expect(flow(["run", root], opts)).rejects.toThrow("process.exit:0");
    expect(ranPaths()).toEqual(kept.sort().map((name) => path.join(root, name)));

    toolsClientMock.callTool.mockClear();
    await expect(flow(["run", root, "-r"], opts)).rejects.toThrow("process.exit:0");
    expect(ranPaths()).toEqual(
      [...kept, ...kept.map((name) => path.join("sub", name))]
        .sort()
        .map((rel) => path.join(root, rel))
    );
    expect([...logs, ...errs].join("\n")).not.toMatch(/has a YAML syntax error| is empty$/m);
  });

  it("sends files with a broken steps value to the tool-server", async () => {
    const root = path.join(tempRoot, "broken-steps-run");
    await fsp.mkdir(root, { recursive: true });
    await fsp.writeFile(path.join(root, "login.yaml"), "steps:\n  - echo: hi\n");
    await fsp.writeFile(path.join(root, "null-steps.yaml"), "version: 1\nsteps:\n");
    await fsp.writeFile(path.join(root, "steps-map.yaml"), "version: 1\nsteps:\n  echo: hi\n");
    toolsClientMock.callTool.mockImplementation(async (_name, args: { e2e_test_path: string }) => {
      if (args.e2e_test_path.endsWith("login.yaml")) return { data: report() };
      throw new ToolInvocationError("Invalid e2e test file", {
        errorCode: "FLOW_FILE_INVALID",
        errorKind: "validation",
      });
    });

    await expect(flow(["run", root], opts)).rejects.toThrow("process.exit:1");

    expect(
      toolsClientMock.callTool.mock.calls.map(
        (c) => (c[1] as { e2e_test_path: string }).e2e_test_path
      )
    ).toEqual(["login.yaml", "null-steps.yaml", "steps-map.yaml"].map((n) => path.join(root, n)));
    expect(logs.join("\n")).toContain("3 e2e tests: 1 passed, 2 failed, 0 skipped");
  });

  it("enters a folder named exactly .argent, and only with --recursive", async () => {
    const root = path.join(tempRoot, "argent-exact");
    await fsp.mkdir(path.join(root, ".argent"), { recursive: true });
    await fsp.mkdir(path.join(root, ".argent-old"), { recursive: true });
    await Promise.all([
      fsp.writeFile(path.join(root, "top.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(root, ".argent", "x.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(root, ".argent-old", "y.yaml"), "steps: []\n"),
    ]);
    const ranPaths = () =>
      toolsClientMock.callTool.mock.calls.map(
        (c) => (c[1] as { e2e_test_path: string }).e2e_test_path
      );

    await expect(flow(["run", root], opts)).rejects.toThrow("process.exit:0");
    expect(ranPaths()).toEqual([path.join(root, "top.yaml")]);

    toolsClientMock.callTool.mockClear();
    await expect(flow(["run", root, "-r"], opts)).rejects.toThrow("process.exit:0");
    expect(ranPaths()).toEqual([path.join(root, ".argent", "x.yaml"), path.join(root, "top.yaml")]);
  });

  it.each(["__baselines__", ".hidden", "node_modules"])(
    "runs the tests in a directory named %s when it is the one passed",
    async (dir) => {
      await expect(flow(["run", path.join(flowsDir, dir), "-r"], opts)).rejects.toThrow(
        "process.exit:0"
      );

      expect(toolsClientMock.callTool).toHaveBeenCalledTimes(1);
    }
  );

  it("treats a directory named like a flow file as a directory", async () => {
    const dirYaml = path.join(tempRoot, "suite.yaml");
    await fsp.mkdir(dirYaml, { recursive: true });
    await fsp.writeFile(path.join(dirYaml, "one.yaml"), "steps: []\n");

    await expect(flow(["run", dirYaml], opts)).rejects.toThrow("process.exit:0");

    expect(toolsClientMock.callTool).toHaveBeenCalledWith("e2e-execute", {
      e2e_test_path: path.join(dirYaml, "one.yaml"),
      project_root: process.cwd(),
      prerequisiteAcknowledged: true,
    });
    expect(logs.join("\n")).toContain("PASS — 1 e2e test: 1 passed, 0 failed, 0 skipped");
  });

  it("exits 2 when --recursive is given a file path", async () => {
    await expect(flow(["run", path.join(flowsDir, "a-login.yaml"), "-r"], opts)).rejects.toThrow(
      "process.exit:2"
    );

    expect(errs.join("\n")).toContain(
      `e2e run --recursive requires a directory path: ${path.join(flowsDir, "a-login.yaml")}`
    );
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("exits 2 when --recursive is given a nonexistent path", async () => {
    const missing = path.join(tempRoot, "missing-dir");
    await expect(flow(["run", missing, "-r"], opts)).rejects.toThrow("process.exit:2");

    expect(errs.join("\n")).toContain(`E2E test directory not found: ${missing}`);
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("exits 2 with a --recursive hint when a directory holds no flows", async () => {
    const emptyDir = path.join(tempRoot, "empty");
    await fsp.mkdir(emptyDir, { recursive: true });

    await expect(flow(["run", emptyDir], opts)).rejects.toThrow("process.exit:2");
    expect(errs.join("\n")).toContain(`No e2e tests found in ${emptyDir}`);
    expect(errs.join("\n")).toContain("-r/--recursive");
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();

    // Already recursive: the hint would be a dead end, so it is omitted.
    errs.length = 0;
    await expect(flow(["run", emptyDir, "-r"], opts)).rejects.toThrow("process.exit:2");
    expect(errs.join("\n")).toContain("No e2e tests found");
    expect(errs.join("\n")).not.toContain("subdirectories");
  });

  it("prints a JSON error object on stderr for a directory with no flows under --json", async () => {
    const emptyDir = path.join(tempRoot, "empty-json");
    await fsp.mkdir(emptyDir, { recursive: true });

    await expect(flow(["run", emptyDir, "--json"], opts)).rejects.toThrow("process.exit:2");

    expect(logs).toEqual([]);
    expect(errs).toHaveLength(1);
    expect(JSON.parse(errs[0]!)).toEqual({
      event: "error",
      error: `No e2e tests found in ${emptyDir}\nPass -r/--recursive to include subdirectories.`,
    });
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  // Skipped as root / on Windows, where a mode-000 directory is still
  // listable. See canDenyRead.
  it.skipIf(!canDenyRead).each([
    ["human", [], (dir: string) => `Could not read e2e test directory: ${dir}`],
    [
      "--json",
      ["--json"],
      (dir: string) =>
        JSON.stringify({ event: "error", error: `Could not read e2e test directory: ${dir}` }),
    ],
  ] as const)(
    "exits 2 on a directory it cannot list, in %s mode",
    async (_mode, flags, expected) => {
      const lockedDir = path.join(tempRoot, `unlistable-${flags.length}`);
      await fsp.mkdir(lockedDir, { recursive: true });
      await fsp.writeFile(path.join(lockedDir, "a.yaml"), "steps: []\n");
      await fsp.chmod(lockedDir, 0o000);
      try {
        await expect(flow(["run", lockedDir, ...flags], opts)).rejects.toThrow("process.exit:2");
      } finally {
        await fsp.chmod(lockedDir, 0o755);
      }

      expect(logs).toEqual([]);
      expect(errs).toEqual([expected(lockedDir)]);
      expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    }
  );

  it("prints only the aggregate object with --json, tagging infra failures and skips", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
    toolsClientMock.callTool
      .mockImplementationOnce(async () => {
        advance(4000);
        return { data: report({ flow: "a-login" }) };
      })
      .mockImplementationOnce(async () => {
        advance(1500);
        throw new Error("boom");
      });

    await expect(flow(["run", flowsDir, "--json", "-r"], opts)).rejects.toThrow("process.exit:1");

    // A single parseable object on stdout — no headers or verdict lines.
    // `flows` is the deprecated spelling of `e2eTests`, with the same content.
    const parsed = JSON.parse(logs.join("\n")) as Record<string, unknown>;
    const entries = [
      { path: "a-login.yaml", status: "pass", report: report({ flow: "a-login" }) },
      { path: "b-checkout.yaml", status: "fail", error: "boom" },
      { path: path.join("sub", "c-search.yaml"), status: "skip" },
    ];
    expect(parsed).toEqual({
      ok: false,
      total: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      durationMs: 5500,
      e2eTests: entries,
      flows: entries,
    });
  });

  it("keys --output exports by the flow's subdirectory in recursive runs", async () => {
    const diffSrc = path.join(tempRoot, "diff-src.png");
    await fsp.writeFile(diffSrc, "png-bytes");
    toolsClientMock.callTool
      .mockResolvedValueOnce({ data: report({ flow: "a-login" }) })
      .mockResolvedValueOnce({ data: report({ flow: "b-checkout" }) })
      .mockResolvedValueOnce({
        data: report({
          flow: "c-search",
          ok: false,
          passed: 0,
          failed: 1,
          steps: [
            {
              index: 0,
              kind: "snapshot",
              status: "fail",
              snapshotKey: "home__ios-390x844",
              artifacts: { diff: diffSrc },
            },
          ],
        }),
      });
    const outDir = path.join(tempRoot, "out");

    await expect(flow(["run", flowsDir, "-r", "--output", outDir], opts)).rejects.toThrow(
      "process.exit:1"
    );

    // The nested flow's export lands under its subdirectory so a same-stem
    // flow at the top level cannot collide with it.
    const dest = path.join(outDir, "sub", "c-search", "home__ios-390x844-diff.png");
    await expect(fsp.readFile(dest, "utf8")).resolves.toBe("png-bytes");
    expect(logs.join("\n")).toContain(`diff: ${dest}`);
  });

  it("keeps a top-level batch flow's --output export at <output>/<flow> exactly", async () => {
    const diffSrc = path.join(tempRoot, "top-diff-src.png");
    await fsp.writeFile(diffSrc, "top-png-bytes");
    toolsClientMock.callTool
      .mockResolvedValueOnce({ data: report({ flow: "a-login" }) })
      .mockResolvedValueOnce({
        data: report({
          flow: "b-checkout",
          ok: false,
          passed: 0,
          failed: 1,
          steps: [
            {
              index: 0,
              kind: "snapshot",
              status: "fail",
              snapshotKey: "home__ios-390x844",
              artifacts: { diff: diffSrc },
            },
          ],
        }),
      });
    const outDir = path.join(tempRoot, "out-top");

    await expect(flow(["run", flowsDir, "--output", outDir], opts)).rejects.toThrow(
      "process.exit:1"
    );

    // dirname(rel) is "." at the top level and must collapse into the base —
    // the single-run <output>/<flow>/ layout, not <output>/<flow>.yaml/....
    const dest = path.join(outDir, "b-checkout", "home__ios-390x844-diff.png");
    await expect(fsp.readFile(dest, "utf8")).resolves.toBe("top-png-bytes");
    expect(logs.join("\n")).toContain(`diff: ${dest}`);
  });

  it("skips an unreadable nested subdirectory instead of aborting discovery", async () => {
    // Root ignores mode bits, so the unreadable-subtree scenario cannot occur.
    if (process.getuid?.() === 0) return;
    const suiteDir = path.join(tempRoot, "suite");
    const lockedDir = path.join(suiteDir, "locked");
    await fsp.mkdir(lockedDir, { recursive: true });
    await fsp.writeFile(path.join(suiteDir, "open.yaml"), "steps: []\n");
    await fsp.writeFile(path.join(lockedDir, "hidden.yaml"), "steps: []\n");
    await fsp.chmod(lockedDir, 0o000);
    try {
      await expect(flow(["run", suiteDir, "-r"], opts)).rejects.toThrow("process.exit:0");

      // The readable top-level flow still ran; the locked subtree was skipped
      // without the top-level "Could not read e2e test directory" abort.
      expect(toolsClientMock.callTool).toHaveBeenCalledTimes(1);
      expect(toolsClientMock.callTool).toHaveBeenCalledWith(
        "e2e-execute",
        expect.objectContaining({ e2e_test_path: path.join(suiteDir, "open.yaml") })
      );
      expect(errs.join("\n")).not.toContain("Could not read e2e test directory");
    } finally {
      await fsp.chmod(lockedDir, 0o755);
    }
  });
});

describe("argent e2e run <dir> with suite.config.yaml", () => {
  let tempRoot: string;
  let runDir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logs: string[];
  let errs: string[];
  let merged: ["out" | "err", string][];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  const opts = { paths: {} as never };
  const TEST = "steps: []\n";
  const failedReport = report({
    ok: false,
    passed: 0,
    failed: 1,
    steps: [{ index: 0, kind: "assert", status: "fail", reason: "never visible" }],
  });
  const invalidFile = (): ToolInvocationError =>
    new ToolInvocationError("flow file is not valid YAML", {
      errorCode: "FLOW_FILE_INVALID",
      errorKind: "validation",
    });

  beforeEach(async () => {
    // Real path, since process.cwd() after a chdir resolves symlinks such as /var on macOS.
    tempRoot = await fsp.realpath(await fsp.mkdtemp(path.join(tmpdir(), "argent-cli-suite-")));
    runDir = path.join(tempRoot, "e2e");
    vi.clearAllMocks();
    getResolvedToolsUrlMock.mockResolvedValue({ url: null, source: "none" });
    toolsClientMock.callTool.mockResolvedValue({ data: report() });
    logs = [];
    errs = [];
    merged = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...a) => {
      logs.push(a.join(" "));
      merged.push(["out", a.join(" ")]);
    });
    errSpy = vi.spyOn(console, "error").mockImplementation((...a) => {
      errs.push(a.join(" "));
      merged.push(["err", a.join(" ")]);
    });
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit);
  });

  afterEach(async () => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  /** Writes each file, keyed by its path relative to the run directory. */
  async function writeTree(files: Record<string, string>): Promise<void> {
    for (const [rel, text] of Object.entries(files)) {
      await fsp.mkdir(path.dirname(path.join(runDir, rel)), { recursive: true });
      await fsp.writeFile(path.join(runDir, rel), text);
    }
  }

  /** Answers each run by the test's path relative to the run directory; a pass otherwise. */
  function answer(outcomes: Record<string, unknown>): void {
    toolsClientMock.callTool.mockImplementation(
      async (_tool: string, payload: { e2e_test_path: string }) => {
        const outcome = outcomes[path.relative(runDir, payload.e2e_test_path)];
        if (outcome instanceof Error) throw outcome;
        return { data: outcome ?? report() };
      }
    );
  }

  const ran = (): string[] =>
    toolsClientMock.callTool.mock.calls.map((call) =>
      path.relative(runDir, (call[1] as { e2e_test_path: string }).e2e_test_path)
    );

  async function inDir<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
    const previousCwd = process.cwd();
    process.chdir(cwd);
    try {
      return await fn();
    } finally {
      process.chdir(previousCwd);
    }
  }

  it("runs the tests of a suite in manifest order, at the position of its first file", async () => {
    await writeTree({
      "a.yaml": TEST,
      "posts/suite.config.yaml": "tests:\n  - delete\n  - add\n",
      "posts/add.yaml": TEST,
      "posts/delete.yaml": TEST,
      "z.yaml": TEST,
    });

    await expect(flow(["run", runDir, "-r"], opts)).rejects.toThrow("process.exit:0");

    const order = ["a.yaml", "posts/delete.yaml", "posts/add.yaml", "z.yaml"].map((p) =>
      path.join(p)
    );
    expect(ran()).toEqual(order);
    const headers = logs.filter((line) => line.startsWith("["));
    expect(headers).toEqual(order.map((p, i) => `[${i + 1}/4] ${p}`));
  });

  it.each([
    ["fails its steps", failedReport],
    ["is rejected by the tool-server", invalidFile()],
    [
      "leaves baselines not written",
      report({ ok: false, baselineWrites: [{ path: "x.png", error: "EACCES" }] }),
    ],
  ])("skips the later tests of a suite when a test %s", async (_case, outcome) => {
    await writeTree({
      "suite.config.yaml": "tests:\n  - a\n  - b\n  - c\n",
      "a.yaml": TEST,
      "b.yaml": TEST,
      "c.yaml": TEST,
    });
    answer({ "a.yaml": outcome });

    await expect(flow(["run", runDir], opts)).rejects.toThrow("process.exit:1");

    expect(ran()).toEqual(["a.yaml"]);
    const lines = logs.join("\n").split("\n");
    expect(lines.slice(lines.indexOf("[2/3] b.yaml"), lines.indexOf("[2/3] b.yaml") + 6)).toEqual([
      "[2/3] b.yaml",
      "  · skipped (earlier test failed)",
      "    earlier test failed: a.yaml",
      "[3/3] c.yaml",
      "  · skipped (earlier test failed)",
      "    earlier test failed: a.yaml",
    ]);
    // A policy skip is not a failure, so the recap names only the test that failed.
    expect(lines).toContain("Failed e2e tests (1)");
    expect(lines.at(-1)).toMatch(/^FAIL — 3 e2e tests: 0 passed, 1 failed, 2 skipped/);
  });

  it("carries the earlier failed test of a suite skip into the --json aggregate", async () => {
    await writeTree({
      "posts/suite.config.yaml": "",
      "posts/add.yaml": TEST,
      "posts/delete.yaml": TEST,
    });
    answer({ [path.join("posts", "add.yaml")]: failedReport });

    await expect(flow(["run", runDir, "-r", "--json"], opts)).rejects.toThrow("process.exit:1");

    expect(logs).toHaveLength(1);
    const out = JSON.parse(logs[0]);
    expect(out).toMatchObject({ ok: false, total: 2, passed: 0, failed: 1, skipped: 1 });
    expect(out.e2eTests[1]).toEqual({
      path: path.join("posts", "delete.yaml"),
      status: "skip",
      reason: `earlier test failed: ${path.join("posts", "add.yaml")}`,
    });
  });

  it("runs every test of a suite after a failure with continueOnFailure: true", async () => {
    await writeTree({
      "suite.config.yaml": "continueOnFailure: true\n",
      "a.yaml": TEST,
      "b.yaml": TEST,
    });
    answer({ "a.yaml": failedReport });

    await expect(flow(["run", runDir], opts)).rejects.toThrow("process.exit:1");

    expect(ran()).toEqual(["a.yaml", "b.yaml"]);
    expect(logs.at(-1)).toMatch(/^\nFAIL — 2 e2e tests: 1 passed, 1 failed, 0 skipped/);
  });

  it("keeps a suite running after a test that its requires: skips", async () => {
    await writeTree({ "suite.config.yaml": "", "a.yaml": TEST, "b.yaml": TEST });
    answer({
      "a.yaml": new ToolInvocationError("[Tool:e2e-execute] excludes device SIM-1 (ios)", {
        errorCode: "FLOW_REQUIREMENTS_UNMET",
        errorKind: "validation",
      }),
    });

    await expect(flow(["run", runDir], opts)).rejects.toThrow("process.exit:0");

    expect(ran()).toEqual(["a.yaml", "b.yaml"]);
    expect(logs.at(-1)).toMatch(/^\nPASS — 2 e2e tests: 1 passed, 0 failed, 1 skipped/);
  });

  it("does not skip the tests of another suite or independent tests after a failure", async () => {
    await writeTree({
      "one/suite.config.yaml": "",
      "one/a.yaml": TEST,
      "one/b.yaml": TEST,
      "two/suite.config.yaml": "",
      "two/c.yaml": TEST,
      "two/d.yaml": TEST,
      "z.yaml": TEST,
    });
    answer({ [path.join("one", "a.yaml")]: failedReport });

    await expect(flow(["run", runDir, "-r"], opts)).rejects.toThrow("process.exit:1");

    expect(ran()).toEqual(
      ["one/a.yaml", "two/c.yaml", "two/d.yaml", "z.yaml"].map((p) => path.join(p))
    );
    expect(logs.at(-1)).toMatch(/^\nFAIL — 5 e2e tests: 3 passed, 1 failed, 1 skipped/);
  });

  it("lets a batch stop win over the suite skip", async () => {
    await writeTree({ "suite.config.yaml": "", "a.yaml": TEST, "b.yaml": TEST });
    answer({ "a.yaml": { flow: "a", notice: "prerequisite" } });

    await expect(flow(["run", runDir], opts)).rejects.toThrow("process.exit:1");

    const lines = logs.join("\n").split("\n");
    expect(lines[lines.indexOf("[2/2] b.yaml") + 1]).toBe("  · not run (batch stopped)");
  });

  it("rejects an invalid suite config, skips its tests and runs the rest", async () => {
    await writeTree({
      "a.yaml": TEST,
      "posts/suite.config.yaml": "bogus: 1\n",
      "posts/add.yaml": TEST,
      "posts/delete.yaml": TEST,
      "z.yaml": TEST,
    });
    const manifest = path.join("posts", "suite.config.yaml");
    const message = `${manifest}: unknown key "bogus"; the allowed keys are tests and continueOnFailure`;

    await expect(
      inDir(tempRoot, () =>
        flow(["run", "./e2e", "-r", "--platform", "ios", "--output", "out"], opts)
      )
    ).rejects.toThrow("process.exit:1");

    expect(ran()).toEqual(["a.yaml", "z.yaml"]);
    const lines = logs.join("\n").split("\n");
    expect(lines.slice(lines.indexOf(`[2/5] ${manifest}`), lines.indexOf("[5/5] z.yaml"))).toEqual([
      `[2/5] ${manifest}`,
      "  ✗ not run (invalid suite config)",
      `[3/5] ${path.join("posts", "add.yaml")}`,
      "  · skipped (invalid suite config)",
      `    invalid suite config: ${manifest}`,
      `[4/5] ${path.join("posts", "delete.yaml")}`,
      "  · skipped (invalid suite config)",
      `    invalid suite config: ${manifest}`,
    ]);
    expect(merged[merged.findIndex(([, line]) => line === `[2/5] ${manifest}`) + 2]).toEqual([
      "err",
      message,
    ]);
    expect(errs).toEqual([message]);
    expect(lines.slice(lines.indexOf("Failed e2e tests (1)"))).toEqual([
      "Failed e2e tests (1)",
      "",
      `  ✗ ${manifest} › not run (invalid suite config)`,
      `    ${message}`,
      `    re-run: argent e2e run ${path.join("e2e", "posts")} --platform ios --output ${path.join("out", "posts")}`,
      "",
      expect.stringMatching(/^FAIL — 5 e2e tests: 2 passed, 1 failed, 2 skipped/),
    ]);
  });

  it("reports an invalid suite config after a batch stop and does not run its tests", async () => {
    await writeTree({
      "a.yaml": TEST,
      "posts/suite.config.yaml": "bogus: 1\n",
      "posts/add.yaml": TEST,
    });
    answer({ "a.yaml": new Error("tool stream ended") });
    const manifest = path.join("posts", "suite.config.yaml");
    const add = path.join("posts", "add.yaml");
    const message = `${manifest}: unknown key "bogus"; the allowed keys are tests and continueOnFailure`;
    const signal = { error_code: "FLOW_FILE_INVALID", error_kind: "validation" };

    await expect(flow(["run", runDir, "-r"], opts)).rejects.toThrow("process.exit:1");

    const lines = logs.join("\n").split("\n");
    expect(lines.slice(0, lines.indexOf("Failed e2e tests (2)") + 1)).toEqual([
      "[1/3] a.yaml",
      "  ✗ did not finish (run error)",
      `[2/3] ${manifest}`,
      "  ✗ not run (invalid suite config)",
      `[3/3] ${add}`,
      "  · not run (batch stopped)",
      "",
      "Failed e2e tests (2)",
    ]);
    expect(lines).toContain(`  ✗ ${manifest} › not run (invalid suite config)`);
    expect(errs).toEqual(["tool stream ended", message]);

    logs = [];
    errs = [];
    await expect(flow(["run", runDir, "-r", "--json"], opts)).rejects.toThrow("process.exit:1");

    const out = JSON.parse(logs[0]);
    expect(out).toMatchObject({ ok: false, total: 3, passed: 0, failed: 2, skipped: 1 });
    expect(out.e2eTests.slice(1)).toEqual([
      { path: manifest, status: "fail", error: message, ...signal },
      { path: add, status: "skip" },
    ]);
    expect(errs).toHaveLength(2);
    expect(JSON.parse(errs[1])).toEqual({ event: "error", error: message, ...signal });
  });

  it("re-runs an invalid suite at the working directory as .", async () => {
    await writeTree({ "suite.config.yaml": "tests: []\n", "a.yaml": TEST });

    await expect(inDir(runDir, () => flow(["run", "."], opts))).rejects.toThrow("process.exit:1");

    expect(logs.join("\n").split("\n")).toContain("    re-run: argent e2e run .");
  });

  it("re-runs an invalid suite in a child of the working directory as a path, not a name", async () => {
    await writeTree({ "posts/suite.config.yaml": "tests: []\n", "posts/add.yaml": TEST });

    await expect(inDir(runDir, () => flow(["run", ".", "-r"], opts))).rejects.toThrow(
      "process.exit:1"
    );

    expect(logs.join("\n").split("\n")).toContain(`    re-run: argent e2e run .${path.sep}posts`);
  });

  it("writes an invalid suite config as a failed entry and an error record under --json", async () => {
    await writeTree({
      "suite.config.yaml": "continueOnFailure: yes\n",
      "a.yaml": TEST,
      "b.yaml": TEST,
    });
    const message = "suite.config.yaml: continueOnFailure must be true or false";
    const signal = { error_code: "FLOW_FILE_INVALID", error_kind: "validation" };

    await expect(flow(["run", runDir, "--json"], opts)).rejects.toThrow("process.exit:1");

    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0])).toMatchObject({
      ok: false,
      total: 3,
      passed: 0,
      failed: 1,
      skipped: 2,
      e2eTests: [
        { path: "suite.config.yaml", status: "fail", error: message, ...signal },
        { path: "a.yaml", status: "skip", reason: "invalid suite config: suite.config.yaml" },
        { path: "b.yaml", status: "skip", reason: "invalid suite config: suite.config.yaml" },
      ],
    });
    expect(errs.map((line) => JSON.parse(line))).toEqual([
      { event: "error", error: message, ...signal },
    ]);
  });

  it("fails a suite that names a test gone from a directory with no test", async () => {
    await writeTree({
      "posts/suite.config.yaml": "tests:\n  - checkout\n",
      "smoke.yaml": TEST,
    });
    const manifest = path.join("posts", "suite.config.yaml");
    const message = `${manifest}: tests entry "checkout" names no e2e test in this directory`;
    const signal = { error_code: "FLOW_FILE_INVALID", error_kind: "validation" };

    await expect(flow(["run", runDir, "-r"], opts)).rejects.toThrow("process.exit:1");

    expect(ran()).toEqual(["smoke.yaml"]);
    const lines = logs.join("\n").split("\n");
    expect(lines.slice(0, 3)).toEqual([
      `[1/2] ${manifest}`,
      "  ✗ not run (invalid suite config)",
      "[2/2] smoke.yaml",
    ]);
    expect(errs).toEqual([message]);
    expect(lines).toContain(`  ✗ ${manifest} › not run (invalid suite config)`);
    expect(lines.at(-1)).toMatch(/^FAIL — 2 e2e tests: 1 passed, 1 failed, 0 skipped/);

    logs = [];
    errs = [];
    await expect(flow(["run", runDir, "-r", "--json"], opts)).rejects.toThrow("process.exit:1");

    expect(JSON.parse(logs[0])).toMatchObject({
      ok: false,
      total: 2,
      passed: 1,
      failed: 1,
      skipped: 0,
      e2eTests: [
        { path: manifest, status: "fail", error: message, ...signal },
        { path: "smoke.yaml", status: "pass" },
      ],
    });
    expect(errs.map((line) => JSON.parse(line))).toEqual([
      { event: "error", error: message, ...signal },
    ]);
  });

  it("fails a run directory that holds only an invalid suite config", async () => {
    await writeTree({ "suite.config.yaml": "bogus: 1\n" });

    await expect(flow(["run", runDir], opts)).rejects.toThrow("process.exit:1");

    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    expect(errs).toEqual([
      'suite.config.yaml: unknown key "bogus"; the allowed keys are tests and continueOnFailure',
    ]);
    expect(logs.at(-1)).toMatch(/^\nFAIL — 1 e2e test: 0 passed, 1 failed, 0 skipped/);
  });

  it("rejects a suite config symlink whose target is gone and skips the tests of its suite", async () => {
    await writeTree({ "posts/add.yaml": TEST, "smoke.yaml": TEST });
    await fsp.symlink(
      path.join(tempRoot, "gone.yaml"),
      path.join(runDir, "posts", "suite.config.yaml")
    );
    const manifest = path.join("posts", "suite.config.yaml");

    await expect(flow(["run", runDir, "-r"], opts)).rejects.toThrow("process.exit:1");

    expect(ran()).toEqual(["smoke.yaml"]);
    expect(logs.join("\n").split("\n").slice(0, 6)).toEqual([
      `[1/3] ${manifest}`,
      "  ✗ not run (invalid suite config)",
      `[2/3] ${path.join("posts", "add.yaml")}`,
      "  · skipped (invalid suite config)",
      `    invalid suite config: ${manifest}`,
      "[3/3] smoke.yaml",
    ]);
    expect(errs).toEqual([`${manifest}: could not read the file: ENOENT`]);
  });

  it("warns about a test the suite does not list before the first test runs", async () => {
    await writeTree({
      "suite.config.yaml": "tests:\n  - a\n",
      "a.yaml": TEST,
      "extra.yaml": TEST,
    });
    const warning = "extra.yaml is not listed in the tests of suite.config.yaml and does not run";

    await expect(flow(["run", runDir], opts)).rejects.toThrow("process.exit:0");

    expect(ran()).toEqual(["a.yaml"]);
    expect(merged[0]).toEqual(["err", `warning: ${warning}`]);
    expect(errs).toEqual([`warning: ${warning}`]);
    expect(logs.at(-1)).toMatch(/^\nPASS — 1 e2e test: 1 passed, 0 failed, 0 skipped/);
  });

  it("writes the unlisted-test warning as a record and leaves the test out under --json", async () => {
    await writeTree({
      "suite.config.yaml": "tests:\n  - a\n",
      "a.yaml": TEST,
      "extra.yaml": TEST,
    });

    await expect(flow(["run", runDir, "--json"], opts)).rejects.toThrow("process.exit:0");

    expect(errs.map((line) => JSON.parse(line))).toEqual([
      {
        event: "warning",
        warning: "extra.yaml is not listed in the tests of suite.config.yaml and does not run",
      },
    ]);
    expect(JSON.parse(logs[0]).e2eTests.map((r: { path: string }) => r.path)).toEqual(["a.yaml"]);
  });

  it("keeps independent tests in a directory with no suite config", async () => {
    await writeTree({ "a.yaml": TEST, "b.yaml": TEST });
    answer({ "a.yaml": failedReport });

    await expect(flow(["run", runDir], opts)).rejects.toThrow("process.exit:1");

    expect(ran()).toEqual(["a.yaml", "b.yaml"]);
    expect(errs).toEqual([]);
    expect(logs.join("\n").split("\n")).toEqual([
      "[1/2] a.yaml",
      "  ✗  1 assert — never visible",
      "  FAIL (started on SIM-1) — 0 passed, 1 failed, 0 errored, 0 skipped",
      "[2/2] b.yaml",
      "  PASS (started on SIM-1) — 1 passed, 0 failed, 0 errored, 0 skipped",
      "",
      "Failed e2e tests (1)",
      "",
      "  ✗ a.yaml › step 1 assert",
      "    never visible",
      `    re-run: argent e2e run ${path.join(runDir, "a.yaml")}`,
      "",
      expect.stringMatching(/^FAIL — 2 e2e tests: 1 passed, 1 failed, 0 skipped/),
    ]);
  });
});

describe("exitAfterFlush", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("exits only after every queued write has drained (piped stdout is async)", async () => {
    // Model a pipe with a slow reader: each chunk sits in the stream's queue
    // until _write's deferred callback fires — exactly the state a >64KB
    // `--json` report is in when the old bare process.exit() truncated it.
    const flushed: string[] = [];
    let exitedEarly = false;
    const slow = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _enc, cb) {
        setTimeout(() => {
          if (exitSpy.mock.calls.length > 0) exitedEarly = true;
          flushed.push(chunk.toString());
          cb();
        }, 5);
      },
    });
    slow.write("a".repeat(64 * 1024));
    slow.write("b".repeat(64 * 1024));

    await expect(exitAfterFlush(1, [slow])).rejects.toThrow("process.exit:1");

    expect(exitedEarly).toBe(false);
    expect(flushed.join("")).toContain("a".repeat(64 * 1024));
    expect(flushed.join("")).toContain("b".repeat(64 * 1024));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("preserves the exit code with nothing queued", async () => {
    const idle = new Writable({ write: (_c, _e, cb) => cb() });
    await expect(exitAfterFlush(2, [idle])).rejects.toThrow("process.exit:2");
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});
