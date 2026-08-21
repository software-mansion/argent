import { beforeEach, describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";

// `describeAndroid` falls back to the legacy `uiautomator dump` path whenever no
// registry is passed, so these drive that path directly with the dump stubbed.
const { dumpAndroidUiXml, isAndroidTv, getAndroidScreenSize } = vi.hoisted(() => ({
  dumpAndroidUiXml: vi.fn(async (): Promise<string> => ""),
  isAndroidTv: vi.fn(async (): Promise<boolean> => false),
  getAndroidScreenSize: vi.fn(async () => ({ width: 1080, height: 2220 })),
}));
vi.mock("../src/utils/android-ui-dump", () => ({ dumpAndroidUiXml }));
vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  isAndroidTv,
}));
vi.mock("../src/utils/android-screen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/android-screen")>()),
  getAndroidScreenSize,
}));

import { describeAndroid } from "../src/tools/describe/platforms/android";

const VALID_DUMP =
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">` +
  `<node index="0" text="hello" resource-id="" class="android.widget.TextView" package="com.x" ` +
  `content-desc="" bounds="[0,0][100,50]" /></hierarchy>`;

describe("describeAndroid — a dump that did not happen is a capture failure", () => {
  beforeEach(() => {
    dumpAndroidUiXml.mockReset();
    isAndroidTv.mockReset();
    isAndroidTv.mockImplementation(async () => false);
  });

  async function capture(raw: string): Promise<Error> {
    dumpAndroidUiXml.mockImplementationOnce(async () => raw);
    return describeAndroid(undefined, "emulator-5554").then(
      () => {
        throw new Error("expected describeAndroid to reject, but it resolved");
      },
      (e: unknown) => e as Error
    );
  }

  it("classifies a device-refused dump by its ERROR: line", async () => {
    const err = await capture("ERROR: null root node returned by UiTestAutomationBridge.");
    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.ANDROID_UIAUTOMATOR_CAPTURE_FAILED
    );
    expect(err.message).toMatch(/could not capture the screen/);
  });

  it("classifies a `Killed` dump the same way, though it says nothing about an error", async () => {
    // The device serves one UiAutomation connection; a dump that loses the race
    // is killed and adb still exits 0. Testing for error WORDING missed this and
    // let it reach the parser, which reported the far less actionable "failed to
    // parse" for what is really "try again".
    const err = await capture("Killed \n");
    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.ANDROID_UIAUTOMATOR_CAPTURE_FAILED
    );
    expect(err.message).toMatch(/another uiautomator dump holding the device/);
  });

  it("classifies an empty reply rather than reporting a parse failure", async () => {
    const err = await capture("");
    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.ANDROID_UIAUTOMATOR_CAPTURE_FAILED
    );
    expect(err.message).toMatch(/\(no output\)/);
  });

  it("asks for the serial it was given", async () => {
    // The dump is stubbed by module, so nothing else here would notice this
    // function dumping a DIFFERENT device — it would answer every describe with
    // whatever screen the other device happened to show.
    dumpAndroidUiXml.mockImplementationOnce(async () => VALID_DUMP);
    await describeAndroid(undefined, "emulator-5560");
    expect(dumpAndroidUiXml).toHaveBeenCalledWith("emulator-5560");
  });

  it("caps the device output it quotes back", async () => {
    // The failing dump's own bytes are interpolated into an agent-facing message.
    // Uncapped, a screen the device refuses can put an unbounded amount of
    // page-controlled text into the model's context — the chromium clear caps its
    // element label for exactly this reason, and the TV blueprint caps this same
    // dump output.
    const err = await capture(`ERROR: ${"x".repeat(4000)}`);
    expect(err.message.length).toBeLessThan(1000);
  });

  it("parses a dump whose ERROR: line arrived AHEAD of a usable hierarchy", async () => {
    // A `waitForIdle` timeout prints `ERROR: …` and still dumps: `adb exec-out`
    // folds it in ahead of the XML. The old condition was anchored on that
    // wording (`/^ERROR:/i`) and threw, discarding a hierarchy the device did
    // produce; testing for the hierarchy instead accepts it. That is a real
    // change of verdict on a real device output, in the opposite direction to the
    // `Killed` case above, and it was unpinned — the existing noise fixture uses
    // `WARNING:`, which the old condition also let through.
    dumpAndroidUiXml.mockImplementationOnce(
      async () => `ERROR: could not get idle state.\n${VALID_DUMP}`
    );

    const result = await describeAndroid(undefined, "emulator-5554");

    expect(result.source).toBe("uiautomator");
    expect(JSON.stringify(result.tree)).toContain("hello");
  });

  it("still parses a real dump, including one with noise prepended", async () => {
    // `adb exec-out` folds the device's stderr into stdout, so a warning can
    // arrive ahead of the XML — a substring test survives that, an anchored one
    // would not.
    //
    // The TREE is what has to be asserted, not `source`: that is an
    // unconditional string literal on this branch, so a version of this function
    // that never called the parser at all would satisfy it. This is also the
    // only test that drives the legacy `describeAndroid` path — the four suites
    // that exercise `parseUiAutomatorDump` call the parser directly and never
    // reach it.
    dumpAndroidUiXml.mockImplementationOnce(async () => VALID_DUMP);
    const clean = await describeAndroid(undefined, "emulator-5554");
    expect(clean.source).toBe("uiautomator");
    expect(JSON.stringify(clean.tree)).toContain("hello");

    dumpAndroidUiXml.mockImplementationOnce(async () => `WARNING: something\n${VALID_DUMP}`);
    const noisy = await describeAndroid(undefined, "emulator-5554");
    expect(noisy.source).toBe("uiautomator");
    // The noise must not cost the tree: same parse, prefix and all.
    expect(noisy.tree).toEqual(clean.tree);
  });
});
