import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { Registry, TypedEventEmitter } from "@argent/registry";
import type { ServiceEvents } from "@argent/registry";
import { createScreenshotTool } from "../../src/tools/screenshot";
import { SIMULATOR_SERVER_NAMESPACE } from "../../src/blueprints/simulator-server";
import { isPixelBufferSizeMismatch } from "../../src/utils/simulator-client";
import { runSnapshot } from "../../src/tools/flows/flow-visual";
import type { ActionEnv } from "../../src/tools/flows/flow-actions";

// Everything from `runSnapshot` down to the request body is the real thing —
// the real `invokeOnDevice`, the real `screenshot` tool, the real
// `httpScreenshot` — so the scale each capture lands at is resolved exactly as
// it is in production, and the baseline key is the one a run would write. Stood
// in for: the settle above the capture, the rotation probe beside it (an adb
// round trip that would otherwise read whatever emulator this host has attached
// at the serial below), and the simulator-server underneath. The server
// stand-in replies at `fetch`, which needs no socket to bind, and sizes what it
// returns the way the server does — `round(dimension × scale)`.
//
// That last part is a model of the binary, which is not in-tree (fetched by
// scripts/download-simulator-server.sh from a rolling tag), so a build that
// truncated instead of rounding would flip every Android snapshot key with
// this suite still green. The real binary is held to it by the retry-scale
// fidelity check in scripts/e2e/drive-device.sh, which captures twice on a
// booted device and compares dimensions.
vi.mock("../../src/tools/flows/flow-actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/flows/flow-actions")>();
  return { ...actual, settleTree: vi.fn(async () => ({})) };
});
vi.mock("../../src/utils/device-orientation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/device-orientation")>();
  return { ...actual, readAndroidSurfaceRotation: vi.fn(async () => null) };
});

const SCREEN_W = 1080;
const SCREEN_H = 2424;

/** Verbatim from the Pixel_9a emulator this was first seen on. */
const REFUSAL = "wrong data size, expected 7853760 got 17627328";

const API_URL = "http://127.0.0.1:65500";

let tmpDir: string;
let shotDir: string;
let registry: Registry;
let env: ActionEnv;
/** Scales the fake server was asked for, in call order. */
let requested: (number | undefined)[];
/** How the fake server answers an unscaled request; null serves one. */
let unscaledFailure: { status: number; error: string } | null;

async function writePng(file: string, w: number, h: number): Promise<void> {
  const png = new PNG({ width: w, height: h });
  png.data.fill(128);
  await fs.writeFile(file, PNG.sync.write(png));
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-snap-scale-"));
  shotDir = path.join(tmpDir, "shots");
  await fs.mkdir(shotDir);
  requested = [];
  unscaledFailure = { status: 200, error: REFUSAL };

  // Fake simulator-server: an Android emulator that refuses the unscaled
  // capture. `httpScreenshot` omits `scale` from the body only when it resolves
  // to 1.0, so "no scale" IS the unscaled request — answer it the way the
  // emulator does, with a body carrying the encoder's buffer-length complaint.
  vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
    expect(url).toBe(`${API_URL}/api/screenshot`);
    const body = JSON.parse(init.body) as { scale?: number };
    requested.push(body.scale);
    if (body.scale === undefined && unscaledFailure !== null) {
      return new Response(JSON.stringify({ error: unscaledFailure.error }), {
        status: unscaledFailure.status,
      });
    }
    const file = path.join(shotDir, `shot-${requested.length}.png`);
    const scale = body.scale ?? 1.0;
    await writePng(file, Math.round(SCREEN_W * scale), Math.round(SCREEN_H * scale));
    return new Response(JSON.stringify({ url: `file://${file}`, path: file }), { status: 200 });
  });

  registry = new Registry();
  registry.registerBlueprint({
    namespace: SIMULATOR_SERVER_NAMESPACE,
    getURN: (id: string) => `${SIMULATOR_SERVER_NAMESPACE}:${id}`,
    factory: async () => ({
      api: { apiUrl: API_URL, streamUrl: "", pressKey: () => {} },
      dispose: async () => {},
      events: new TypedEventEmitter<ServiceEvents>(),
    }),
  });
  registry.registerTool(createScreenshotTool(registry));

  env = {
    device: { platform: "android", id: "emulator-5554", kind: "emulator" },
    signal: undefined,
    registry,
    ctx: { artifacts: registry.artifacts },
  } as unknown as ActionEnv;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function opts(overrides: Record<string, unknown> = {}) {
  return {
    flowsDir: tmpDir,
    flowName: "checkout",
    name: "home",
    maxMismatch: 0.5,
    updateBaselines: false,
    appIdentity: "/apps/app-a",
    seenKeys: new Map<string, string>(),
    unscaledCaptureRefused: new Set<string>(),
    ...overrides,
  } as Parameters<typeof runSnapshot>[1];
}

