import { describe, expect, it, vi, beforeEach } from "vitest";
import { FAILURE_CODES, getFailureSignal, Registry } from "@argent/registry";
import { InvalidToolInputError } from "../src/utils/capability";
import { CLIENT_UNSAFE_TOP_LEVEL_KEYWORDS, advertisedSchema } from "./helpers/catalog";

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

// HarmonyOS reaches the device over `hdc`; stub the transport and report an
// awake panel, so what is pinned here is the exclusivity rule rather than the
// display guard `keyboard-harmony.test.ts` covers.
vi.mock("../src/utils/harmony-uitest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-uitest")>()),
  harmonyTypeText: vi.fn(async () => {}),
  harmonyKeyEvent: vi.fn(async () => {}),
  harmonyDisplay: vi.fn(async () => ({ width: 1216, height: 2688, screenOn: true })),
}));

import { injectVegaNamedKey, injectVegaText } from "../src/utils/vega-input";
import { harmonyKeyEvent, harmonyTypeText } from "../src/utils/harmony-uitest";
import { createKeyboardTool } from "../src/tools/keyboard";
import { NAMED_KEYS } from "../src/tools/keyboard/key-codes";

const pressKey = vi.fn((_direction: "Down" | "Up", _keyCode: number) => {});
// Params typed so `mock.calls[n][0]` is the event, not `never` — vitest transforms
// tests with esbuild, so only `tsc --noEmit` catches an untyped `vi.fn()` here.
const dispatchKeyEvent = vi.fn(async (_event: { type: string; key?: string }) => {});

/** A registry whose service resolution hands back both HID and CDP fakes. */
function registry(): Registry {
  const r = new Registry();
  vi.spyOn(r, "resolveService").mockResolvedValue({ pressKey, dispatchKeyEvent } as never);
  return r;
}

