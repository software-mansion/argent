import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore, type Registry } from "@argent/registry";

// The physical-iOS route shells out (`sips` for the downscale) via
// promisify(execFile), so mock child_process the way screenshot-tv-scale.test.ts
// does. promisify appends a node-style callback as the last argument.
const execFileMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

import type { LivePanel } from "../src/utils/foldable";

const resolveLivePanelMock = vi.fn<(udid: string) => Promise<LivePanel>>();
vi.mock("../src/utils/foldable", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/foldable")>()),
  resolveLivePanel: (udid: string) => resolveLivePanelMock(udid),
}));

import { createScreenshotTool, downscalePngInPlace } from "../src/tools/screenshot";
import { RESULT_NOTE_KEY } from "../src/tools/screenshot/dropped-geometry";
import { IOS_DEVICE_RUNNER_NAMESPACE } from "../src/blueprints/ios-device-runner";
import { RUNNER_COMMAND_TIMEOUT_MS } from "../src/utils/ios-device/runner-client";

type ExecFileCallback = (e: Error | null, r?: { stdout: string; stderr: string }) => void;

function callbackOf(args: unknown[]): ExecFileCallback | undefined {
  return args.find((a) => typeof a === "function") as ExecFileCallback | undefined;
}

function failAllSpawns(message = "unexpected execFile call"): void {
  execFileMock.mockImplementation((...args: unknown[]) => {
    callbackOf(args)?.(new Error(message));
  });
}

function mockSips(): { zTargets: () => string[] } {
  const zCalls: string[] = [];
  execFileMock.mockImplementation((...args: unknown[]) => {
    const file = args[0] as string;
    const argv = (args[1] as string[]) ?? [];
    const cb = callbackOf(args);
    if (file === "sips" && argv[0] === "-z") {
      zCalls.push(`${argv[2]}x${argv[1]}`);
      cb?.(null, { stdout: "", stderr: "" });
      return;
    }
    cb?.(new Error(`unexpected execFile ${file} ${argv.join(" ")}`));
  });
  return { zTargets: () => zCalls };
}

// A PNG stub the size of its IHDR header: all the downscale reads.
async function writePngStub(width: number, height: number): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-png-stub-"));
  const file = path.join(dir, "cap.png");
  const buf = Buffer.alloc(33);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  await fs.writeFile(file, buf);
  return file;
}

beforeEach(() => {
  execFileMock.mockReset();
  failAllSpawns();
});

describe("screenshot tool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns an image artifact handle; includeImageInContext is an input-only flag handled by the MCP adapter", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          url: "http://localhost/screenshot.png",
          path: "/tmp/screenshot.png",
        }),
      })
    );

    // The tool resolves its backend lazily via the registry rather than taking
    // an eagerly-declared service, so a tvOS udid can branch away from the
    // simulator-server it can't drive. A non-iOS-shaped udid ("ABC") skips the
    // tvOS runtime probe and goes straight to simulator-server.
    const registry = {
      resolveService: vi.fn().mockResolvedValue({ apiUrl: "http://localhost:4949" }),
    } as unknown as import("@argent/registry").Registry;
    const screenshotTool = createScreenshotTool(registry);

    const params = {
      udid: "ABC",
      includeImageInContext: false,
    };
    screenshotTool.zodSchema!.parse(params);

    const result = await screenshotTool.execute({}, params, { artifacts: new ArtifactStore() });

    // The PNG is returned as an artifact handle the MCP client materializes —
    // the unreachable `127.0.0.1` media URL is no longer surfaced.
    expect(result.image).toMatchObject({
      __argentArtifact: true,
      kind: "screenshot",
      filename: "screenshot.png",
      mimeType: "image/png",
      hostPath: "/tmp/screenshot.png",
    });
    expect(result).not.toHaveProperty("includeImageInContext");
    expect(result).not.toHaveProperty("url");
  });
});

