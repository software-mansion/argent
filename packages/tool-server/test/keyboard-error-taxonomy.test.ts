import { describe, it, expect, vi } from "vitest";
import {
  Registry,
  FAILURE_CODES,
  FailureError,
  getFailureSignal,
  type DeviceInfo,
} from "@argent/registry";
import { InvalidToolInputError, UnsupportedOperationError } from "../src/utils/capability";
import { typeTv } from "../src/tools/keyboard/platforms/tv";
import { vegaImpl } from "../src/tools/keyboard/platforms/vega";
import { typeSimulatorServer } from "../src/tools/keyboard/simulator-server-keys";
import { makeChromiumImpl } from "../src/tools/keyboard/platforms/chromium";
import { createKeyboardTool } from "../src/tools/keyboard";
import { injectVegaNamedKey, injectVegaText } from "../src/utils/vega-input";
import { injectAndroidNamedKey, injectAndroidText } from "../src/utils/android-input";

// The `keyboard` tool's `key` is a free `z.string()` and its `text` is a free
// string, so an unknown named key or an un-typeable character passes zod
// validation but is a *caller* mistake, not an internal fault. The HTTP layer
// maps InvalidToolInputError → 400 and anything else → 500. Before this, the
// non-Android backends threw a plain `Error` (pre-#420) / a `FailureError`
// (post-#420) — both surfaced as 500, so `key: "pageup"` returned 400 on Android
// but 500 on iOS / chromium / vega (hubgan review). These pins keep every
// keyboard backend's input-rejection uniform: a 400-mapping InvalidToolInputError
// that STILL carries #420's granular telemetry code (the 400 mapping keys off the
// error class, not the code — see InvalidToolInputError in utils/capability.ts).

