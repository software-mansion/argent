import { describe, it, expect, vi, beforeEach } from "vitest";
import { describeAndroid } from "../src/tools/describe/platforms/android";

const adbExecOutBinary = vi.fn();
vi.mock("../src/utils/adb", () => ({
  adbExecOutBinary: (...args: unknown[]) => adbExecOutBinary(...args),
  isAndroidTv: async () => false,
}));
vi.mock("../src/utils/android-screen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/android-screen")>()),
  getAndroidScreenSize: async () => ({ width: 1080, height: 2424 }),
}));

const DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="Continue" resource-id="" class="android.widget.Button" package="com.example" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,200]" />
</hierarchy>`;

type Pending = { serial: string; finish: () => void };

describe("describeAndroid uiautomator fallback", () => {
  let pending: Pending[];

  beforeEach(() => {
    pending = [];
    adbExecOutBinary.mockReset();
    adbExecOutBinary.mockImplementation(
      (serial: string) =>
        new Promise<Buffer>((resolve) => {
          pending.push({ serial, finish: () => resolve(Buffer.from(DUMP)) });
        })
    );
  });

  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("starts a dump on a device only after the running one on that device finished", async () => {
    const first = describeAndroid(undefined, "emulator-5554", undefined, false);
    const second = describeAndroid(undefined, "emulator-5554", undefined, false);
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

  it("runs the next dump after one that failed", async () => {
    adbExecOutBinary.mockImplementationOnce(async () => {
      throw new Error("adb: device offline");
    });
    const first = describeAndroid(undefined, "emulator-5554", undefined, false);
    const second = describeAndroid(undefined, "emulator-5554", undefined, false);
    await expect(first).rejects.toThrow("device offline");
    await tick();
    expect(pending).toHaveLength(1);
    pending[0]!.finish();
    await expect(second).resolves.toMatchObject({ source: "uiautomator" });
  });

  it("dumps different devices at the same time", async () => {
    const a = describeAndroid(undefined, "emulator-5554", undefined, false);
    const b = describeAndroid(undefined, "emulator-5556", undefined, false);
    await tick();
    expect(pending.map((p) => p.serial).sort()).toEqual(["emulator-5554", "emulator-5556"]);
    for (const p of pending) p.finish();
    await Promise.all([a, b]);
  });
});