describe("snapshot capture on a device that refuses an unscaled frame", () => {
  it("gates against the baseline a host serving unscaled frames writes", async () => {
    // A host that serves the frame directly seeds the baseline...
    unscaledFailure = null;
    const seeded = await runSnapshot(env, opts({ updateBaselines: true }));
    expect(seeded.snapshotKey).toBe(`home__android-${SCREEN_W}x${SCREEN_H}`);

    // ...and a host that refuses it compares against that very file, rather
    // than reporting the device class it shares as having no baseline. The key
    // is capture geometry, so this holds only because the retry comes back at
    // the screen's own dimensions.
    unscaledFailure = { status: 200, error: REFUSAL };
    const constrained = await runSnapshot(env, opts());

    // A clean comparison names the baseline it compared against, and carries no
    // snapshotKey of its own.
    expect(constrained.status).toBe("pass");
    expect(constrained.reason).toContain(`(${seeded.snapshotKey}.png)`);
  });

  it("retries at a scale of its own, not at ARGENT_SCREENSHOT_SCALE", async () => {
    // An unrelated knob, documented as controlling how much detail the *agent*
    // sees. Inheriting it would key every committed baseline on the value the
    // host that seeded it happened to run with.
    vi.stubEnv("ARGENT_SCREENSHOT_SCALE", "0.5");

    const r = await runSnapshot(env, opts({ updateBaselines: true }));

    // `httpScreenshot` omits `scale` only for an unscaled request, so the first
    // entry is that attempt and the second is the retry's own scale.
    expect(requested).toEqual([undefined, 1 - 1e-6]);
    expect(r.snapshotKey).toBe(`home__android-${SCREEN_W}x${SCREEN_H}`);
  });

  it("leaves a capture failure that re-requesting cannot fix alone", async () => {
    // The retry asks for the frame that just failed, so a dead backend answers
    // it the same way — and waiting for a second refusal delays the report
    // without changing it.
    unscaledFailure = { status: 500, error: "emulator gRPC bridge closed" };

    await expect(runSnapshot(env, opts({ updateBaselines: true }))).rejects.toThrow(
      "emulator gRPC bridge closed"
    );
    expect(requested).toEqual([undefined]);
  });
});

describe("isPixelBufferSizeMismatch", () => {
  it("matches the encoder's complaint as the server words it", () => {
    expect(isPixelBufferSizeMismatch(new Error(`Screenshot failed: ${REFUSAL}.`))).toBe(true);
    expect(isPixelBufferSizeMismatch(new Error("Screenshot failed: Wrong Data Size."))).toBe(true);
  });

  it("matches nothing else a failed capture can arrive as", () => {
    expect(isPixelBufferSizeMismatch(new Error("Screenshot failed: no image to export."))).toBe(
      false
    );
    // The callers hand it whatever they caught, which need not be an Error —
    // and a rejection that merely carries the wording is not the server saying
    // it, so the type is part of the condition.
    expect(isPixelBufferSizeMismatch({ message: REFUSAL })).toBe(false);
    expect(isPixelBufferSizeMismatch(REFUSAL)).toBe(false);
    expect(isPixelBufferSizeMismatch(undefined)).toBe(false);
  });
});