// The tool routes by udid SHAPE (see utils/device-info.ts `classifyDevice`), so
// these ids are what pick each backend. `pressedBackspace` reads the transport
// for the key that was actually asked for: `typed` echoes `params.key` straight
// back, so it would pass a backend that ignored `params.key` and pressed a
// hardcoded Enter.
const BACKENDS = [
  {
    platform: "ios",
    udid: "809A848B-1671-4A72-B9C9-B1683D95973E",
    injections: () => pressKey.mock.calls.length,
    // HID usage 42 = Keyboard DELETE/Backspace (key-codes.ts NAMED_KEYS).
    pressedBackspace: () =>
      pressKey.mock.calls.some((c) => c[0] === "Down" && c[1] === NAMED_KEYS.backspace),
  },
  {
    platform: "android",
    udid: "emulator-5554",
    injections: () => adbShell.mock.calls.length,
    // KEYCODE_DEL = 67.
    pressedBackspace: () => adbShell.mock.calls.some((c) => c[1] === "input keyevent 67"),
  },
  {
    platform: "chromium",
    udid: "chromium-cdp-9222",
    injections: () => dispatchKeyEvent.mock.calls.length,
    pressedBackspace: () => dispatchKeyEvent.mock.calls.some((c) => c[0].key === "Backspace"),
  },
  {
    platform: "vega",
    udid: "amazon-4a27df03c9777152",
    injections: () =>
      vi.mocked(injectVegaText).mock.calls.length + vi.mocked(injectVegaNamedKey).mock.calls.length,
    pressedBackspace: () =>
      vi.mocked(injectVegaNamedKey).mock.calls.some((c) => c[0] === "backspace"),
  },
  {
    platform: "harmony",
    udid: "harmony-025DEK236V035771",
    injections: () =>
      vi.mocked(harmonyTypeText).mock.calls.length + vi.mocked(harmonyKeyEvent).mock.calls.length,
    // `uitest uiInput keyEvent` takes a raw keyID, so the name never leaves the
    // host: 2055 is backspace (keyboard/platforms/harmony.ts HARMONY_KEYCODES).
    pressedBackspace: () => vi.mocked(harmonyKeyEvent).mock.calls.some((c) => c[1] === "2055"),
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

/** Assert the rejection is the 400-class one an unusable `key` value raises. */
async function expectUnsupportedKey(p: Promise<unknown>): Promise<Error> {
  const err = await p.then(
    () => {
      throw new Error("expected the empty-key call to reject, but it resolved");
    },
    (e: unknown) => e as Error
  );
  expect(err).toBeInstanceOf(InvalidToolInputError);
  expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED);
  return err;
}

/** Drive a combined call and hand back the error it rejected with. */
async function combinedError(params: Record<string, unknown>): Promise<Error> {
  return createKeyboardTool(registry())
    .execute({}, { udid: "emulator-5554", ...params } as never)
    .then(
      () => {
        throw new Error("expected the combined text+key call to reject");
      },
      (e: unknown) => e as Error
    );
}

// `text` and `key` in one call had no meaning a caller could rely on: the same
// request reads as "type, then submit" for `key:"enter"` and as "delete, then
// type" for `key:"backspace"`, and each backend had to pick an order (#579). The
// tool now rejects the combination in `execute`, ahead of the platform dispatch,
// so no backend sees the shape and the sequence is expressed as two calls —
// batched into one `run-sequence` when the round-trip matters.
describe("keyboard — `text` and `key` are mutually exclusive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAndroidTv.mockResolvedValue(false);
  });

  for (const { platform, udid, injections, pressedBackspace } of BACKENDS) {
    it(`${platform}: rejects a combined text+key call with nothing injected`, async () => {
      const r = registry();
      await expectCombinedRejection(
        createKeyboardTool(r).execute({}, { udid, text: "hi", key: "enter", delayMs: 0 })
      );
      // Rejected before the dispatch, so the backend is never reached: no keys
      // injected on any of them.
      expect(injections()).toBe(0);
      // Adds signal on ios and chromium only — those resolve a service (and
      // would spawn one) on a call that gets through. Android injects through
      // `adbShell` directly, and neither the vega nor the harmony branch
      // references the registry, so a SUCCESSFUL call resolves nothing there
      // either and this line cannot fail on those iterations. Kept because it
      // holds for every backend and guards the two that can regress;
      // `injections()` above is what carries the other rows.
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
      // `backspace`, not `enter`: it is the key every other backend test also
      // presses, so pressing the one that was ASKED for is what is pinned here.
      await expect(tool.execute({}, { udid, key: "backspace", delayMs: 0 })).resolves.toMatchObject(
        {
          typed: "backspace",
        }
      );
      expect(pressedBackspace(), `${platform} pressed a key other than backspace`).toBe(true);
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

  it("leaves an empty request a no-op rather than requiring one of the two", async () => {
    // The rule is at-most-one, not exactly-one. `{}` stays the documented no-op
    // it was before this guard, so a guard written as "exactly one of text/key"
    // — the natural misreading of the parameter docs — is red here.
    await expect(
      createKeyboardTool(registry()).execute({}, { udid: "emulator-5554" })
    ).resolves.toEqual({ typed: "", keys: 0 });
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

  it("names the run-sequence replacement in the error message", async () => {
    // The message is the whole migration path for an agent that copied the old
    // combined example; without it the only signal is "not both". It has to name
    // `run-sequence` specifically, because that is the form that keeps the two
    // steps in one round-trip and one auto-screenshot.
    const err = await combinedError({ text: "hi", key: "enter" });
    expect(err.message).toMatch(/two `keyboard` steps in one `run-sequence`/);
    // The literal retry, so an agent does not have to infer the split.
    expect(err.message).toMatch(/{ text: "hello" } followed by { key: "enter" }/);
  });

  it("keeps a combined SECRET call inside the one run-sequence", async () => {
    // The two remedies diverge here. The MCP auto-screenshot skip keys off a
    // deep scan of the whole request (argent-mcp `containsSecretPlaceholder`),
    // and `run-sequence` is itself in `AUTO_SCREENSHOT_TOOLS` — so the combined
    // call and the one-run-sequence form both skip, while of two bare calls only
    // the first does. The second, `{ key: "enter" }`, carries no placeholder and
    // is screenshotted AFTER the key lands, handing the still-visible secret
    // back as pixels. So the message has to say not just what to use but what
    // NOT to fall back to.
    const err = await combinedError({ text: "{{secret:APP_PASSWORD}}", key: "enter" });
    expect(err.message).toMatch(/ONE `run-sequence`/);
    expect(err.message).toMatch(/still-visible secret/);
    // Still resolves nothing: the steer is a syntactic `.includes` on the
    // placeholder, above `resolveSecretPlaceholders`, so an unset name does not
    // turn this into an "unknown secret" error.
    expect(adbShell).not.toHaveBeenCalled();
  });

  it("leaves the secret steer out of a plain combined call", async () => {
    // Positive control for the test above: the secret sentence is specific to a
    // placeholder-bearing request, so a plain one must not carry it — an
    // unconditional sentence would pass that test while warning every caller
    // about a secret they did not send.
    const err = await combinedError({ text: "hi", key: "enter" });
    expect(err.message).not.toMatch(/still-visible secret/);
  });

  it("still names the TV constraint the guard pre-empts", async () => {
    // On a TV target `key` is rejected outright (platforms/tv.ts), so the second
    // step this message prescribes — `{ key: "enter" }` — is a retry that cannot
    // succeed there. Before the guard existed, a combined call on a TV got that
    // diagnosis from the backend; the guard runs above the dispatch
    // (deliberately, so nothing reaches a device) and would otherwise swallow it.
    //
    // The caveat is therefore carried statically, not by probing the target —
    // distinguishing a TV kind is async. So this assertion holds for a phone
    // udid too; what it pins is that the sentence survives edits to the message.
    // The TV target is driven here because it is the shape that needs it.
    isAndroidTv.mockResolvedValue(true);
    const err = await combinedError({ text: "hi", key: "enter" });
    expect(err.message).toMatch(/TV target/);
    expect(err.message).toMatch(/tv-remote/);
  });
});

// This tool decides `key` by presence, every backend dispatches it by
// truthiness (`if (params.key)`). So `{ key: "" }` used to clear both checks,
// reach a backend, press nothing, and still resolve `{ typed: "", keys: 0 }` —
// indistinguishable from a real press, while the tool description promises a
// failure for an unsupported key name, which `""` is. It is now rejected in
// `execute`, above the dispatch, so one guard covers every backend.
describe("keyboard — an empty `key` names no key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAndroidTv.mockResolvedValue(false);
  });

  for (const { platform, udid, injections } of BACKENDS) {
    it(`${platform}: rejects { key: "" } with nothing injected`, async () => {
      await expectUnsupportedKey(
        createKeyboardTool(registry()).execute({}, { udid, key: "", delayMs: 0 })
      );
      expect(injections()).toBe(0);
    });
  }

  it("rejects it on a TV target too", async () => {
    // The one backend that rejects `key` outright (platforms/tv.ts) read the
    // empty one by truthiness as well, so it typed `""` and reported success
    // instead. Its own rejection can therefore never be what covers this shape.
    isAndroidTv.mockResolvedValue(true);
    await expectUnsupportedKey(
      createKeyboardTool(registry()).execute({}, { udid: "emulator-5554", key: "" })
    );
  });

  it("leaves an empty `text` the no-op an omitted one is", async () => {
    // Positive control, and the asymmetry the guard is built on: `key` names one
    // member of a closed set, `text` carries a payload. A guard widened to
    // "reject either empty value" turns this red.
    await expect(
      createKeyboardTool(registry()).execute({}, { udid: "emulator-5554", text: "", delayMs: 0 })
    ).resolves.toEqual({ typed: "", keys: 0 });
    expect(adbShell).not.toHaveBeenCalled();
  });

  it("tells the caller nothing was pressed, and names omitting `key`", async () => {
    // A caller that sent `""` usually built the value from something absent, so
    // the actionable repair is to drop the parameter — not to guess at a name.
    const err = await expectUnsupportedKey(
      createKeyboardTool(registry()).execute({}, { udid: "emulator-5554", key: "" })
    );
    expect(err.message).toMatch(/nothing was pressed/);
    expect(err.message).toMatch(/omit `key`/);
  });
});

