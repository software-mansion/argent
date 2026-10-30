import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { describeAndroid } from "../src/tools/describe/platforms/android";
import { androidTvControlBlueprint } from "../src/blueprints/android-tv-control";

const adbExecOutBinary = vi.fn();
vi.mock("../src/utils/adb", () => ({
  adbExecOutBinary: (...args: unknown[]) => adbExecOutBinary(...args),
  isAndroidTv: async () => false,
  getAndroidRuntimeKind: async () => "tv",
}));
vi.mock("../src/utils/android-screen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/android-screen")>()),
  getAndroidScreenSize: async () => ({ width: 1080, height: 2424 }),
}));

const DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="Continue" resource-id="" class="android.widget.Button" package="com.example" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,200]" />
</hierarchy>`;

const COLD_WEBVIEW_DUMP = readFileSync(
  join(__dirname, "fixtures", "android-webview-cold.xml"),
  "utf-8"
);

const NEVER_IDLE = "ERROR: could not get idle state.";

type Pending = {
  serial: string;
  finish: (dump?: string) => void;
  fail: (err: Error) => void;
};

const tvDevice = (id: string) => ({ id, platform: "android" as const, kind: "emulator" as const });

describe("describeAndroid uiautomator fallback", () => {
  let pending: Pending[];

  beforeEach(() => {
    vi.useFakeTimers();
    pending = [];
    adbExecOutBinary.mockReset();
    adbExecOutBinary.mockImplementation(
      (serial: string) =>
        new Promise<Buffer>((resolve, reject) => {
          pending.push({
            serial,
            finish: (dump = DUMP) => resolve(Buffer.from(dump)),
            fail: reject,
          });
        })
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const tick = () => vi.advanceTimersByTimeAsync(0);
  const read = (serial: string) => describeAndroid(undefined, serial, undefined, false);

  it("starts a dump on a device only after the running one on that device finished", async () => {
    const first = read("emulator-5554");
    await vi.advanceTimersByTimeAsync(1_000);
    const second = read("emulator-5554");
    await tick();
    expect(pending).toHaveLength(1);

    pending[0]!.finish();
    await first;
    await tick();
    expect(pending).toHaveLength(2);

    pending[1]!.finish();
    const { tree } = await second;
    expect(JSON.stringify(tree)).toContain("Continue");
  });

  it("gives reads requested right after a dump started that dump's output", async () => {
    const first = read("emulator-5554");
    await vi.advanceTimersByTimeAsync(400);
    const second = read("emulator-5554");
    await tick();
    expect(pending).toHaveLength(1);

    pending[0]!.finish();
    await Promise.all([first, second]);
    expect(pending).toHaveLength(1);
  });

  it("runs the next dump after one that failed", async () => {
    const first = read("emulator-5554");
    const firstFailed = expect(first).rejects.toThrow("device offline");
    await vi.advanceTimersByTimeAsync(1_000);
    const second = read("emulator-5554");
    await tick();
    expect(pending).toHaveLength(1);

    pending[0]!.fail(new Error("adb: device offline"));
    await firstFailed;
    await tick();
    expect(pending).toHaveLength(2);
    pending[1]!.finish();
    await expect(second).resolves.toMatchObject({ source: "uiautomator" });
  });

  it("dumps different devices at the same time", async () => {
    const a = read("emulator-5554");
    const b = read("emulator-5556");
    await tick();
    expect(pending.map((p) => p.serial).sort()).toEqual(["emulator-5554", "emulator-5556"]);
    for (const p of pending) p.finish();
    await Promise.all([a, b]);
  });

  it("starts a dump anyway once a read waited three seconds for the running one", async () => {
    const first = read("emulator-5554");
    await vi.advanceTimersByTimeAsync(1_000);
    const second = read("emulator-5554");
    await tick();
    expect(pending).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2_999);
    expect(pending).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(pending).toHaveLength(2);

    for (const p of pending) p.finish();
    await Promise.all([first, second]);
  });

  it("gives every read queued behind a running dump one shared dump", async () => {
    const first = read("emulator-5554");
    await vi.advanceTimersByTimeAsync(1_000);
    const queued = [1, 2, 3].map(() => read("emulator-5554"));
    await tick();
    expect(pending).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(pending).toHaveLength(2);

    for (const p of pending) p.finish();
    await Promise.all([first, ...queued]);
    expect(pending).toHaveLength(2);
  });

  it("keeps queueing reads behind an older dump after a newer one on that device finished", async () => {
    const first = read("emulator-5554");
    await vi.advanceTimersByTimeAsync(1_000);
    const second = read("emulator-5554");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(pending).toHaveLength(2);

    pending[1]!.finish();
    await second;
    await vi.advanceTimersByTimeAsync(1_000);
    const third = read("emulator-5554");
    await tick();
    expect(pending).toHaveLength(2);

    pending[0]!.finish();
    await first;
    await tick();
    expect(pending).toHaveLength(3);

    pending[2]!.finish();
    await third;
  });

  it("shares the WebView re-reads of two describes instead of taking turns", async () => {
    const first = read("emulator-5554");
    await vi.advanceTimersByTimeAsync(1_000);
    const second = read("emulator-5554");
    await tick();

    pending[0]!.finish(COLD_WEBVIEW_DUMP);
    await tick();
    expect(pending).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(250);
    expect(pending).toHaveLength(2);

    pending[1]!.finish(COLD_WEBVIEW_DUMP);
    await vi.advanceTimersByTimeAsync(250);
    expect(pending).toHaveLength(3);

    pending[2]!.finish();
    const [a, b] = await Promise.all([first, second]);
    expect(JSON.stringify(a.tree)).toContain("Continue");
    expect(JSON.stringify(b.tree)).toContain("Continue");
    expect(pending).toHaveLength(3);
  });

  it("fails a read queued behind a dump that could not get an idle screen", async () => {
    const first = read("emulator-5560");
    const firstFailed = expect(first).rejects.toThrow("could not get idle state");
    await vi.advanceTimersByTimeAsync(1_000);
    const second = read("emulator-5560");
    const secondFailed = expect(second).rejects.toThrow("could not get idle state");
    await tick();

    pending[0]!.finish(NEVER_IDLE);
    await Promise.all([firstFailed, secondFailed]);
    expect(pending).toHaveLength(1);
  });

  it("fails a read behind a running dump at once while the device reports a never-idle screen", async () => {
    const earlier = read("emulator-5562");
    const earlierFailed = expect(earlier).rejects.toThrow("could not get idle state");
    await tick();
    pending[0]!.finish(NEVER_IDLE);
    await earlierFailed;

    const abandoned = read("emulator-5562");
    await vi.advanceTimersByTimeAsync(1_500);
    const next = read("emulator-5562");
    await expect(next).rejects.toThrow("could not get idle state");
    expect(pending).toHaveLength(2);

    pending[1]!.finish();
    await abandoned;
    await vi.advanceTimersByTimeAsync(0);
    const fresh = read("emulator-5562");
    await vi.advanceTimersByTimeAsync(1_000);
    const queued = read("emulator-5562");
    await tick();
    expect(pending).toHaveLength(3);
    pending[2]!.finish();
    await fresh;
    await tick();
    expect(pending).toHaveLength(4);
    pending[3]!.finish();
    await queued;
  });

  it("starts an Android TV dump only after the describe dump on that device finished", async () => {
    const device = tvDevice("emulator-5554");
    const { api } = await androidTvControlBlueprint.factory({}, device, { device });
    const describeRead = read("emulator-5554");
    await vi.advanceTimersByTimeAsync(1_000);
    const tv = api.describe();
    await tick();
    expect(pending).toHaveLength(1);

    pending[0]!.finish();
    await describeRead;
    await tick();
    expect(pending).toHaveLength(2);

    pending[1]!.finish();
    await expect(tv).resolves.toMatchObject({ focusable: [{ label: "Continue" }] });
  });

  it("validates a shared dump separately for the Android TV read that joined it", async () => {
    const device = tvDevice("emulator-5554");
    const { api } = await androidTvControlBlueprint.factory({}, device, { device });
    const describeRead = read("emulator-5554");
    const describeFailed = expect(describeRead).rejects.toThrow();
    const tv = api.describe();
    const tvFailed = expect(tv).rejects.toThrow("uiautomator could not capture the screen: Killed");
    await tick();
    expect(pending).toHaveLength(1);

    pending[0]!.finish("Killed");
    await Promise.all([describeFailed, tvFailed]);
  });
});
