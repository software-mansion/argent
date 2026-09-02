import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, getFailureSignal, Registry } from "@argent/registry";
import { InvalidToolInputError } from "../src/utils/capability";
import { CLIENT_UNSAFE_TOP_LEVEL_KEYWORDS, advertisedSchema } from "./helpers/catalog";
import { CLEAR_KEY_PAIRS } from "../src/tools/keyboard/key-codes";

// Every backend's transport is stubbed, so "did anything reach the device" is
// observable per platform: `pressKey` (simulator-server HID), `adbShell`
// (`adb input`), `dispatchKeyEvent` / `evaluate` (CDP), and the vega injectors.
const { adbShell, isAndroidTv, getAndroidRuntimeKind } = vi.hoisted(() => ({
  adbShell: vi.fn(async (_serial: string, _cmd: string, _opts?: unknown): Promise<string> => ""),
  isAndroidTv: vi.fn(async (_serial: string): Promise<boolean> => false),
  // The keyboard branch reads the kind three-valued (`undefined` = "could not
  // tell"), so an indeterminate probe cannot fall through to the phone path and
  // burst 200 delete keys at a TV. Kept in step with `isAndroidTv` so the
  // existing cases still say what they meant.
  getAndroidRuntimeKind: vi.fn(
    async (_serial: string): Promise<"mobile" | "tv" | undefined> => "mobile"
  ),
}));
vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  adbShell,
  isAndroidTv,
  getAndroidRuntimeKind,
}));

// The android and vega branches declare `requires: ["adb"]`; stub the preflight
// so these tests don't depend on an adb binary on the host.
vi.mock("../src/utils/check-deps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/check-deps")>()),
  ensureDeps: vi.fn(async (_deps: readonly string[]): Promise<void> => {}),
}));

// The ios branch runtime-probes the TV kind by shelling out to `xcrun`; a real
// probe would make these tests host-dependent (and slow). `getSimulatorRuntimeKind`
// is the one the keyboard backend reads — three-valued, because an unknown kind
// refuses a clear rather than aiming it — so leaving it real made every iOS case
// here depend on whether the host's `simctl` happens to list this UDID.
vi.mock("../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-devices")>()),
  isTvOsSimulator: vi.fn(async (_udid: string): Promise<boolean> => false),
  getSimulatorRuntimeKind: vi.fn(
    async (_udid: string): Promise<"mobile" | "tv" | undefined> => "mobile"
  ),
}));

vi.mock("../src/utils/vega-input", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/vega-input")>()),
  injectVegaText: vi.fn(async () => {}),
  injectVegaNamedKey: vi.fn(async () => {}),
  injectVegaClear: vi.fn(async () => {}),
}));

import { injectVegaClear, injectVegaNamedKey, injectVegaText } from "../src/utils/vega-input";
import { createKeyboardTool } from "../src/tools/keyboard";
import { NAMED_KEYS } from "../src/tools/keyboard/key-codes";

const pressKey = vi.fn((_direction: "Down" | "Up", _keyCode: number) => {});
// Params typed so `mock.calls[n][0]` is the event, not `never` — vitest transforms
// tests with esbuild, so only `tsc --noEmit` catches an untyped `vi.fn()` here.
const dispatchKeyEvent = vi.fn(async (_event: { type: string; key?: string }) => {});
// The chromium `clear` transport: it dispatches no key events at all, so
// `dispatchKeyEvent` alone cannot see it reach the renderer.
const evaluate = vi.fn(async (_expression: string, _opts?: unknown) => ({ cleared: true }));