describe("screenshot tool on a foldable", () => {
  const DUO = "B6C52FD4-5408-402B-9369-EF7C66B98E6F";
  const PANELS = [
    { screenId: 1, width: 1398, height: 2034 },
    { screenId: 3, width: 2007, height: 2853 },
  ];

  afterEach(() => {
    vi.unstubAllGlobals();
    resolveLivePanelMock.mockReset();
  });

  async function shoot(api: Record<string, unknown>) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ url: "http://localhost/screenshot.png", path: "/tmp/screenshot.png" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const registry = {
      resolveService: vi.fn().mockResolvedValue(api),
    } as unknown as import("@argent/registry").Registry;
    const tool = createScreenshotTool(registry);
    const result = await tool.execute(
      {},
      { udid: DUO, includeImageInContext: false },
      { artifacts: new ArtifactStore() }
    );
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    return { result, body };
  }

  it("captures the resolved panel and notes it, with no warning", async () => {
    resolveLivePanelMock.mockResolvedValue({ screen: 3, source: "ax-service" });
    const { result, body } = await shoot({
      apiUrl: "http://localhost:4949",
      deviceId: DUO,
      display: { foldable: true, panels: PANELS, hingeAngle: null },
    });
    expect(body.screen).toBe(3);
    expect(result[RESULT_NOTE_KEY]).toContain("renders to screen 3 (inner panel, 2007x2853)");
    expect(result).not.toHaveProperty("warning");
  });

  it("warns, and notes, when nothing resolved the panel", async () => {
    resolveLivePanelMock.mockResolvedValue({
      screen: 1,
      source: "unknown",
      reason: "the accessibility service failed (no); CoreDevice failed (no)",
    });
    const { result, body } = await shoot({
      apiUrl: "http://localhost:4949",
      deviceId: DUO,
      display: { foldable: true, panels: PANELS, hingeAngle: null },
    });
    expect(body.screen).toBe(1);
    expect(result.warning).toContain("could not be resolved (the accessibility service failed");
    expect(result.warning).toContain("this capture is of screen 1 (cover panel, 1398x2034)");
    expect(result[RESULT_NOTE_KEY]).toBe(result.warning);
  });

  it("adds nothing for a device that is not foldable", async () => {
    const { result, body } = await shoot({ apiUrl: "http://localhost:4949", deviceId: DUO });
    expect(body).not.toHaveProperty("screen");
    expect(result).not.toHaveProperty("warning");
    expect(result).not.toHaveProperty(RESULT_NOTE_KEY);
    expect(resolveLivePanelMock).not.toHaveBeenCalled();
  });
});

describe("physical-iOS route: the runner is the only capture path", () => {
  const UDID = "00008110-000978540290401E";
  const DEVICE = { id: UDID, platform: "ios", kind: "device" };

  function runnerStub(imageBase64: string | undefined) {
    const run = vi.fn(async () => ({ imageBase64 }));
    const resolveService = vi.fn(async () => ({ run, udid: UDID }));
    return { run, resolveService };
  }

  function screenshotDevice(resolveService: unknown, scale = 1.0) {
    const tool = createScreenshotTool({ resolveService } as unknown as Registry);
    return tool.execute(
      {},
      { udid: UDID, scale, includeImageInContext: true },
      { artifacts: new ArtifactStore() }
    );
  }

  it("captures through the runner, on a client window that outlasts the runner's own budget", async () => {
    const { run, resolveService } = runnerStub(Buffer.from("png-bytes").toString("base64"));

    const result = await screenshotDevice(resolveService);

    expect(resolveService).toHaveBeenCalledWith(`${IOS_DEVICE_RUNNER_NAMESPACE}:${UDID}`, {
      device: DEVICE,
    });
    // PROTOCOL.md's invariant: a client window at or below the runner's own 30s
    // screenshot budget swallows its COMMAND_TIMED_OUT verdict as a raw
    // transport timeout and forces journal recovery for an answer already on
    // the way, so the documented 45s client default is the only right value.
    expect(RUNNER_COMMAND_TIMEOUT_MS).toBeGreaterThan(30_000);
    expect(run).toHaveBeenCalledWith(
      { command: "screenshot" },
      { readOnly: true, timeoutMs: RUNNER_COMMAND_TIMEOUT_MS }
    );
    expect(result.image.hostPath).toContain("argent-ios-device-screenshot-");
    await expect(fs.readFile(result.image.hostPath, "utf8")).resolves.toBe("png-bytes");
    await fs.rm(result.image.hostPath, { force: true });
  });

  it("throws when the runner answers without inline image data", async () => {
    const { resolveService } = runnerStub(undefined);

    await expect(screenshotDevice(resolveService)).rejects.toThrow(
      "Runner screenshot returned no inline image data."
    );
  });
});

describe("downscalePngInPlace: shared device-route downscale", () => {
  it("resizes both sides, rounding each as simulator-server does", async () => {
    const sips = mockSips();
    // 1206x2622 is an iPhone 17 Pro: simulator-server returns 302x656 at 0.25,
    // where `sips -Z 656` truncated the width to 301.
    await downscalePngInPlace(await writePngStub(1206, 2622), 0.25);
    await downscalePngInPlace(await writePngStub(1920, 1080), 0.5);
    expect(sips.zTargets()).toEqual(["302x656", "960x540"]);
  });

  it("does not depend on a sips dimension probe", async () => {
    const sips = mockSips();
    await downscalePngInPlace(await writePngStub(3840, 2160), 0.3);
    expect(sips.zTargets()).toEqual(["1152x648"]);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("spawns nothing at scale 1", async () => {
    await downscalePngInPlace(await writePngStub(1920, 1080), 1.0);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("keeps the file untouched when it is not a PNG", async () => {
    await downscalePngInPlace("/tmp/argent-does-not-exist.png", 0.5);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("keeps the full-resolution file when sips fails (best-effort)", async () => {
    failAllSpawns("sips: command not found");
    await expect(downscalePngInPlace(await writePngStub(1920, 1080), 0.5)).resolves.toBeUndefined();
  });
});
