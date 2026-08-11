import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";
import { exitAfterFlush, flow, parseRunArgs } from "../src/flow.js";
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
  vi.fn(
    async (): Promise<ResolvedToolsUrl> => ({
      url: null,
      source: "none",
    })
  )
);

vi.mock("@argent/tools-client", async (importOriginal) => ({
  // Keep the real isArtifactHandle — the display-path fallback under test
  // must recognize genuine wire handles.
  ...(await importOriginal<typeof import("@argent/tools-client")>()),
  createToolsClient: vi.fn(() => toolsClientMock),
  getResolvedToolsUrl: getResolvedToolsUrlMock,
  materializeArtifacts: materializeArtifactsMock,
}));

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
  artifacts?: Record<string, unknown>;
  /** Wire-only tool-step payload; the CLI StepReport type has no such field. */
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

describe("parseRunArgs", () => {
  it("returns documented defaults with just a flow path", () => {
    expect(parseRunArgs(["../flows/checkout.yaml"])).toEqual({
      flowRef: "../flows/checkout.yaml",
      updateBaselines: false,
      recursive: false,
      json: false,
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
    });
    expect(parseRunArgs(["--json", "checkout.yaml"]).json).toBe(true);
  });

  it("accepts -r and --recursive in any position", () => {
    expect(parseRunArgs(["flows", "-r"]).recursive).toBe(true);
    expect(parseRunArgs(["--recursive", "flows"]).recursive).toBe(true);
    expect(parseRunArgs(["flows"]).recursive).toBe(false);
  });

  it("takes the Metro port a dev-client launch should open", () => {
    // The token is passed through as written; flow-execute's schema owns what a
    // port is, so the CLI does not get a second opinion on it.
    expect(parseRunArgs(["checkout.yaml", "--metro-port", "8085"]).metroPort).toBe("8085");
    expect(parseRunArgs(["checkout.yaml", "--metro-port=8085"]).metroPort).toBe("8085");
    expect(parseRunArgs(["checkout.yaml"]).metroPort).toBeUndefined();
  });

  it("rejects --metro-port with no value rather than running on the default", () => {
    expect(() => parseRunArgs(["checkout.yaml", "--metro-port"])).toThrow(
      "--metro-port requires a value"
    );
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

  it("treats a following flag as a missing value, not as the value", () => {
    expect(() => parseRunArgs(["checkout.yaml", "--device", "--json"])).toThrow(
      "--device requires a value"
    );
    expect(() => parseRunArgs(["checkout.yaml", "--platform", "--update-baselines"])).toThrow(
      "--platform requires a value"
    );
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
    });
  });

  it("does not consume the next token when the value was inline", () => {
    // Guards the index bookkeeping: --device=SIM-1 must not swallow --json.
    const out = parseRunArgs(["checkout.yaml", "--device=SIM-1", "--json"]);
    expect(out.device).toBe("SIM-1");
    expect(out.json).toBe(true);
  });

  it("throws when a boolean flag is given an inline value", () => {
    expect(() => parseRunArgs(["checkout.yaml", "--json=true"])).toThrow(FlagParseException);
    expect(() => parseRunArgs(["checkout.yaml", "--json=true"])).toThrow(
      "--json does not take a value"
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
    expect(() => parseRunArgs(["checkout.yaml", "--verbose"])).toThrow(/unknown flag/);
    // A typo'd value flag must not fall back to device auto-detection.
    expect(() => parseRunArgs(["checkout.yaml", "--platfrom=ios"])).toThrow(/unknown flag/);
  });

  it("rejects extra positional arguments", () => {
    expect(() => parseRunArgs(["checkout.yaml", "extra.yaml"])).toThrow(
      "flow run accepts one flow name, YAML file path, or directory path"
    );
  });

  it("takes everything after -- as the flow, so a name may start with a hyphen", () => {
    // The flow-name charset admits a leading "-", so without the marker such a
    // saved flow would be addressable by path only.
    expect(() => parseRunArgs(["-nightly"])).toThrow(/unknown flag/);
    expect(parseRunArgs(["--device", "SIM-1", "--", "-nightly"])).toEqual({
      flowRef: "-nightly",
      device: "SIM-1",
      updateBaselines: false,
      recursive: false,
      json: false,
    });
    // The marker relaxes flag parsing, not the one-positional rule.
    expect(() => parseRunArgs(["--", "a", "b"])).toThrow(
      "flow run accepts one flow name, YAML file path, or directory path"
    );
  });

  it("counts an empty positional as the flow, not as a token to skip past", () => {
    // A truthiness test here would take "extra.yaml" as the flow and run a file
    // the operator never named at that position.
    expect(() => parseRunArgs(["", "extra.yaml"])).toThrow(
      "flow run accepts one flow name, YAML file path, or directory path"
    );
  });
});

describe("argent flow run", () => {
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

  it("resolves the YAML path and forwards flags to flow-execute", async () => {
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
      "flow-execute",
      {
        flow_path: path.join(runRoot, "checkout.yaml"),
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

  it("forwards the Metro port to flow-execute", async () => {
    // Without a flag for it, a CI run through `argent flow run` had no route to
    // the parameter at all: a dev-client launch could only ever open 8081.
    await expect(
      flow(["run", checkoutPath, "--device=SIM-1", "--metro-port=8085"], opts)
    ).rejects.toThrow("process.exit:0");

    expect(toolsClientMock.callTool).toHaveBeenCalledWith(
      "flow-execute",
      {
        flow_path: checkoutPath,
        project_root: process.cwd(),
        prerequisiteAcknowledged: true,
        device: "SIM-1",
        metroPort: "8085",
      },
      { onProgress: expect.any(Function) }
    );
  });

  it("forwards --flag=value forms to flow-execute like the space-separated ones", async () => {
    await expect(
      flow(["run", checkoutPath, "--platform=ios", "--device=SIM-1"], opts)
    ).rejects.toThrow("process.exit:0");

    expect(toolsClientMock.callTool).toHaveBeenCalledWith(
      "flow-execute",
      {
        flow_path: checkoutPath,
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
    expect(errs.join("\n")).toContain("unknown flag");
  });

  it("exits 2 when no flow name or path is given", async () => {
    await expect(flow(["run"], opts)).rejects.toThrow("process.exit:2");
    expect(errs.join("\n")).toContain(
      "requires a flow name, a YAML file path, or a directory path"
    );
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
      "flow-execute",
      {
        // A name is sent as the path it resolves to, never as a `name` source:
        // one identity keys the report, __baselines__/, and --output whichever
        // form the operator typed.
        flow_path: path.join(runRoot, ".argent", "flows", "saved.yaml"),
        project_root: runRoot,
        prerequisiteAcknowledged: true,
        device: "SIM-1",
      },
      { onProgress: expect.any(Function) }
    );
  });

  it("resolves a name and its spelled-out path to the same flow_path", async () => {
    const previousCwd = process.cwd();
    const sent = async (ref: string): Promise<unknown> => {
      toolsClientMock.callTool.mockClear();
      await expect(flow(["run", ref], opts)).rejects.toThrow("process.exit:0");
      return (toolsClientMock.callTool.mock.calls[0]![1] as { flow_path: string }).flow_path;
    };
    try {
      process.chdir(tempRoot);
      expect(await sent("saved")).toBe(await sent(path.join(".argent", "flows", "saved.yaml")));
    } finally {
      process.chdir(previousCwd);
    }
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
      `Flow file not found: ${path.join(runRoot, ".argent", "flows", "nosuchflow.yaml")}`
    );
    expect(errs.join("\n")).toContain("argent flow list");
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

    expect(errs.join("\n")).toContain(`Flow file not found: ${path.join(runRoot, "saved.yaml")}`);
    expect(errs.join("\n")).not.toContain(path.join(".argent", "flows", "saved.yaml"));
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    // Refused, but not blindly: the flow it names is saved one directory down,
    // so the message points at the name form rather than leaving the operator
    // to guess why a file they can see was not found.
    expect(errs.join("\n")).toContain("did you mean: argent flow run saved");
  });

  it("does not offer the name form for a missing path with no saved flow behind it", async () => {
    const previousCwd = process.cwd();
    try {
      process.chdir(tempRoot);
      await expect(flow(["run", "nosuchflow.yaml"], opts)).rejects.toThrow("process.exit:2");
    } finally {
      process.chdir(previousCwd);
    }

    expect(errs.join("\n")).toContain("Flow file not found");
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

    expect(errs.join("\n")).toContain("did you mean: argent flow run saved");
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
      expect(errs.join("\n")).toContain("Flow path must name the file as it appears on disk");
      expect(errs.join("\n")).toContain("Did you mean: argent flow run saved");
      expect(errs.join("\n")).not.toContain(
        `Did you mean: argent flow run ${path.join(".argent")}`
      );
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

    expect(errs.join("\n")).toContain("Flow file not found");
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
    expect(errs.join("\n")).toContain(`Did you mean: argent flow run .${path.sep}saved`);
    expect(errs.join("\n")).not.toMatch(/Did you mean: argent flow run saved$/m);
  });

  it("names the flow-name charset for a bare argument that is neither a name nor a path", async () => {
    await expect(flow(["run", "my flow"], opts)).rejects.toThrow("process.exit:2");

    expect(errs.join("\n")).toContain(
      'Flow name must contain only letters, numbers, "_", or "-": my flow'
    );
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("rejects missing and invalid YAML paths before routing or tool invocation", async () => {
    await expect(flow(["run", path.join(tempRoot, "missing.yaml")], opts)).rejects.toThrow(
      "process.exit:2"
    );
    expect(errs.join("\n")).toContain("Flow file not found");

    errs.length = 0;
    await expect(flow(["run", path.join(tempRoot, "checkout.yml")], opts)).rejects.toThrow(
      "process.exit:2"
    );
    expect(errs.join("\n")).toContain("Flow path must end in .yaml");

    errs.length = 0;
    await expect(flow(["run", path.join(tempRoot, "unsafe name.yaml")], opts)).rejects.toThrow(
      "process.exit:2"
    );
    expect(errs.join("\n")).toContain("Flow filename must have a non-empty name");
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("names the lowercase requirement when only the extension's case is wrong", async () => {
    await expect(flow(["run", path.join(tempRoot, "Checkout.YAML")], opts)).rejects.toThrow(
      "process.exit:2"
    );

    expect(errs.join("\n")).toContain("Flow extension must be lowercase .yaml, not .YAML");
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
  // matters — rejected either way, flow-execute never invoked — and the
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
      expect(out).toContain("Flow path must name the file as it appears on disk");
      expect(out).toContain('"Upper.YAML"');
      expect(out).toContain("Rename Upper.YAML to upper.yaml");
    } else {
      expect(out).toContain("Flow file not found");
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
      expect(out).toContain("Flow path must name the file as it appears on disk");
      expect(out).toContain(
        `Did you mean: argent flow run ${path.join(caseRoot, "Checkout.yaml")}`
      );
    } else {
      expect(out).toContain("Flow file not found");
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

      expect(errs.join("\n")).toContain("Flow filename must have a non-empty name");
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
    expect(out).toContain('Flow path must not contain ".." segments');
    expect(out).toContain("Pass the fully resolved path to the flow's YAML.");
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
    expect(out).toContain('Flow path must not contain ".." segments');
    expect(out).toContain(`Did you mean: argent flow run ${kernelTarget}`);
    // Readability pin: a path a shell passes through verbatim stays bare —
    // quoting is reserved for paths that need it.
    expect(out).not.toContain("argent flow run '");
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
      `Did you mean: argent flow run '${realRoot}/o'\\''brien lab/login.yaml'`
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
    expect(errs.join("\n")).toContain(`Did you mean: argent flow run ${hinted}`);
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
    expect(out).toContain('Flow path must not contain ".." segments');
    expect(out).toContain("Pass the fully resolved path to the flow's YAML.");
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
      expect(out).toContain("Flow path must not end in a path separator");
      expect(out).toContain(`Did you mean: argent flow run ${checkoutPath}`);
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
    expect(out).toContain("Flow path must not end in a path separator");
    expect(out).toContain(`Did you mean: argent flow run '${trimmed}'`);
  });

  it("lets the .. guard win when a path has both a .. segment and a trailing separator", async () => {
    // Both dishonest-path predicates match. The ".." recovery (a fully
    // resolved path) also cures the trailing separator, while the
    // separator-stripped hint would leave the ".." standing — so the ".."
    // complaint must be the one printed.
    const supplied = [tempRoot, "nope", "..", "checkout.yaml", ""].join(path.sep);
    await expect(flow(["run", supplied], opts)).rejects.toThrow("process.exit:2");

    const out = errs.join("\n");
    expect(out).toContain('Flow path must not contain ".." segments');
    expect(out).not.toContain("Flow path must not end in a path separator");
  });

  it("dispatches a path that is only separators to directory mode, not the separator guard", async () => {
    // "/" names the root directory honestly — there is no separator-stripped
    // spelling to hint at — so it batches like any other directory and fails
    // discovery (root holds no flows) rather than drawing a shape complaint.
    await expect(flow(["run", "/"], opts)).rejects.toThrow("process.exit:2");

    const out = errs.join("\n");
    expect(out).toContain("No flows found in /");
    expect(out).not.toContain("Flow path must not end in a path separator");
  });

  it("exits 2 on an empty directory named like a flow instead of handing it to flow-execute", async () => {
    // A directory — even one named `bundle.yaml` — dispatches to directory
    // mode (the isDirectory() branch runs before any file check), so it is
    // never handed to flow-execute as a file; empty, it fails discovery
    // before routing is consulted or a client is built.
    await expect(flow(["run", bundleDirPath], opts)).rejects.toThrow("process.exit:2");

    expect(errs.join("\n")).toContain(`No flows found in ${bundleDirPath}`);
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  // Skipped as root / on Windows, where a mode-000 file is still readable —
  // see canDenyRead.
  it.skipIf(!canDenyRead)(
    "exits 2 on an unreadable flow file rather than letting flow-execute hit EACCES",
    async () => {
      // The exit code is the contract, not just the wording: without the
      // readability probe the EACCES surfaces out of the tool call instead,
      // which exits 1 — a CI wrapper that tells a usage error (2) from a run
      // failure (1) would silently reclassify an unreadable file as a failing run.
      await expect(flow(["run", unreadablePath], opts)).rejects.toThrow("process.exit:2");

      expect(errs.join("\n")).toContain(`Could not read flow file: ${unreadablePath}`);
      expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
      expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["env", "Unset ARGENT_TOOLS_URL"],
    ["link", "argent unlink"],
  ] as const)("rejects %s routing without invoking flow-execute", async (source, recovery) => {
    getResolvedToolsUrlMock.mockResolvedValue({
      url: "http://example.test:4141",
      source,
    });

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:2");

    expect(errs.join("\n")).toContain("requires the auto-started local tool server");
    expect(errs.join("\n")).toContain(recovery);
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("names both recoveries when env routing shadows an existing link", async () => {
    // Unsetting only ARGENT_TOOLS_URL would re-route through the shadowed link
    // and produce a second refusal — the message must instruct both steps.
    getResolvedToolsUrlMock.mockResolvedValue({
      url: "http://example.test:4141",
      source: "env",
      shadowedLink: {
        url: "http://linked.test:5252",
        host: "linked.test",
        port: 5252,
        createdAt: "2026-07-31T00:00:00.000Z",
      },
    });

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:2");

    const out = errs.join("\n");
    expect(out).toContain("requires the auto-started local tool server; env routing is configured");
    expect(out).toContain("Unset ARGENT_TOOLS_URL");
    expect(out).toContain("argent unlink");
    expect(out).toContain("http://linked.test:5252");
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("lists runnable YAML paths without consulting remote routing", async () => {
    const listRoot = path.join(tempRoot, "list-project");
    const flowsDir = path.join(listRoot, ".argent", "flows");
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
      [".argent/flows/a-first.yaml", ".argent/flows/z-last.yaml"].join("\n")
    );
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("lists nested flows at any depth — paths `flow run` accepts", async () => {
    // run's name contract binds the filename only, so a YAML under an
    // intermediate directory is just as runnable as a top-level one — a
    // non-recursive listing would hide it.
    const listRoot = path.join(tempRoot, "list-nested-project");
    const flowsDir = path.join(listRoot, ".argent", "flows");
    await fsp.mkdir(path.join(flowsDir, "suite", "deep"), { recursive: true });
    await Promise.all([
      fsp.writeFile(path.join(flowsDir, "top.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "suite", "checkout.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "suite", "deep", "login.yaml"), "steps: []\n"),
    ]);
    const previousCwd = process.cwd();
    try {
      process.chdir(listRoot);
      await flow(["list"], opts);

      // Deterministic: sorted over the full relative paths, not walk order.
      expect(logs.join("\n")).toBe(
        [
          ".argent/flows/suite/checkout.yaml",
          ".argent/flows/suite/deep/login.yaml",
          ".argent/flows/top.yaml",
        ].join("\n")
      );

      // The other half of the agreement: the deepest advertised path runs.
      await expect(flow(["run", ".argent/flows/suite/deep/login.yaml"], opts)).rejects.toThrow(
        "process.exit:0"
      );
      expect(toolsClientMock.callTool).toHaveBeenCalledTimes(1);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("never lists the inside of a __baselines__ directory, at any depth", async () => {
    // Baselines are machine-managed snapshot storage living beside the flows
    // that own them (nested flows keep theirs beside themselves) — a YAML
    // dropped inside one is not a flow to advertise.
    const listRoot = path.join(tempRoot, "list-baselines-project");
    const flowsDir = path.join(listRoot, ".argent", "flows");
    await fsp.mkdir(path.join(flowsDir, "__baselines__", "checkout"), { recursive: true });
    await fsp.mkdir(path.join(flowsDir, "suite", "__baselines__", "login"), { recursive: true });
    await Promise.all([
      fsp.writeFile(path.join(flowsDir, "checkout.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "suite", "login.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "__baselines__", "checkout", "sneaky.yaml"), "steps: []\n"),
      fsp.writeFile(
        path.join(flowsDir, "suite", "__baselines__", "login", "sneaky.yaml"),
        "steps: []\n"
      ),
    ]);
    const previousCwd = process.cwd();
    try {
      process.chdir(listRoot);
      await flow(["list"], opts);
    } finally {
      process.chdir(previousCwd);
    }

    expect(logs.join("\n")).toBe(
      [".argent/flows/checkout.yaml", ".argent/flows/suite/login.yaml"].join("\n")
    );
  });

  it("omits .yaml files whose names `flow run` would reject — and `run` does reject them", async () => {
    const listRoot = path.join(tempRoot, "list-unsafe-project");
    const flowsDir = path.join(listRoot, ".argent", "flows");
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
      expect(logs.join("\n")).toBe(".argent/flows/sign-in.yaml");

      // The omissions are agreements, not gaps: the very fixtures `list`
      // hides must be ones `run` refuses, or the omission would be hiding
      // runnable paths. Pin both halves against the same files.
      for (const unsafe of ["sign.in.yaml", "ok (copy).yaml"]) {
        errs.length = 0;
        await expect(flow(["run", `.argent/flows/${unsafe}`], opts)).rejects.toThrow(
          "process.exit:2"
        );
        expect(errs.join("\n")).toContain("Flow filename must have a non-empty name");
      }
      expect(toolsClientMock.callTool).not.toHaveBeenCalled();
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("omits a directory named like a flow, which `flow run` rejects as not a file", async () => {
    const listRoot = path.join(tempRoot, "list-dir-project");
    const flowsDir = path.join(listRoot, ".argent", "flows");
    await fsp.mkdir(path.join(flowsDir, "bundle.yaml"), { recursive: true });
    await fsp.writeFile(path.join(flowsDir, "checkout.yaml"), "steps: []\n");
    const previousCwd = process.cwd();
    try {
      process.chdir(listRoot);
      await flow(["list"], opts);
    } finally {
      process.chdir(previousCwd);
    }

    expect(logs.join("\n")).toBe(".argent/flows/checkout.yaml");
  });

  // Skipped as root / on Windows, where a mode-000 file is still readable —
  // see canDenyRead.
  it.skipIf(!canDenyRead)(
    "omits an unreadable flow file, which `flow run` rejects as unreadable",
    async () => {
      const listRoot = path.join(tempRoot, "list-noperm-project");
      const flowsDir = path.join(listRoot, ".argent", "flows");
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
      expect(logs.join("\n")).toBe(".argent/flows/checkout.yaml");
    }
  );

  it("lists a symlink to a flow file, which `flow run` accepts, but not a broken one", async () => {
    const listRoot = path.join(tempRoot, "list-symlink-project");
    const flowsDir = path.join(listRoot, ".argent", "flows");
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

    expect(logs.join("\n")).toBe(".argent/flows/linked.yaml");
  });

  it("prints the no-flows message when no entry in the directory is runnable", async () => {
    const listRoot = path.join(tempRoot, "list-empty-project");
    const flowsDir = path.join(listRoot, ".argent", "flows");
    await fsp.mkdir(path.join(flowsDir, "bundle.yaml"), { recursive: true });
    const previousCwd = process.cwd();
    try {
      process.chdir(listRoot);
      await flow(["list"], opts);
    } finally {
      process.chdir(previousCwd);
    }

    expect(logs.join("\n")).toBe("No flows found in .argent/flows");
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
    expect(out).toContain('Flow "checkout" on SIM-1');
    expect(out).toContain("assumes: App on the login screen");
    // Echo is narration — no index; numbering starts at the first real step.
    expect(out).toContain("› Opening settings");
    expect(out).toMatch(/✓ {2}1 tap/);
    expect(out).toMatch(/✗ {2}2 assert \[login\] — never visible/);
    expect(out).toMatch(/· {2}3 tool screenshot/);
    expect(out).toContain("FAIL — 1 passed, 1 failed, 0 errored, 1 skipped");
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

  it("exits 2 when the result is not a run report (e.g. a prerequisite notice)", async () => {
    toolsClientMock.callTool.mockResolvedValue({
      data: { flow: "checkout", notice: "prerequisite", executionPrerequisite: "logged in" },
    });

    await expect(flow(["run", checkoutPath], opts)).rejects.toThrow("process.exit:2");
    expect(errs.join("\n")).toContain('"checkout" did not produce a run report');
  });

  it("exits 2 on an unknown subcommand", async () => {
    await expect(flow(["frobnicate"], opts)).rejects.toThrow("process.exit:2");
    expect(errs.join("\n")).toContain('Unknown flow subcommand "frobnicate"');
  });

  it("prints help and returns (no exit) with no subcommand", async () => {
    await flow([], opts);
    expect(logs.join("\n")).toContain("Usage: argent flow");
    expect(logs.join("\n")).toContain(
      "filename (minus .yaml) names the run's report and artifacts"
    );
    expect(logs.join("\n")).toContain('contain only letters, numbers, "_", or "-"');
    expect(logs.join("\n")).toContain(
      "ARGENT_TOOLS_URL and `argent link` routing are not supported"
    );
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("prints help instead of running when --help follows the flow name", async () => {
    await flow(["run", "checkout", "--help"], opts);
    expect(logs.join("\n")).toContain("Options (run):");
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("prints help instead of running when -h trails other run flags", async () => {
    await flow(["run", "checkout", "--device", "SIM-1", "-h"], opts);
    expect(logs.join("\n")).toContain("Usage: argent flow");
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });
});

describe("argent flow run <dir>", () => {
  let tempRoot: string;
  let flowsDir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logs: string[];
  let errs: string[];
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
    await fsp.mkdir(path.join(flowsDir, "bundle.yaml"), { recursive: true });
    await Promise.all([
      fsp.writeFile(path.join(flowsDir, "a-login.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "b-checkout.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "notes.yml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "bad name.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "sub", "c-search.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, ".hidden", "hidden.yaml"), "steps: []\n"),
      fsp.writeFile(path.join(flowsDir, "node_modules", "dep.yaml"), "steps: []\n"),
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

  it("runs each top-level flow in order without live progress and exits 0 when all pass", async () => {
    await expect(flow(["run", flowsDir], opts)).rejects.toThrow("process.exit:0");

    // Only the two safe top-level .yaml files, in lexicographic order, and
    // never with onProgress (batch output is failures-only).
    expect(toolsClientMock.callTool).toHaveBeenCalledTimes(2);
    expect(toolsClientMock.callTool).toHaveBeenNthCalledWith(1, "flow-execute", {
      flow_path: path.join(flowsDir, "a-login.yaml"),
      project_root: process.cwd(),
      prerequisiteAcknowledged: true,
    });
    expect(toolsClientMock.callTool).toHaveBeenNthCalledWith(2, "flow-execute", {
      flow_path: path.join(flowsDir, "b-checkout.yaml"),
      project_root: process.cwd(),
      prerequisiteAcknowledged: true,
    });
    const out = logs.join("\n");
    expect(out).toContain("[1/2] a-login.yaml");
    expect(out).toContain("[2/2] b-checkout.yaml");
    expect(out).toContain("PASS (started on SIM-1) — 1 passed, 0 failed, 0 errored, 0 skipped");
    // Passing steps stay silent in batch mode.
    expect(out).not.toMatch(/✓ {2}1 tap/);
    expect(out).toContain("PASS — 2 flows: 2 passed, 0 failed, 0 skipped");
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
    expect(out).toContain("FAIL — 2 flows: 1 passed, 1 failed, 0 skipped");
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
    expect(out).toContain("FAIL — 3 flows: 1 passed, 1 failed, 1 skipped");
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
    expect(out).toContain("FAIL — 2 flows: 1 passed, 1 failed, 0 skipped");
  });

  it("stops the batch on a server error the signal does not mark as validation", async () => {
    toolsClientMock.callTool.mockRejectedValueOnce(
      new ToolInvocationError("simulator boot failed", { errorKind: "subprocess" })
    );

    await expect(flow(["run", flowsDir], opts)).rejects.toThrow("process.exit:1");

    expect(toolsClientMock.callTool).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).toContain("FAIL — 2 flows: 0 passed, 1 failed, 1 skipped");
  });

  it("treats a non-report result as a failure that stops the batch", async () => {
    toolsClientMock.callTool.mockResolvedValueOnce({
      data: { flow: "a-login", notice: "prerequisite" },
    });

    await expect(flow(["run", flowsDir], opts)).rejects.toThrow("process.exit:1");

    expect(toolsClientMock.callTool).toHaveBeenCalledTimes(1);
    expect(errs.join("\n")).toContain('"a-login.yaml" did not produce a run report');
    expect(logs.join("\n")).toContain("FAIL — 2 flows: 0 passed, 1 failed, 1 skipped");
  });

  it("finds nested flows with --recursive, skipping dot-directories and node_modules", async () => {
    await expect(flow(["run", flowsDir, "--recursive"], opts)).rejects.toThrow("process.exit:0");

    const flowPaths = toolsClientMock.callTool.mock.calls.map(
      (c) => (c[1] as { flow_path: string }).flow_path
    );
    expect(flowPaths).toEqual([
      path.join(flowsDir, "a-login.yaml"),
      path.join(flowsDir, "b-checkout.yaml"),
      path.join(flowsDir, "sub", "c-search.yaml"),
    ]);
    expect(logs.join("\n")).toContain(`[3/3] ${path.join("sub", "c-search.yaml")}`);
  });

  it("treats a directory named like a flow file as a directory", async () => {
    const dirYaml = path.join(tempRoot, "suite.yaml");
    await fsp.mkdir(dirYaml, { recursive: true });
    await fsp.writeFile(path.join(dirYaml, "one.yaml"), "steps: []\n");

    await expect(flow(["run", dirYaml], opts)).rejects.toThrow("process.exit:0");

    expect(toolsClientMock.callTool).toHaveBeenCalledWith("flow-execute", {
      flow_path: path.join(dirYaml, "one.yaml"),
      project_root: process.cwd(),
      prerequisiteAcknowledged: true,
    });
    expect(logs.join("\n")).toContain("PASS — 1 flow: 1 passed, 0 failed, 0 skipped");
  });

  it("exits 2 when --recursive is given a file path", async () => {
    await expect(flow(["run", path.join(flowsDir, "a-login.yaml"), "-r"], opts)).rejects.toThrow(
      "process.exit:2"
    );

    expect(errs.join("\n")).toContain(
      `flow run --recursive requires a directory path: ${path.join(flowsDir, "a-login.yaml")}`
    );
    expect(getResolvedToolsUrlMock).not.toHaveBeenCalled();
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("exits 2 when --recursive is given a nonexistent path", async () => {
    const missing = path.join(tempRoot, "missing-dir");
    await expect(flow(["run", missing, "-r"], opts)).rejects.toThrow("process.exit:2");

    expect(errs.join("\n")).toContain(`Flow directory not found: ${missing}`);
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("exits 2 with a --recursive hint when a directory holds no flows", async () => {
    const emptyDir = path.join(tempRoot, "empty");
    await fsp.mkdir(emptyDir, { recursive: true });

    await expect(flow(["run", emptyDir], opts)).rejects.toThrow("process.exit:2");
    expect(errs.join("\n")).toContain(`No flows found in ${emptyDir}`);
    expect(errs.join("\n")).toContain("-r/--recursive");
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();

    // Already recursive: the hint would be a dead end, so it is omitted.
    errs.length = 0;
    await expect(flow(["run", emptyDir, "-r"], opts)).rejects.toThrow("process.exit:2");
    expect(errs.join("\n")).toContain("No flows found");
    expect(errs.join("\n")).not.toContain("subdirectories");
  });

  it("rejects remote routing before running any flow in the directory", async () => {
    getResolvedToolsUrlMock.mockResolvedValue({ url: "http://example.test:4141", source: "env" });

    await expect(flow(["run", flowsDir], opts)).rejects.toThrow("process.exit:2");

    expect(errs.join("\n")).toContain("requires the auto-started local tool server");
    expect(toolsClientMock.callTool).not.toHaveBeenCalled();
  });

  it("prints only the aggregate object with --json, tagging infra failures and skips", async () => {
    toolsClientMock.callTool
      .mockResolvedValueOnce({ data: report({ flow: "a-login" }) })
      .mockRejectedValueOnce(new Error("boom"));

    await expect(flow(["run", flowsDir, "--json", "-r"], opts)).rejects.toThrow("process.exit:1");

    // A single parseable object on stdout — no headers or verdict lines.
    const parsed = JSON.parse(logs.join("\n")) as Record<string, unknown>;
    expect(parsed).toEqual({
      ok: false,
      total: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      flows: [
        { path: "a-login.yaml", status: "pass", report: report({ flow: "a-login" }) },
        { path: "b-checkout.yaml", status: "fail", error: "boom" },
        { path: path.join("sub", "c-search.yaml"), status: "skip" },
      ],
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
      // without the top-level "Could not read flow directory" abort.
      expect(toolsClientMock.callTool).toHaveBeenCalledTimes(1);
      expect(toolsClientMock.callTool).toHaveBeenCalledWith(
        "flow-execute",
        expect.objectContaining({ flow_path: path.join(suiteDir, "open.yaml") })
      );
      expect(errs.join("\n")).not.toContain("Could not read flow directory");
    } finally {
      await fsp.chmod(lockedDir, 0o755);
    }
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