/** A registry whose service resolution hands back both HID and CDP fakes. */
function registry(): Registry {
  const r = new Registry();
  vi.spyOn(r, "resolveService").mockResolvedValue({
    pressKey,
    dispatchKeyEvent,
    evaluate,
  } as never);
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
    clears: true,
  },
  {
    platform: "android",
    udid: "emulator-5554",
    injections: () => adbShell.mock.calls.length,
    // KEYCODE_DEL = 67.
    pressedBackspace: () => adbShell.mock.calls.some((c) => c[1] === "input keyevent 67"),
    clears: true,
  },
  {
    platform: "chromium",
    udid: "chromium-cdp-9222",
    // `evaluate` counts too: a chromium `clear` sends no key events, so a
    // counter over `dispatchKeyEvent` alone would read zero for a clear that
    // did reach the renderer — and every "nothing was injected" assertion below
    // would then pass vacuously for the clear shapes.
    injections: () => dispatchKeyEvent.mock.calls.length + evaluate.mock.calls.length,
    pressedBackspace: () => dispatchKeyEvent.mock.calls.some((c) => c[0].key === "Backspace"),
    clears: true,
  },
  {
    platform: "vega",
    udid: "amazon-4a27df03c9777152",
    // The clear counts as an injection too: a rejected combined call must not
    // burst delete keys either, and without it the "injecting nothing" half of
    // the two rejections below is blind to the one shape they are about.
    injections: () =>
      vi.mocked(injectVegaText).mock.calls.length +
      vi.mocked(injectVegaNamedKey).mock.calls.length +
      vi.mocked(injectVegaClear).mock.calls.length,
    pressedBackspace: () =>
      vi.mocked(injectVegaNamedKey).mock.calls.some((c) => c[0] === "backspace"),
    clears: true,
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
//
// `clear` is under the same rule, and there the ambiguity is worse: `{ clear,
// text }` reads as "replace the value" only if the clear runs first, and a
// backend that ordered it the other way would delete what it had just typed.
// Keeping it one-action-per-call is also what lets the clear be a blind burst —
// a combined shape would need the whole request pre-validated and focus loss
// between the two halves detected.
describe("keyboard — `text`, `key` and `clear` are mutually exclusive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAndroidTv.mockResolvedValue(false);
    getAndroidRuntimeKind.mockResolvedValue("mobile");
  });

  for (const { platform, udid, injections, pressedBackspace, clears } of BACKENDS) {
    it(`${platform}: rejects a combined text+key call with nothing injected`, async () => {
      const r = registry();
      await expectCombinedRejection(
        createKeyboardTool(r).execute({}, { udid, text: "hi", key: "enter", delayMs: 0 })
      );
      // Rejected before the dispatch, so the backend is never reached: no keys
      // injected on any of the four.
      expect(injections()).toBe(0);
      // Adds signal on ios and chromium only — those resolve a service (and
      // would spawn one) on a call that gets through. Android injects through
      // `adbShell` directly and the vega branch never references the registry,
      // so a SUCCESSFUL call resolves nothing there either and this line cannot
      // fail on those two iterations. Kept because it holds for all four and
      // guards the two that can regress; `injections()` above is what carries
      // the android and vega rows.
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

    // `clear` is the third arm of the same rule, and the one a backend could
    // still honour after the guard rejected the request — every backend reads
    // it by `=== true` in its own handler, so a guard that counted only
    // `text`/`key` would let `{ text, clear: true }` through to a device.
    it.each([
      ["text", { text: "hi" }],
      ["key", { key: "enter" }],
    ])(`${platform}: rejects clear combined with %s, injecting nothing`, async (_l, other) => {
      const r = registry();
      await expectCombinedRejection(
        createKeyboardTool(r).execute({}, { udid, clear: true, ...other, delayMs: 0 } as never)
      );
      expect(injections()).toBe(0);
      expect(r.resolveService).not.toHaveBeenCalled();
    });

    if (clears) {
      // Positive control for the two rejections above: without it they would
      // also pass against a backend that cannot clear at all.
      it(`${platform}: still clears when \`clear\` is the only action`, async () => {
        await expect(
          createKeyboardTool(registry()).execute({}, { udid, clear: true } as never)
        ).resolves.toMatchObject({ typed: "", cleared: true });
        expect(injections()).toBeGreaterThan(0);
      });
    }
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

  it("names the clear-then-retype replacement, not only the type-then-submit one", async () => {
    // The two combinations have DIFFERENT remedies and an agent reaching this
    // message is holding one of them. A message that only showed the
    // type-then-submit split would leave a `{ clear, text }` caller to infer
    // the order — and the wrong order deletes what it just typed.
    const err = await combinedError({ text: "hi", clear: true });
    expect(err.message).toMatch(/{ clear: true } followed by { text: "hello" }/);
    // ...and it says which parameters the offending request actually carried,
    // so a caller that built the arguments programmatically can see which one
    // to drop.
    expect(err.message).toMatch(/carries `text` and `clear`/);
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
    getAndroidRuntimeKind.mockResolvedValue("tv");
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
describe("keyboard — the burst size an agent is told about", () => {
  it("quotes the same numbers the constant produces, in every caller-facing string", () => {
    // `CLEAR_KEY_PAIRS` reaches callers as a LITERAL in the tool description, the
    // `clear` parameter description, two runtime failure messages, the
    // device-interact skill and the docs — changing the constant makes all of
    // them lie, and only keyboard-backend-fidelity.test.ts pins the number
    // itself. This is the check that the prose agrees with the code: the two
    // runtime messages now interpolate it, and the descriptions are asserted
    // against it here.
    const tool = createKeyboardTool(registry());
    const pairs = String(CLEAR_KEY_PAIRS);
    const total = String(CLEAR_KEY_PAIRS * 2);
    const description = tool.description ?? "";
    const properties = (advertisedSchema(tool)?.properties ?? {}) as Record<
      string,
      { description?: string }
    >;
    const clearParam = properties.clear?.description ?? "";

    for (const [label, text] of [
      ["tool description", description],
      ["`clear` parameter", clearParam],
    ] as const) {
      // "100 backspaces interleaved with 100 forward-deletes" and "`keys` is 200"
      // are the two claims; both numbers have to be the constant's.
      expect(text, label).toContain(`${pairs} backspaces`);
      expect(text, label).toContain(`${pairs} forward-deletes`);
      expect(text, label).toContain(total);
      // Vega is the one backend with no forward delete, so its burst is the
      // DOUBLE — a third number off the same constant, and the one a caller
      // would otherwise read as the per-side bound.
      expect(text, label).toContain(`${total} backspaces`);
    }
  });
});

describe("keyboard — the exclusivity message's platform caveats", () => {
  it("keeps the `key` caveat, and no longer talks a caller out of the clear", () => {
    // The message prescribes splitting into `{ clear: true }` then `{ text }`,
    // and used to add that a TV or a Vega VVD rejects the `clear` half — which
    // would now send a caller to the app's on-screen keyboard for a burst that
    // works. `key` is the half that IS still refused on a TV, and following the
    // split with one there is a retry that cannot succeed, so that caveat stays.
    return combinedError({ clear: true, text: "hello" }).then((err) => {
      expect(err.message).toMatch(/`key` is not supported at all/);
      expect(err.message).toMatch(/`clear` works on every target except a REMOTE Apple TV/);
      expect(err.message).not.toMatch(/On Vega/);
    });
  });
});

describe("keyboard — one device is driven by one call at a time", () => {
  // Its own serial: the queue is per device and module-level, so sharing one
  // with the rest of the file would let an unrelated test's call decide the
  // order these assert on.
  const udid = "emulator-5599";

  beforeEach(() => {
    vi.clearAllMocks();
    isAndroidTv.mockResolvedValue(false);
    getAndroidRuntimeKind.mockResolvedValue("mobile");
  });

  afterEach(() => {
    adbShell.mockImplementation(async () => "");
  });

  it("serializes concurrent calls per device instead of interleaving them", async () => {
    // Both `keyboard` and `paste` write to whatever holds keyboard focus, over
    // several unserialized steps each — and `clear` widens that window from one
    // keystroke to 700ms on iOS and 2-90s on Android. Measured on a booted
    // simulator with a 250-character field: `{ clear: true }` and, 200ms later,
    // `{ text: "HELLO" }` left `…aaaaaaaaaaLO` — "HEL" eaten by backspaces still
    // in flight — with BOTH calls reporting success. One tool-server is shared
    // by every agent session on the machine, so two sessions at one device is
    // the documented default, not an exotic case.
    //
    // Interleaving is observable as an overlap: each call marks the transport on
    // entry and on exit, and a second entry before the first exit is the bug.
    const tool = createKeyboardTool(registry());
    const order: string[] = [];
    adbShell.mockImplementation(async (_serial: string, cmd: string) => {
      const tag = cmd.startsWith("input keyevent") ? "clear" : "text";
      order.push(`${tag}:in`);
      await new Promise((r) => setTimeout(r, 40));
      order.push(`${tag}:out`);
      return "";
    });

    const clearing = tool.execute({}, { udid, clear: true } as never);
    await new Promise((r) => setTimeout(r, 5));
    const typing = tool.execute({}, { udid, text: "HELLO" } as never);
    await Promise.all([clearing, typing]);

    expect(order).toEqual(["clear:in", "clear:out", "text:in", "text:out"]);
  });

  it("rejects a malformed request immediately, not behind the queue", async () => {
    // The exclusivity and empty-`key` guards are pure validation of the request
    // shape. Queueing them would make a caller's own mistake wait out another
    // session's 90s burst before it was told about it.
    const tool = createKeyboardTool(registry());
    let release = () => {};
    adbShell.mockImplementation(
      async () =>
        new Promise<string>((resolve) => {
          release = () => resolve("");
        })
    );
    const blocking = tool.execute({}, { udid, clear: true } as never);
    await new Promise((r) => setTimeout(r, 5));

    await expectCombinedRejection(tool.execute({}, { udid, text: "a", key: "enter" } as never));
    await expectUnsupportedKey(tool.execute({}, { udid, key: "" } as never));

    release();
    await blocking;
  });

  it("rejects an unknown secret immediately, not behind the queue", async () => {
    // Same rule, third guard: a `{{secret:NAME}}` no source defines reaches no
    // device and its repair is to define the secret, so it is a request error
    // like the two shape guards — and it was the one left inside the queue,
    // waiting out another session's burst before saying so. `paste` has always
    // resolved outside it.
    const tool = createKeyboardTool(registry());
    let release = () => {};
    adbShell.mockImplementation(
      async () =>
        new Promise<string>((resolve) => {
          release = () => resolve("");
        })
    );
    const blocking = tool.execute({}, { udid, clear: true } as never);
    await new Promise((r) => setTimeout(r, 5));

    const err = await tool
      .execute({}, { udid, text: "{{secret:NO_SUCH_SECRET_FOR_TESTS}}" } as never)
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.SECRET_PLACEHOLDER_UNKNOWN);

    release();
    await blocking;
  });
});

describe("keyboard — the MCP adapter must not re-send a slow call", () => {
  it("is declared longRunning, so a call outrunning 30s is not aborted and retried", () => {
    // Without this the adapter caps each `keyboard` fetch at 30s and
    // `fetchWithReconnect` retries on ANY error — its own AbortError included —
    // so ONE slow call became up to five CONCURRENT invocations at the same
    // device. Measured through the real stdio adapter against a 40s call: five
    // overlapping `toolInvoked keyboard` entries, `isError: true` /
    // "This operation was aborted" after 154s, and a field holding what the
    // surplus attempts left rather than what the caller asked for.
    //
    // Two shapes of this tool reach 30s: an Android `clear` (200
    // `input keyevent` injections under a 90s budget — 14.9s measured against a
    // debug Flutter field) and any `text` paced with `delayMs`.
    expect(createKeyboardTool(registry()).longRunning).toBe(true);
  });
});

describe("keyboard — an empty `key` names no key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAndroidTv.mockResolvedValue(false);
    getAndroidRuntimeKind.mockResolvedValue("mobile");
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
    getAndroidRuntimeKind.mockResolvedValue("tv");
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
    getAndroidRuntimeKind.mockResolvedValue("mobile");
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
    expect(text.description).toMatch(/Cannot be combined with `key` or `clear`/);
    expect(text.description).toMatch(/run-sequence/);
    expect(key.description).toMatch(/Cannot be combined with `text` or `clear`/);
    expect(key.description).toMatch(/run-sequence/);
  });

  it("advertises `clear` as a parameter at all", () => {
    // `required` above is the only other schema assertion, and it passes just
    // as well for a tool that never advertised `clear` — a caller reading the
    // schema would then never learn the parameter exists.
    const schema = advertisedSchema(createKeyboardTool(registry()))!;
    const properties = schema.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining(["udid", "text", "key", "clear", "delayMs"])
    );
    expect((properties.clear as { type?: string }).type).toBe("boolean");
  });

  it("states on `clear` what a caller cannot learn anywhere else", () => {
    // `clear` is the only parameter whose behaviour DIFFERS by platform, and the
    // only destructive one — so its prose is the whole contract for four things
    // a caller has no other way to know. Replacing it with a one-liner leaves
    // every other assertion in the suite green.
    const { clear } = createKeyboardTool(registry()).zodSchema!.shape;
    const description = clear.description!;
    // The exclusivity rule, restated here as on the other two.
    expect(description).toMatch(/Cannot be combined with `text` or `key`/);
    // Focus is the precondition, and it is the caller's job — including on the
    // targets where it is not a tap.
    expect(description).toMatch(/Focus the field first/);
    expect(description).toMatch(/tv-remote/);
    // The mobile bound: a longer field keeps its remainder, and the repair is a
    // second call — not "it failed".
    expect(description).toMatch(/100 backspaces/);
    expect(description).toMatch(/keeps the remainder/);
    // The two backends answer `cleared` on different evidence, which decides
    // whether a caller has to assert the field itself.
    expect(description).toMatch(/read the field back|reads the field back/i);
    // The one target that refuses it, named as narrowly as it actually is: a
    // caveat still saying "TV targets" would talk a caller out of a clear that
    // works on every local Apple TV and Android TV.
    expect(description).toMatch(/REMOTE Apple TV/);
    expect(description).not.toMatch(/Not supported on TV targets/);
    // `false` is legal and inert — the shape the guard admits.
    expect(description).toMatch(/`false` means the same as omitting it/);
  });

  it("gives each combined shape a message about the fields it actually carries", async () => {
    // The message names the combination, so a caller can see which of its two
    // arguments to drop. Only `{ text, key }` was asserted at message level;
    // the other two, and the three-way join, are where the wording drifts.
    const tool = createKeyboardTool(registry());
    const message = async (args: Record<string, unknown>): Promise<string> =>
      tool.execute({}, { udid: "emulator-5554", ...args } as never).then(
        () => {
          throw new Error(`expected ${JSON.stringify(args)} to reject, but it resolved`);
        },
        (e: unknown) => (e as Error).message
      );
    expect(await message({ text: "hi", key: "enter" })).toMatch(/carries `text` and `key`/);
    expect(await message({ text: "hi", clear: true })).toMatch(/carries `text` and `clear`/);
    expect(await message({ key: "enter", clear: true })).toMatch(/carries `key` and `clear`/);
    expect(await message({ text: "hi", key: "enter", clear: true })).toMatch(
      /carries `text` and `key` and `clear`/
    );
  });

  it("separates the three combinations by failure_stage, sharing one code", async () => {
    // Reusing the CODE is the disclosed decision — one telemetry bucket for
    // every misuse of the exclusivity rule. A single STAGE would make
    // clear-misuse unmeasurable next to the older text+key case it is not.
    const tool = createKeyboardTool(registry());
    const stage = async (args: Record<string, unknown>): Promise<string | undefined> =>
      tool.execute({}, { udid: "emulator-5554", ...args } as never).then(
        () => {
          throw new Error(`expected ${JSON.stringify(args)} to reject, but it resolved`);
        },
        (e: unknown) => getFailureSignal(e)?.failure_stage
      );
    const stages = [
      await stage({ text: "hi", key: "enter" }),
      await stage({ text: "hi", clear: true }),
      await stage({ key: "enter", clear: true }),
      await stage({ text: "hi", key: "enter", clear: true }),
    ];
    // Pinned by VALUE, in the order the shapes are driven above. Distinctness
    // alone left each name free and, worse, each shape-to-stage MAPPING free:
    // swap the two two-field branches of the ternary and the bucket a client's
    // telemetry lands in changes with nothing going red. Three of these four
    // occur exactly once in the repo — at their production site — and
    // `failure_stage` is an unconstrained string.
    expect(stages).toEqual([
      "keyboard_text_and_key_combined",
      "keyboard_text_and_clear_combined",
      "keyboard_key_and_clear_combined",
      "keyboard_text_key_and_clear_combined",
    ]);
  });

  it("does not send a caller after a key it never asked for", () => {
    // `{ key: "", clear: true }` is rejected on shape, and the split the message
    // prescribes is `{ key: "enter" }` — a key the caller never named, whose
    // retry then fails with KEYBOARD_KEY_UNSUPPORTED. The message has to say so.
    const tool = createKeyboardTool(registry());
    return tool.execute({}, { udid: "emulator-5554", key: "", clear: true } as never).then(
      () => {
        throw new Error("expected the call to reject, but it resolved");
      },
      (e: unknown) => {
        expect((e as Error).message).toMatch(/`key` is an empty string/);
        expect((e as Error).message).toMatch(/drop `key` from the request/);
      }
    );
  });

  it("explains the secret hazard of the shape the request actually carries", () => {
    // The note exists because one `run-sequence` and two bare calls are NOT
    // equivalent once the text holds a placeholder. Hard-coded to the
    // type-then-submit split, it explained a later Enter that a
    // `{ clear, text }` request does not have.
    const tool = createKeyboardTool(registry());
    return tool
      .execute({}, {
        udid: "emulator-5554",
        clear: true,
        text: "{{secret:APP_PASSWORD}}",
      } as never)
      .then(
        () => {
          throw new Error("expected the call to reject, but it resolved");
        },
        (e: unknown) => {
          const message = (e as Error).message;
          expect(message).toMatch(/placeholder/);
          expect(message).toMatch(/releases the device's keyboard queue/);
          expect(message).not.toMatch(/after the key lands/);
          // The hazard it used to name was not one the prescribed split has:
          // the order is `{ clear }` then `{ text }`, so the clear runs BEFORE
          // the secret exists and its screenshot cannot capture one. The figure
          // was wrong too — the burst clears 100 characters per side, not 200,
          // on four of the five key backends.
          expect(message).not.toMatch(/200 presses/);
          expect(message).not.toMatch(/held a longer secret/);
        }
      );
  });

  it("accepts and rejects exactly the shapes the docs describe", async () => {
    // The runtime table the prose above stands for. Without it "text OR key"
    // is only ever asserted one shape at a time, and the neither/empty-half
    // corners are where a rewritten guard drifts.
    const tool = createKeyboardTool(registry());
    const shapes: Array<[args: Record<string, unknown>, rejected: boolean]> = [
      [{ text: "hi" }, false],
      [{ key: "enter" }, false],
      [{ clear: true }, false],
      [{}, false], // none is required — an empty request is a documented no-op
      [{ text: "" }, false], // a payload: an empty one means what omitting it means
      [{ key: "" }, true], // a name, and there is no key called ""
      // `clear` is a switch, not a payload: `false` means what omitting it
      // means, so it neither acts nor collides. A guard written over presence
      // (`params.clear !== undefined`), the natural symmetry with `text`, turns
      // these three red.
      [{ clear: false }, false],
      [{ text: "hi", clear: false }, false],
      [{ key: "enter", clear: false }, false],
      [{ text: "hi", key: "enter" }, true],
      [{ text: "hi", clear: true }, true],
      [{ key: "enter", clear: true }, true],
      [{ text: "hi", key: "enter", clear: true }, true],
      [{ text: "", key: "" }, true], // shape, not truthiness
      [{ text: "", clear: true }, true], // ...and an empty payload still names `text`
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