/** Assert the error is a 400-class input error carrying the given telemetry code. */
async function expectInvalidInput(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => {
      throw new Error("expected the call to reject, but it resolved");
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(InvalidToolInputError);
  expect(getFailureSignal(err)?.error_code).toBe(code);
}

function iosRegistry(): Registry {
  const registry = new Registry();
  vi.spyOn(registry, "resolveService").mockResolvedValue({ pressKey: vi.fn() } as never);
  return registry;
}
function chromiumRegistry(): Registry {
  const registry = new Registry();
  vi.spyOn(registry, "resolveService").mockResolvedValue({
    dispatchKeyEvent: vi.fn(async () => {}),
  } as never);
  return registry;
}
const iosDevice = { id: "AAAA", platform: "ios", kind: "simulator" } as unknown as DeviceInfo;
const chromiumDevice = {
  id: "chromium-cdp-9222",
  platform: "chromium",
  kind: "app",
} as unknown as DeviceInfo;

describe("keyboard backends — input rejection is a 400 with a uniform telemetry taxonomy", () => {
  it("iOS: unknown key → 400 + KEYBOARD_KEY_UNSUPPORTED", async () => {
    await expectInvalidInput(
      typeSimulatorServer(iosRegistry(), iosDevice, { udid: iosDevice.id, key: "pageup" }),
      FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED
    );
  });

  it("iOS: un-typeable character → 400 + KEYBOARD_CHARACTER_UNSUPPORTED", async () => {
    await expectInvalidInput(
      typeSimulatorServer(iosRegistry(), iosDevice, { udid: iosDevice.id, text: "😀" }),
      FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED
    );
  });

  it("chromium: unknown key → 400 + KEYBOARD_KEY_UNSUPPORTED", async () => {
    const impl = makeChromiumImpl(chromiumRegistry());
    await expectInvalidInput(
      impl.handler({}, { udid: chromiumDevice.id, key: "pageup" }, chromiumDevice),
      FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED
    );
  });

  it("chromium: un-typeable character → 400 + KEYBOARD_CHARACTER_UNSUPPORTED", async () => {
    const impl = makeChromiumImpl(chromiumRegistry());
    await expectInvalidInput(
      impl.handler({}, { udid: chromiumDevice.id, text: "😀" }, chromiumDevice),
      FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED
    );
  });

  it("vega: unknown key → 400 + KEYBOARD_KEY_UNSUPPORTED", async () => {
    await expectInvalidInput(injectVegaNamedKey("pageup"), FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED);
  });

  it("vega: newline in text → 400 + VEGA_TEXT_INVALID", async () => {
    await expectInvalidInput(injectVegaText("a\nb"), FAILURE_CODES.VEGA_TEXT_INVALID);
  });

  it("android: unknown key → 400 + KEYBOARD_KEY_UNSUPPORTED", async () => {
    // adbShell is never reached — the unknown key is rejected before injection.
    await expectInvalidInput(
      injectAndroidNamedKey("emulator-5554", "pageup"),
      FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED
    );
  });

  it("android: un-typeable character → 400 + KEYBOARD_CHARACTER_UNSUPPORTED", async () => {
    // Same granular bucket as the iOS/chromium un-typeable-character
    // rejections above — not the generic TOOL_INPUT_INVALID (hubgan review).
    // adbShell is never reached: the guard rejects before injection.
    await expectInvalidInput(
      injectAndroidText("emulator-5554", "café"),
      FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED
    );
  });

  it("android: newline in text → 400 + KEYBOARD_CHARACTER_UNSUPPORTED", async () => {
    // A newline is a character this backend can't type, so it buckets with the
    // un-typeable-character rejections.
    await expectInvalidInput(
      injectAndroidText("emulator-5554", "a\nb"),
      FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED
    );
  });

  // `key` is a free string, so a prototype-chain name ("constructor",
  // "__proto__", …) must be rejected as an unknown key on every backend rather
  // than slipping through an object lookup with a garbage value and going over
  // the wire as a broken press. Pin the 400 + KEYBOARD_KEY_UNSUPPORTED bucket
  // for a representative prototype key on each backend.
  it("iOS: prototype-chain key name → 400 + KEYBOARD_KEY_UNSUPPORTED", async () => {
    await expectInvalidInput(
      typeSimulatorServer(iosRegistry(), iosDevice, { udid: iosDevice.id, key: "constructor" }),
      FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED
    );
  });

  it("chromium: prototype-chain key name → 400 + KEYBOARD_KEY_UNSUPPORTED", async () => {
    const impl = makeChromiumImpl(chromiumRegistry());
    await expectInvalidInput(
      impl.handler({}, { udid: chromiumDevice.id, key: "constructor" }, chromiumDevice),
      FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED
    );
  });

  it("vega: prototype-chain key name → 400 + KEYBOARD_KEY_UNSUPPORTED", async () => {
    await expectInvalidInput(
      injectVegaNamedKey("constructor"),
      FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED
    );
  });

  it("android: prototype-chain key name → 400 + KEYBOARD_KEY_UNSUPPORTED", async () => {
    await expectInvalidInput(
      injectAndroidNamedKey("emulator-5554", "constructor"),
      FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED
    );
  });
});

// `clear` adds two rejection shapes of its own, and they are deliberately
// different classes. A target that cannot clear at all is a CAPABILITY refusal
// (`UnsupportedOperationError`, the same shape a TV `key` gets); a page with
// nothing editable focused is a caller mistake whose repair is one `gesture-tap`
// (`InvalidToolInputError`). Both map to HTTP 400, so only the code separates
// them in telemetry — an agent that retried a refused `key` forever and one that
// forgot to focus the field must not land in the same bucket.
describe("keyboard `clear` — refusal taxonomy", () => {
  const APPLE_TV: DeviceInfo = { id: "TV-UDID", platform: "ios", kind: "simulator" };
  const ANDROID_TV: DeviceInfo = { id: "emulator-5554", platform: "android", kind: "emulator" };

  /** Assert the error is the capability refusal, carrying its telemetry code. */
  async function expectUnsupported(p: Promise<unknown>): Promise<Error> {
    const err = await p.then(
      () => {
        throw new Error("expected the call to reject, but it resolved");
      },
      (e: unknown) => e as Error
    );
    expect(err).toBeInstanceOf(UnsupportedOperationError);
    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.TOOL_CAPABILITY_UNSUPPORTED_OPERATION
    );
    return err;
  }

  it.each([
    ["Apple TV", APPLE_TV],
    ["Android TV", ANDROID_TV],
  ])(
    "%s: named key → capability refusal, before the TV service is resolved",
    async (_l, device) => {
      // `resolveTvApi` is NOT stubbed in this file, so a backend that fell through
      // to the daemon would try to spawn it and fail with something else — which
      // is itself the observation that the rejection came first.
      const err = await expectUnsupported(
        typeTv({} as Registry, device, { udid: device.id, key: "enter" })
      );
      // The remedy has to be TV-shaped: a named key is navigation there, and
      // `tv-remote` is what owns it.
      expect(err.message).toMatch(/named keys are not supported on a TV target/);
      expect(err.message).toMatch(/tv-remote/);
    }
  );

  it("vega: clear is served, and its adb dependency is declared", () => {
    // The refusal this file used to pin is gone: `inputd-cli` does carry a
    // delete burst (utils/vega-input.ts `injectVegaClear`). With every shape
    // this backend serves now injecting over adb, the dependency goes back on
    // `requires`, where `dispatchByPlatform` preflights it into a 424 install
    // hint — keyboard-vega-adb-preflight.test.ts pins that for all three.
    expect(vegaImpl.requires ?? []).toContain("adb");
  });

  it("chromium: nothing editable focused → 400 + KEYBOARD_CLEAR_NO_EDITABLE_FOCUS", async () => {
    // Its own code, not KEYBOARD_KEY_UNSUPPORTED / CHARACTER_UNSUPPORTED: this
    // is the only keyboard rejection about the state of the PAGE rather than
    // about the request, and the repair is a tap, not a different argument.
    const registry = new Registry();
    vi.spyOn(registry, "resolveService").mockResolvedValue({
      evaluate: vi.fn(async () => ({ cleared: false, focus: "body" })),
    } as never);
    await expectInvalidInput(
      makeChromiumImpl(registry).handler(
        {},
        { udid: chromiumDevice.id, clear: true },
        chromiumDevice
      ),
      FAILURE_CODES.KEYBOARD_CLEAR_NO_EDITABLE_FOCUS
    );
  });

  it("chromium: the refusal names what holds focus and how to fix it", async () => {
    // The two halves an agent acts on. Without the focused tag it cannot tell
    // "I never tapped the field" from "my tap landed on the label"; without the
    // tap instruction the obvious move is to retry the same call.
    const registry = new Registry();
    vi.spyOn(registry, "resolveService").mockResolvedValue({
      evaluate: vi.fn(async () => ({ cleared: false, focus: "button" })),
    } as never);
    const err = await makeChromiumImpl(registry)
      .handler({}, { udid: chromiumDevice.id, clear: true }, chromiumDevice)
      .then(
        () => {
          throw new Error("expected the clear to reject");
        },
        (e: unknown) => e as Error
      );
    expect(err.message).toMatch(/<button>/);
    expect(err.message).toMatch(/gesture-tap/);
  });

  it("chromium: a field inside an iframe is told the clear cannot reach it", async () => {
    // `iframe` is the one focus value whose repair is NOT "tap harder": the
    // field really is focused, one document down, and no tap in the top document
    // moves focus onto it. The advice used to live in the NO_EDITABLE_FOCUS
    // message, which a focused iframe never reaches — it has no light children,
    // so it was classified as an opaque host and told to tap the field inside
    // it. Confirmed live on Chrome 152 with focus on an <input> in the frame.
    const registry = new Registry();
    vi.spyOn(registry, "resolveService").mockResolvedValue({
      evaluate: vi.fn(async () => ({ cleared: false, focus: "iframe", reason: "iframe" })),
    } as never);
    const err = await makeChromiumImpl(registry)
      .handler({}, { udid: chromiumDevice.id, clear: true }, chromiumDevice)
      .then(
        () => {
          throw new Error("expected the clear to reject");
        },
        (e: unknown) => e as Error
      );
    const signal = getFailureSignal(err);
    expect(signal?.error_code).toBe(FAILURE_CODES.KEYBOARD_CLEAR_UNSUPPORTED_FIELD);
    expect(signal?.failure_stage).toBe("keyboard_clear_chromium_iframe");
    expect(err.message).toMatch(/does not reach/);
    expect(err.message).toMatch(/gesture-drag/);
    // Not the opaque-host repair, which is the loop this replaces.
    expect(err.message).not.toMatch(/Tap the field inside it/);
  });

  it("chromium: a null focus reads as no focus at all, not as an element", async () => {
    const registry = new Registry();
    vi.spyOn(registry, "resolveService").mockResolvedValue({
      evaluate: vi.fn(async () => ({ cleared: false, focus: null })),
    } as never);
    const err = await makeChromiumImpl(registry)
      .handler({}, { udid: chromiumDevice.id, clear: true }, chromiumDevice)
      .then(
        () => {
          throw new Error("expected the clear to reject");
        },
        (e: unknown) => e as Error
      );
    expect(err.message).toMatch(/no element has keyboard focus/);
    expect(err.message).not.toMatch(/<null>/);
  });

  it("chromium: a field that kept its value → 400 + KEYBOARD_CLEAR_UNSUPPORTED_FIELD", async () => {
    // A different code from the focus refusal, because the repair is different:
    // the caller DID focus the right field, and no amount of tapping fixes it.
    // Chromium's date/time inputs pass every editability signal the script can
    // read and still keep their value, so `execCommand("delete")` answering
    // false is the only evidence — and it must not be reported as a success.
    const registry = new Registry();
    vi.spyOn(registry, "resolveService").mockResolvedValue({
      evaluate: vi.fn(async () => ({
        cleared: false,
        focus: "input type=date",
        reason: "delete-refused",
      })),
    } as never);
    await expectInvalidInput(
      makeChromiumImpl(registry).handler(
        {},
        { udid: chromiumDevice.id, clear: true },
        chromiumDevice
      ),
      FAILURE_CODES.KEYBOARD_CLEAR_UNSUPPORTED_FIELD
    );
  });

  it("chromium: the kept-value refusal names the field and a repair that works", async () => {
    // "Tap the field first" is the WRONG advice here and would loop an agent
    // forever. The repair measured on Chrome 151 is one backspace on the field
    // that already has focus, so that is what the message has to say.
    const registry = new Registry();
    vi.spyOn(registry, "resolveService").mockResolvedValue({
      evaluate: vi.fn(async () => ({
        cleared: false,
        focus: "input type=date",
        reason: "delete-refused",
      })),
    } as never);
    const err = await makeChromiumImpl(registry)
      .handler({}, { udid: chromiumDevice.id, clear: true }, chromiumDevice)
      .then(
        () => {
          throw new Error("expected the clear to reject");
        },
        (e: unknown) => e as Error
      );
    expect(err.message).toMatch(/<input type=date>/);
    expect(err.message).toMatch(/kept its value/);
    expect(err.message).toMatch(/{ key: "backspace" }/);
    // ...and NOT the focus remedy, which is what the other refusal prescribes.
    expect(err.message).not.toMatch(/gesture-tap/);
  });

  it("chromium: a renderer answer with no `cleared` is a refusal, not a success", async () => {
    // `evaluate` resolves `undefined` when the expression throws under
    // `returnByValue`, or when the page navigates mid-call. Reading that as a
    // success would report `cleared: true` for a field that still holds its
    // value — the exact failure mode the whole design refuses to have.
    for (const answer of [undefined, null, {}, { cleared: "yes" }]) {
      const registry = new Registry();
      vi.spyOn(registry, "resolveService").mockResolvedValue({
        evaluate: vi.fn(async () => answer),
      } as never);
      await expectInvalidInput(
        makeChromiumImpl(registry).handler(
          {},
          { udid: chromiumDevice.id, clear: true },
          chromiumDevice
        ),
        FAILURE_CODES.KEYBOARD_CLEAR_NO_EDITABLE_FOCUS
      );
    }
  });
});

