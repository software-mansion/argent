import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { Registry, TypedEventEmitter } from "@argent/registry";
import type { ServiceEvents } from "@argent/registry";
import { createScreenshotTool } from "../../src/tools/screenshot";
import { SIMULATOR_SERVER_NAMESPACE } from "../../src/blueprints/simulator-server";
import { runSnapshot } from "../../src/tools/flows/flow-visual";
import type { ActionEnv } from "../../src/tools/flows/flow-actions";

// Everything from `runSnapshot` down to the request body is the real thing —
// the real `invokeOnDevice`, the real `screenshot` tool, the real
// `httpScreenshot` — so the scale each capture lands at is resolved exactly as
// it is in production, and the baseline key is the one a run would write. Only
// the settle above the capture and the simulator-server below it are stood in
// for; the stand-in replies at `fetch`, which needs no socket to bind.
vi.mock("../../src/tools/flows/flow-actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/flows/flow-actions")>();
  return { ...actual, settleTree: vi.fn(async () => ({})) };
});

const SCREEN_W = 1080;
const SCREEN_H = 2424;

const API_URL = "http://127.0.0.1:65500";

let tmpDir: string;
let shotDir: string;
let registry: Registry;
let env: ActionEnv;
/** Scales the fake server was asked for, in call order. */
let requested: (number | undefined)[];
/** How the fake server answers a full-resolution request; null serves one. */
let fullResFailure: { status: number; error: string } | null;

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
  fullResFailure = { status: 200, error: "wrong data size, expected 7853760 got 17627328" };

  // Fake simulator-server: an Android emulator that cannot stream a full-res
  // frame. `httpScreenshot` omits `scale` from the body only when it resolves
  // to 1.0, so "no scale" IS the full-res request — answer it the way the
  // emulator does, with a body carrying a framebuffer size mismatch.
  vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
    expect(url).toBe(`${API_URL}/api/screenshot`);
    const body = JSON.parse(init.body) as { scale?: number };
    requested.push(body.scale);
    if (body.scale === undefined && fullResFailure !== null) {
      return new Response(JSON.stringify({ error: fullResFailure.error }), {
        status: fullResFailure.status,
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
    ...overrides,
  } as Parameters<typeof runSnapshot>[1];
}

describe("snapshot fallback capture scale", () => {
  it("keys a fallback baseline on the device, not on ARGENT_SCREENSHOT_SCALE", async () => {
    vi.stubEnv("ARGENT_SCREENSHOT_SCALE", "0.3");
    const seeded = await runSnapshot(env, opts({ updateBaselines: true }));
    expect(seeded.status).toBe("pass");

    // Same emulator, same flow, a tool-server started with a different value of
    // an unrelated agent-detail knob.
    vi.stubEnv("ARGENT_SCREENSHOT_SCALE", "0.5");
    const rerun = await runSnapshot(env, opts());

    // A clean comparison names the key it compared against in its reason.
    expect(rerun.status).toBe("pass");
    expect(rerun.reason).toContain(`(${seeded.snapshotKey}.png)`);
  });

  it("asks for full resolution first, then for a scale of its own", async () => {
    vi.stubEnv("ARGENT_SCREENSHOT_SCALE", "0.5");

    await runSnapshot(env, opts({ updateBaselines: true }));

    // `httpScreenshot` omits `scale` only for a full-res request, so the first
    // entry is the full-res attempt; the second is the retry's own scale, not
    // the env var's.
    expect(requested).toEqual([undefined, 0.3]);
  });

  it("keys a reduced-scale capture apart from a full-res baseline", async () => {
    // A host that streams full-res seeds the strict baseline...
    fullResFailure = null;
    const seeded = await runSnapshot(env, opts({ updateBaselines: true }));
    expect(seeded.snapshotKey).toBe("home__android-1080x2424");

    // ...and a host that cannot seeds its own rather than passing a downscaled
    // capture off against it. Same message any new device class gets.
    fullResFailure = { status: 200, error: "wrong data size, expected 7853760 got 17627328" };
    const constrained = await runSnapshot(env, opts());

    expect(constrained.snapshotKey).toBe("home__android-324x727");
    expect(constrained.status).toBe("fail");
    expect(constrained.reason).toContain('no baseline for "home" on this device class');
  });

  it("leaves a capture failure that is not the framebuffer limit alone", async () => {
    // Asking for less answers a dead backend the same way, and a transient that
    // did clear on the retry would key the step off a resolution the device
    // does not otherwise produce — a committed baseline reported missing.
    fullResFailure = { status: 500, error: "emulator gRPC bridge closed" };

    await expect(runSnapshot(env, opts({ updateBaselines: true }))).rejects.toThrow(
      "emulator gRPC bridge closed"
    );
    expect(requested).toEqual([undefined]);
  });
});