// The rule is enforced in `execute`, so a client that only ever calls the tool
// learns it from a 400. A client that validates arguments against the advertised
// schema, or constrains generation from it, never gets that far — and for this
// tool the schema CANNOT carry the rule: `not` is one of the top-level keywords
// #782 banned repo-wide, because the Messages API rejects a request whose tool
// schemas declare one and that 400 fails every tool in the request.
//
// Prose is therefore the only channel the constraint has, which makes the two
// `.describe()` texts load-bearing rather than decorative.
describe("keyboard — how the constraint reaches a client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAndroidTv.mockResolvedValue(false);
  });

  it("leaves both halves optional in the advertised schema", () => {
    const schema = advertisedSchema(createKeyboardTool(registry()))!;
    expect(schema.type).toBe("object");
    const required = schema.required as string[];
    expect(required).toEqual(["udid"]);
  });

  it("does not try to encode the rule as a top-level combinator", () => {
    // The tempting repair for the gap above, and the one that breaks every
    // other tool in the same request. tool-input-schema-contract.test.ts holds
    // this for the whole catalog; it is restated here because this tool is the
    // one with a live cross-field rule and therefore the standing temptation.
    const schema = advertisedSchema(createKeyboardTool(registry()))!;
    expect(CLIENT_UNSAFE_TOP_LEVEL_KEYWORDS.filter((keyword) => keyword in schema)).toEqual([]);
  });

  it("states the constraint on `text` too, not only on `key`", () => {
    // A caller reading only the parameter it is filling in must still see the
    // rule; `boot-device` restates its exactly-one check in all four fields for
    // the same reason. Both texts also name the remedy, since a constraint
    // without one just moves the caller from a wrong call to a stuck one.
    const { text, key } = createKeyboardTool(registry()).zodSchema!.shape;
    expect(text.description).toMatch(/Cannot be combined with `key`/);
    expect(text.description).toMatch(/run-sequence/);
    expect(key.description).toMatch(/Cannot be combined with `text`/);
    expect(key.description).toMatch(/run-sequence/);
  });

  it("accepts and rejects exactly the shapes the docs describe", async () => {
    // The runtime table the prose above stands for. Without it "text OR key"
    // is only ever asserted one shape at a time, and the neither/empty-half
    // corners are where a rewritten guard drifts.
    const tool = createKeyboardTool(registry());
    const shapes: Array<[args: Record<string, unknown>, rejected: boolean]> = [
      [{ text: "hi" }, false],
      [{ key: "enter" }, false],
      [{}, false], // neither is required — an empty request is a documented no-op
      [{ text: "" }, false], // a payload: an empty one means what omitting it means
      [{ key: "" }, true], // a name, and there is no key called ""
      [{ text: "hi", key: "enter" }, true],
      [{ text: "", key: "" }, true], // shape, not truthiness
    ];

    for (const [args, rejected] of shapes) {
      vi.clearAllMocks();
      const outcome = await tool.execute({}, { udid: "emulator-5554", ...args } as never).then(
        () => false,
        () => true
      );
      expect(outcome, `runtime disagrees on ${JSON.stringify(args)}`).toBe(rejected);
    }
  });
});
