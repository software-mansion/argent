import { describe, expect, it, vi, beforeEach } from "vitest";
import { FAILURE_CODES, getFailureSignal, Registry } from "@argent/registry";
import { InvalidToolInputError } from "../src/utils/capability";

// Every backend's transport is stubbed, so "did anything reach the device" is
// observable per platform: `pressKey` (simulator-server HID), `adbShell`
// (`adb input`), `dispatchKeyEvent` (CDP), and the vega injectors.
const { adbShell, isAndroidTv } = vi.hoisted(() => ({
  adbShell: vi.fn(async (_serial: string, _cmd: string, _opts?: unknown): Promise<string> => ""),
  isAndroidTv: vi.fn(async (_serial: string): Promise<boolean> => false),
}));
vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  adbShell,
  isAndroidTv,
}));

// The android and vega branches declare `requires: ["adb"]`; stub the preflight
// so these tests don't depend on an adb binary on the host.
vi.mock("../src/utils/check-deps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/check-deps")>()),
  ensureDeps: vi.fn(async (_deps: readonly string[]): Promise<void> => {}),
}));

// The ios branch runtime-probes the TV kind by shelling out to `xcrun`; a real
// probe would make these tests host-dependent (and slow).
vi.mock("../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-devices")>()),
  isTvOsSimulator: vi.fn(async (_udid: string): Promise<boolean> => false),
}));

vi.mock("../src/utils/vega-input", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/vega-input")>()),
  injectVegaText: vi.fn(async () => {}),
  injectVegaNamedKey: vi.fn(async () => {}),
}));

import { injectVegaNamedKey, injectVegaText } from "../src/utils/vega-input";
import { createKeyboardTool } from "../src/tools/keyboard";

const pressKey = vi.fn();
const dispatchKeyEvent = vi.fn(async () => {});

/** A registry whose service resolution hands back both HID and CDP fakes. */
function registry(): Registry {
  const r = new Registry();
  vi.spyOn(r, "resolveService").mockResolvedValue({ pressKey, dispatchKeyEvent } as never);
  return r;
}

// The tool routes by udid SHAPE (see utils/device-info.ts `classifyDevice`), so
// these ids are what pick each backend.
const BACKENDS = [
  {
    platform: "ios",
    udid: "809A848B-1671-4A72-B9C9-B1683D95973E",
    injections: () => pressKey.mock.calls.length,
  },
  { platform: "android", udid: "emulator-5554", injections: () => adbShell.mock.calls.length },
  {
    platform: "chromium",
    udid: "chromium-cdp-9222",
    injections: () => dispatchKeyEvent.mock.calls.length,
  },
  {
    platform: "vega",
    udid: "amazon-4a27df03c9777152",
    injections: () =>
      vi.mocked(injectVegaText).mock.calls.length + vi.mocked(injectVegaNamedKey).mock.calls.length,
  },
];

/** Assert the rejection is the 400-class one the exclusivity rule raises. */
async function expectCombinedRejection(p: Promise<unknown>): Promise<void> {
  const err = await p.then(
    () => {
      throw new Error("expected the combined text+key call to reject, but it resolved");
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(InvalidToolInputError);
  expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_TEXT_AND_KEY_COMBINED);
}

// `text` and `key` in one call had no meaning a caller could rely on: the same
// request reads as "type, then submit" for `key:"enter"` and as "delete, then
// type" for `key:"backspace"`, and each backend had to pick an order (#579). The
// tool now rejects the combination in `execute`, ahead of the platform dispatch,
// so no backend sees the shape and the sequence is expressed as two calls.
describe("keyboard — `text` and `key` are mutually exclusive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAndroidTv.mockResolvedValue(false);
  });

  for (const { platform, udid, injections } of BACKENDS) {
    it(`${platform}: rejects a combined text+key call with nothing injected`, async () => {
      const r = registry();
      await expectCombinedRejection(
        createKeyboardTool(r).execute({}, { udid, text: "hi", key: "enter", delayMs: 0 })
      );
      // Rejected before the dispatch, so the backend is never reached: no keys
      // injected, and not even a service resolved (which would spawn one).
      expect(injections()).toBe(0);
      expect(r.resolveService).not.toHaveBeenCalled();
    });

    // Positive control for the test above — which would otherwise also pass
    // against a harness that cannot reach this backend at all. Both halves run
    // separately here, so a guard widened to reject either one alone turns red.
    it(`${platform}: still injects text alone, and a key alone`, async () => {
      const tool = createKeyboardTool(registry());

      await expect(tool.execute({}, { udid, text: "hi", delayMs: 0 })).resolves.toMatchObject({
        typed: "hi",
      });
      expect(injections()).toBeGreaterThan(0);

      vi.clearAllMocks();
      await expect(tool.execute({}, { udid, key: "enter", delayMs: 0 })).resolves.toMatchObject({
        typed: "enter",
      });
      expect(injections()).toBeGreaterThan(0);
    });
  }

  it("rejects on the request's shape, not on what the values would do", async () => {
    // An empty half still names both parameters. Rejecting it keeps the rule
    // statable as "one or the other" — a truthiness check would instead need an
    // empty-string carve-out documented on both parameters.
    const tool = createKeyboardTool(registry());
    await expectCombinedRejection(
      tool.execute({}, { udid: "emulator-5554", text: "", key: "enter" })
    );
    await expectCombinedRejection(tool.execute({}, { udid: "emulator-5554", text: "hi", key: "" }));
    expect(adbShell).not.toHaveBeenCalled();
  });

  it("rejects before resolving a secret placeholder", async () => {
    // The guard sits above `resolveSecretPlaceholders`, so a combined request
    // never reads an `ARGENT_SECRET_*` value — and the caller gets the error that
    // is actionable instead of one about the unknown placeholder name.
    await expectCombinedRejection(
      createKeyboardTool(registry()).execute(
        {},
        {
          udid: "emulator-5554",
          text: "{{secret:NO_SUCH_SECRET_FOR_THIS_TEST}}",
          key: "enter",
        }
      )
    );
    expect(adbShell).not.toHaveBeenCalled();
  });

  it("names the two-call replacement in the error message", async () => {
    // The message is the whole migration path for an agent that copied the old
    // combined example; without it the only signal is "not both".
    const err = await createKeyboardTool(registry())
      .execute({}, { udid: "emulator-5554", text: "hi", key: "enter" })
      .then(
        () => {
          throw new Error("expected the combined text+key call to reject");
        },
        (e: unknown) => e as Error
      );
    expect(err.message).toMatch(/two calls/);
    expect(err.message).toMatch(/run-sequence/);
  });
});