// Everything above pins the refusals at the platform-impl boundary. These pin
// them where a caller meets them: through `createKeyboardTool(...).execute()`,
// so the code also has to survive `dispatchByPlatform`, the capability
// preflight and the secret-resolution step — the same level at which the
// sibling KEYBOARD_TEXT_AND_KEY_COMBINED is already asserted.
describe("keyboard `clear` — the refusals reach a caller through the tool", () => {
  function toolWithChromiumEvaluate(answers: unknown[]): ReturnType<typeof createKeyboardTool> {
    const registry = new Registry();
    let call = 0;
    vi.spyOn(registry, "resolveService").mockResolvedValue({
      evaluate: vi.fn(async () => answers[Math.min(call++, answers.length - 1)]),
      dispatchKeyEvent: vi.fn(async () => {}),
    } as never);
    // No device stub: `resolveDevice` classifies by udid shape, and
    // `chromium-cdp-<port>` is a chromium app there.
    return createKeyboardTool(registry);
  }

  it("KEYBOARD_CLEAR_NO_EDITABLE_FOCUS survives the whole tool, not just the impl", async () => {
    const tool = toolWithChromiumEvaluate([
      { cleared: false, focus: "body", reason: "not-editable" },
    ]);
    await expectInvalidInput(
      tool.execute({}, { udid: chromiumDevice.id, clear: true }, undefined),
      FAILURE_CODES.KEYBOARD_CLEAR_NO_EDITABLE_FOCUS
    );
  });

  it("KEYBOARD_CLEAR_UNSUPPORTED_FIELD survives the whole tool, not just the impl", async () => {
    const tool = toolWithChromiumEvaluate([
      { cleared: false, focus: "input type=date", reason: "delete-refused" },
    ]);
    await expectInvalidInput(
      tool.execute({}, { udid: chromiumDevice.id, clear: true }, undefined),
      FAILURE_CODES.KEYBOARD_CLEAR_UNSUPPORTED_FIELD
    );
  });

  it("names `disabled` in the no-focus repair, which is the only message that can", async () => {
    // A `disabled` control cannot become `document.activeElement` (measured on
    // Chrome 151: a real `gesture-tap` on one leaves focus on <body>), so the
    // `disabled` diagnosis is unreachable for every standard form control and
    // this refusal is what an agent actually gets. Told only "tap the field
    // first", it taps the same field and gets the same error forever.
    const tool = toolWithChromiumEvaluate([
      { cleared: false, focus: "body", reason: "not-editable" },
    ]);
    const err = await tool.execute({}, { udid: chromiumDevice.id, clear: true }, undefined).then(
      () => undefined,
      (e: unknown) => e as Error
    );
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_CLEAR_NO_EDITABLE_FOCUS);
    expect(err?.message).toMatch(/`disabled`/);
    expect(err?.message).toMatch(/cannot take keyboard focus at all/);
  });

  it("does not diagnose every refused delete as a date/time input", async () => {
    // A `contenteditable` whose first child is a `contenteditable="false"` block
    // — a locked header, an embed, a node view, a mention chip — refuses the
    // delete too (measured on Chrome 151, static HTML with no listeners). The
    // date/time wording sent it to press a `backspace` that is a no-op on it.
    const tool = toolWithChromiumEvaluate([
      { cleared: false, focus: "div", reason: "delete-refused" },
    ]);
    const err = await tool.execute({}, { udid: chromiumDevice.id, clear: true }, undefined).then(
      () => undefined,
      (e: unknown) => e as Error
    );
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_CLEAR_UNSUPPORTED_FIELD);
    expect(err?.message).not.toMatch(/date and time inputs/);
    expect(err?.message).toMatch(/contenteditable="false"/);
  });

  it("still diagnoses a real date input as one", async () => {
    // The positive control: the wording above must not swallow the case it was
    // written for. The type comes from the script's own `focus` label.
    const tool = toolWithChromiumEvaluate([
      { cleared: false, focus: "input type=date", reason: "delete-refused" },
    ]);
    const err = await tool.execute({}, { udid: chromiumDevice.id, clear: true }, undefined).then(
      () => undefined,
      (e: unknown) => e as Error
    );
    expect(err?.message).toMatch(/date and time inputs/);
  });

  it("a field that survives the delete is refused, not reported as cleared", async () => {
    // The read-back, end to end: `delete` said true, and the SECOND evaluate
    // finds the value still there — which is what an editor with its own
    // document model produces. Without this the tool answers `cleared: true`
    // and the caller's next `text` is appended to the old value.
    const tool = toolWithChromiumEvaluate([
      { cleared: true, focus: "div" },
      { focus: "div", same: true, remaining: 11 },
    ]);
    await expectInvalidInput(
      tool.execute({}, { udid: chromiumDevice.id, clear: true }, undefined),
      FAILURE_CODES.KEYBOARD_CLEAR_UNSUPPORTED_FIELD
    );
  });

  it("a read-back that finds the field empty reports the clear", async () => {
    // The positive control for the case above: the same two evaluates, with the
    // read-back answering 0. A read-back wired to refuse on anything but a
    // strict `remaining === 0` would still pass that test and fail this one.
    const tool = toolWithChromiumEvaluate([
      { cleared: true, focus: "input type=text" },
      { focus: "input type=text", same: true, remaining: 0 },
    ]);
    await expect(
      tool.execute({}, { udid: chromiumDevice.id, clear: true }, undefined)
    ).resolves.toEqual({ typed: "", keys: 0, cleared: true, clearVerified: true });
  });

  it("a read-back on a DIFFERENT element cannot contradict the delete", async () => {
    // The page moved focus in its own `input` handler. The value read there
    // belongs to another field, so it is no evidence about the one that was
    // cleared — treating it as evidence would fail every app that blurs on edit.
    //
    // The labels here are IDENTICAL on purpose: two fields of one kind both
    // report "input type=text", which is the auto-advancing OTP / PIN /
    // card-segment shape and the common case. Deciding this by label reported a
    // correct clear as `KEYBOARD_CLEAR_UNSUPPORTED_FIELD` quoting the NEXT
    // field's character (measured on Chrome 151); `same` decides it by identity.
    const tool = toolWithChromiumEvaluate([
      { cleared: true, focus: "input type=text" },
      { focus: "input type=text", same: false, remaining: 1 },
    ]);
    // No `clearVerified`: the read was taken on a DIFFERENT element, so nothing
    // saw the cleared field empty. The delete stands; the verification does not.
    await expect(
      tool.execute({}, { udid: chromiumDevice.id, clear: true }, undefined)
    ).resolves.toEqual({ typed: "", keys: 0, cleared: true });
  });

  it("contradicts the delete even when the restoring editor moved focus away", async () => {
    // The two commonest restoring shapes both leave focus somewhere with nothing
    // to read: an editor that hands focus to a hidden IME buffer on every edit
    // (ProseMirror / Slate / Quill), and a field that blurs on change. Reading
    // whatever holds focus reported both as `cleared: true` with the value
    // intact (measured on Chrome 151). The read-back reads the element the clear
    // RAN AGAINST, so `focus` naming a different element is no longer an escape.
    const tool = toolWithChromiumEvaluate([
      { cleared: true, focus: "div" },
      { focus: "div", same: true, remaining: 20, embeds: 0 },
    ]);
    await expectInvalidInput(
      tool.execute({}, { udid: chromiumDevice.id, clear: true }, undefined),
      FAILURE_CODES.KEYBOARD_CLEAR_UNSUPPORTED_FIELD
    );
  });

  it("contradicts the delete for content that has no text at all", async () => {
    // An inline image, attachment chip or table reads `textContent.length` 0
    // before AND after, so a restored one could never contradict a delete that
    // counted characters alone. The message has to name what survived — "still
    // holds 0 characters" reads as an empty field.
    const tool = toolWithChromiumEvaluate([
      { cleared: true, focus: "div" },
      { focus: "div", same: true, remaining: 0, embeds: 1 },
    ]);
    const err = await tool.execute({}, { udid: chromiumDevice.id, clear: true }, undefined).then(
      () => undefined,
      (e: unknown) => e as Error
    );
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_CLEAR_UNSUPPORTED_FIELD);
    expect(err?.message).toMatch(/1 embedded element \(an image, table or attachment\)/);
  });

  it("a target the page REPLACED cannot contradict the delete", async () => {
    // A detached node keeps the old value while the live field on screen is
    // empty, so `same` is false there and the delete stands.
    const tool = toolWithChromiumEvaluate([
      { cleared: true, focus: "input type=text" },
      { focus: "input type=text", same: false, remaining: 11, embeds: 0 },
    ]);
    // And unverified for the same reason: a detached node is not evidence about
    // the live field either way.
    await expect(
      tool.execute({}, { udid: chromiumDevice.id, clear: true }, undefined)
    ).resolves.toEqual({ typed: "", keys: 0, cleared: true });
  });

  it("a field the page REFORMATTED is not reported as one that kept its value", async () => {
    // A currency, phone or card mask reseeds its own value from the `input`
    // listener, so the field is non-empty after the delete while the caller's
    // value is already destroyed. "nothing was cleared ... the value the field
    // still holds" was false twice over, and an agent that believed it treated
    // the original as intact. Its own stage, because that is the difference an
    // agent acts on.
    const tool = toolWithChromiumEvaluate([
      { cleared: true, focus: "input type=text" },
      { focus: "input type=text", same: true, changed: true, remaining: 4, embeds: 0 },
    ]);
    const err = await tool.execute({}, { udid: chromiumDevice.id, clear: true }, undefined).then(
      () => undefined,
      (e: unknown) => e as Error
    );
    const signal = getFailureSignal(err);
    expect(signal?.error_code).toBe(FAILURE_CODES.KEYBOARD_CLEAR_UNSUPPORTED_FIELD);
    expect(signal?.failure_stage).toBe("keyboard_clear_chromium_reformatted");
    expect(err?.message).toMatch(/NOT what it held before/);
    expect(err?.message).not.toMatch(/nothing was cleared/);
  });

  it("a field that kept the SAME value still reports the restore", async () => {
    // The positive control for the branch above: `changed: false` is the
    // restoring editor, where the caller's value really is intact.
    const tool = toolWithChromiumEvaluate([
      { cleared: true, focus: "div" },
      { focus: "div", same: true, changed: false, remaining: 20, embeds: 0 },
    ]);
    const err = await tool.execute({}, { udid: chromiumDevice.id, clear: true }, undefined).then(
      () => undefined,
      (e: unknown) => e as Error
    );
    expect(getFailureSignal(err)?.failure_stage).toBe("keyboard_clear_chromium_restored");
    expect(err?.message).toMatch(/the value is the one it held before/);
  });

  it("does not claim verification when the read-back could not be taken", async () => {
    // The one place `cleared` and `clearVerified` come apart on this backend: a
    // page that REPLACED the field leaves the target detached, and one that
    // sealed `window` leaves no target at all. The delete was still accepted, so
    // `cleared` stands — but nothing saw the field empty, and the flag must not
    // guess. `keyboard`'s own description says it is absent exactly there.
    const tool = toolWithChromiumEvaluate([
      { cleared: true, focus: "input type=text" },
      { focus: "input type=text", same: false, remaining: null, embeds: 0 },
    ]);
    const result = await tool.execute({}, { udid: chromiumDevice.id, clear: true }, undefined);
    expect(result).toEqual({ typed: "", keys: 0, cleared: true });
    expect(result.clearVerified).toBeUndefined();
  });

  it("does not claim verification for a live target that reads back nothing", async () => {
    // The third way the read-back declines to answer, and the only one where the
    // target is still on screen: an editor that reconciles from its own model
    // and locks the view on edit (the "save, then go read-only" re-render) keeps
    // its node — so `same: true` — and stops being editable, so there is nothing
    // with a value to read and `remaining` comes back `null`. Folding that null
    // into a 0 satisfied "survived === 0" and reported `clearVerified: true`
    // over the text still on screen: reproduced on Chrome 152 against a
    // contenteditable that restores its own text from its `input` listener, the
    // field still holding "LOCKED DRAFT".
    const tool = toolWithChromiumEvaluate([
      { cleared: true, focus: "div" },
      { focus: "div", same: true, changed: true, remaining: null, embeds: 0 },
    ]);
    const result = await tool.execute({}, { udid: chromiumDevice.id, clear: true }, undefined);
    expect(result).toEqual({ typed: "", keys: 0, cleared: true });
    expect(result.clearVerified).toBeUndefined();
  });

  it("reads EVERY accepted clear back — there is no delete's-word-alone path", async () => {
    // `delete` answers true whether or not it removed anything (measured on
    // Chrome 151), so its return value is never the evidence `cleared` reports.
    // A host the script cannot read back is refused in the renderer instead,
    // which is why nothing here can arrive already-cleared and unverifiable.
    const registry = new Registry();
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({ cleared: true, focus: "div" })
      .mockResolvedValueOnce({ focus: "div", same: true, remaining: 0 });
    vi.spyOn(registry, "resolveService").mockResolvedValue({ evaluate } as never);
    await expect(
      makeChromiumImpl(registry).handler(
        {},
        { udid: chromiumDevice.id, clear: true },
        chromiumDevice
      )
    ).resolves.toEqual({ typed: "", keys: 0, cleared: true, clearVerified: true });
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it("a CDP socket that DROPS is KEYBOARD_CLEAR_UNCONFIRMED too, not a dead runtime", async () => {
    // A connection close rejects with DEBUGGER_CDP_CONNECTION_CLOSED
    // (`error_kind: "network"`) and used to be rethrown raw, carrying the
    // debugger taxonomy's "restart the app, then reconnect and retry once".
    // The cdp-client's own comment at that rejection site is the argument
    // against it: "A request rejected here was already delivered and may have
    // taken effect - callers must not blindly retry side-effectful sends."
    // Reproduced by killing the browser mid-read-back on Chrome 151, which
    // answered `DEBUGGER_CDP_CONNECTION_CLOSED` / "CDP connection closed".
    const registry = new Registry();
    vi.spyOn(registry, "resolveService").mockResolvedValue({
      evaluate: vi.fn(async () => {
        throw new FailureError("CDP connection closed", {
          error_code: FAILURE_CODES.DEBUGGER_CDP_CONNECTION_CLOSED,
          failure_stage: "debugger_cdp_lifecycle",
          failure_area: "tool_server",
          error_kind: "network",
        });
      }),
    } as never);
    const err = await makeChromiumImpl(registry)
      .handler({}, { udid: chromiumDevice.id, clear: true }, chromiumDevice)
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );
    const signal = getFailureSignal(err);
    expect(signal?.error_code).toBe(FAILURE_CODES.KEYBOARD_CLEAR_UNCONFIRMED);
    expect(signal?.error_kind).toBe("network");
    expect(err?.message).toMatch(/read it back first/);
    expect(err?.message).not.toMatch(/restart the app, then reconnect/);
  });

  it("words a read-back timeout for the read-back, not for the delete", async () => {
    // The two stages share `evaluateClearStep`, so the read-back used to be told
    // "the delete is NOT cancelled by the timeout and can still land once the
    // renderer is free" — by which point `delete` has already returned true and
    // the field is already empty. The repair is right; the claim was not.
    const registry = new Registry();
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({ cleared: true, focus: "input type=text" })
      .mockRejectedValueOnce(
        new FailureError("timed out", {
          error_code: FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT,
          failure_stage: "debugger_cdp_request",
          failure_area: "tool_server",
          error_kind: "timeout",
        })
      );
    vi.spyOn(registry, "resolveService").mockResolvedValue({ evaluate } as never);
    const err = await makeChromiumImpl(registry)
      .handler({}, { udid: chromiumDevice.id, clear: true }, chromiumDevice)
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );
    const signal = getFailureSignal(err);
    expect(signal?.error_code).toBe(FAILURE_CODES.KEYBOARD_CLEAR_UNCONFIRMED);
    // The stage that was asserted nowhere before.
    expect(signal?.failure_stage).toBe("keyboard_clear_chromium_readback_timeout");
    expect(err?.message).toMatch(/the delete was accepted but the field could not be read back/);
  });

  it("a CDP wait that runs out is KEYBOARD_CLEAR_UNCONFIRMED, not a debugger failure", async () => {
    // The timeout does not cancel the evaluate, so the delete can still land
    // after the caller has been told it failed. The debugger taxonomy's own
    // advice there is "restart the app and retry once" — a retry lands a SECOND
    // delete on a field the first may already have emptied.
    const registry = new Registry();
    vi.spyOn(registry, "resolveService").mockResolvedValue({
      evaluate: vi.fn(async () => {
        throw new FailureError("CDP request Runtime.evaluate timed out", {
          error_code: FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT,
          failure_stage: "debugger_cdp_send",
          failure_area: "tool_server",
          error_kind: "timeout",
        });
      }),
    } as never);
    const err = await makeChromiumImpl(registry)
      .handler({}, { udid: chromiumDevice.id, clear: true }, chromiumDevice)
      .then(
        () => {
          throw new Error("expected the call to reject, but it resolved");
        },
        (e: unknown) => e as Error
      );
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_CLEAR_UNCONFIRMED);
    expect(err.message).toMatch(/NOT cancelled/);
    expect(err.message).toMatch(/read it back/);
    // ...and NOT the advice that would make it worse.
    expect(err.message).not.toMatch(/restart the app, then reconnect/);
  });

  it("an evaluate that never reached the renderer is passed through untouched", async () => {
    // `DEBUGGER_CDP_NOT_CONNECTED` means the socket was already down when the
    // send was attempted, so nothing was delivered and there is no "it may
    // still land" hazard to re-state. It keeps its own code and its own repair
    // — the re-statement is for the two failures where the request DID reach
    // the renderer (a timeout, and a socket that dropped after delivery), not
    // for every CDP fault.
    const registry = new Registry();
    vi.spyOn(registry, "resolveService").mockResolvedValue({
      evaluate: vi.fn(async () => {
        throw new FailureError("CDP not connected", {
          error_code: FAILURE_CODES.DEBUGGER_CDP_NOT_CONNECTED,
          failure_stage: "debugger_cdp_send",
          failure_area: "tool_server",
          error_kind: "network",
        });
      }),
    } as never);
    const err = await makeChromiumImpl(registry)
      .handler({}, { udid: chromiumDevice.id, clear: true }, chromiumDevice)
      .then(
        () => {
          throw new Error("expected the call to reject, but it resolved");
        },
        (e: unknown) => e as Error
      );
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.DEBUGGER_CDP_NOT_CONNECTED);
  });

  it("the four unclearable-field reasons each get their own stage and their own repair", async () => {
    // One code, four stages: the repair differs per reason, and an agent handed
    // "tap the field first" for a field it has already tapped loops forever.
    const cases: Array<[reason: string, stage: string, repair: RegExp]> = [
      ["readonly", "keyboard_clear_chromium_readonly", /read-only field ignores every edit/],
      ["disabled", "keyboard_clear_chromium_disabled", /until the app enables it/],
      ["not-a-text-field", "keyboard_clear_chromium_not_a_text_field", /holds no text to clear/],
      ["host-opaque", "keyboard_clear_chromium_host_opaque", /exposes no open shadow root/],
    ];
    for (const [reason, stage, repair] of cases) {
      const registry = new Registry();
      vi.spyOn(registry, "resolveService").mockResolvedValue({
        evaluate: vi.fn(async () => ({ cleared: false, focus: "input type=text", reason })),
      } as never);
      const err = await makeChromiumImpl(registry)
        .handler({}, { udid: chromiumDevice.id, clear: true }, chromiumDevice)
        .then(
          () => {
            throw new Error(`expected ${reason} to reject, but it resolved`);
          },
          (e: unknown) => e as Error
        );
      const signal = getFailureSignal(err);
      expect(signal?.error_code, reason).toBe(FAILURE_CODES.KEYBOARD_CLEAR_UNSUPPORTED_FIELD);
      expect(signal?.failure_stage, reason).toBe(stage);
      expect(err.message, reason).toMatch(repair);
      // None of them may send the caller back to tap a field it already holds.
      expect(err.message, reason).not.toMatch(/Tap the field first/);
    }
  });

  it("a page that broke the script reports the page's error, not a missing focus", async () => {
    // `document.execCommand` replaced by an editor: the throw used to leave
    // `result.value` undefined, which read as "no element has keyboard focus" —
    // the wrong cause AND the wrong repair.
    const registry = new Registry();
    vi.spyOn(registry, "resolveService").mockResolvedValue({
      evaluate: vi.fn(async () => ({
        cleared: false,
        reason: "script-error",
        detail: "execCommand is not a function",
      })),
    } as never);
    const err = await makeChromiumImpl(registry)
      .handler({}, { udid: chromiumDevice.id, clear: true }, chromiumDevice)
      .then(
        () => {
          throw new Error("expected the call to reject, but it resolved");
        },
        (e: unknown) => e as Error
      );
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_CLEAR_UNSUPPORTED_FIELD);
    expect(err.message).toMatch(/execCommand is not a function/);
    expect(err.message).not.toMatch(/keyboard focus/);
  });

  it("a document-wide editing host is refused with the focus code and its own wording", async () => {
    // designMode / <body contenteditable>: the repair IS "tap the field", so it
    // shares the focus code — but the reason a caller needs to read is that the
    // clear would have emptied the entire page.
    const registry = new Registry();
    vi.spyOn(registry, "resolveService").mockResolvedValue({
      evaluate: vi.fn(async () => ({ cleared: false, focus: "body", reason: "document-editable" })),
    } as never);
    const err = await makeChromiumImpl(registry)
      .handler({}, { udid: chromiumDevice.id, clear: true }, chromiumDevice)
      .then(
        () => {
          throw new Error("expected the call to reject, but it resolved");
        },
        (e: unknown) => e as Error
      );
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_CLEAR_NO_EDITABLE_FOCUS);
    expect(err.message).toMatch(/ENTIRE page/);
    expect(err.message).toMatch(/Tap the field first/);
  });
});
