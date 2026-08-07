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

  for (const { platform, udid, injections, pressedBackspace } of BACKENDS) {
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

  it("steers a combined SECRET call to run-sequence, not to two bare calls", async () => {
    // The two remedies diverge here. The MCP auto-screenshot skip keys off a
    // deep scan of the whole request (argent-mcp `containsSecretPlaceholder`),
    // and `run-sequence` is itself in `AUTO_SCREENSHOT_TOOLS` — so the combined
    // call and the one-run-sequence form both skip, while of two bare calls only
    // the first does. The second, `{ key: "enter" }`, carries no placeholder and
    // is screenshotted AFTER the key lands, handing the still-visible secret
    // back as pixels. Splitting a combined secret call the way the generic
    // message says would therefore lose the protection the placeholder exists
    // for, so the message has to say which remedy to pick.
    const err = await createKeyboardTool(registry())
      .execute({}, { udid: "emulator-5554", text: "{{secret:APP_PASSWORD}}", key: "enter" })
      .then(
        () => {
          throw new Error("expected the combined text+key call to reject");
        },
        (e: unknown) => e as Error
      );
    expect(err.message).toMatch(/ONE `run-sequence` form/);
    expect(err.message).toMatch(/still-visible secret/);
    // Still resolves nothing: the steer is a syntactic `.includes` on the
    // placeholder, above `resolveSecretPlaceholders`, so an unset name does not
    // turn this into an "unknown secret" error.
    expect(adbShell).not.toHaveBeenCalled();
  });

  it("leaves the secret steer out of a plain combined call", async () => {
    // Positive control for the test above: the run-sequence steer is specific to
    // a placeholder-bearing request, so a plain one must not carry it — an
    // unconditional sentence would pass that test while telling every caller to
    // batch for a skip that has nothing to skip.
    const err = await createKeyboardTool(registry())
      .execute({}, { udid: "emulator-5554", text: "hi", key: "enter" })
      .then(
        () => {
          throw new Error("expected the combined text+key call to reject");
        },
        (e: unknown) => e as Error
      );
    expect(err.message).not.toMatch(/still-visible secret/);
  });

  it("still names the TV constraint the guard pre-empts", async () => {
    // On a TV target `key` is rejected outright (platforms/tv.ts), so the
    // remedy this message prescribes — a second call carrying { key: "enter" } —
    // is a retry that cannot succeed there. Before the guard existed, a combined
    // call on a TV got that diagnosis from the backend; the guard runs above the
    // dispatch (deliberately, so nothing reaches a device) and would otherwise
    // swallow it.
    //
    // The caveat is therefore carried statically, not by probing the target —
    // distinguishing a TV kind is async. So this assertion holds for a phone
    // udid too; what it pins is that the sentence survives edits to the message.
    // The TV target is driven here because it is the shape that needs it.
    isAndroidTv.mockResolvedValue(true);
    const err = await createKeyboardTool(registry())
      .execute({}, { udid: "emulator-5554", text: "hi", key: "enter" })
      .then(
        () => {
          throw new Error("expected the combined text+key call to reject");
        },
        (e: unknown) => e as Error
      );
    expect(err.message).toMatch(/TV target/);
    expect(err.message).toMatch(/tv-remote/);
  });
});

// Minimal evaluator for the presence-only JSON Schema subset this constraint
// uses (required / not), so the advertised schema can be checked semantically
// without pulling in a full validator. Mirrors gesture-rotate-radius.test.ts.
interface PresenceConstraint {
  required?: string[];
  not?: PresenceConstraint;
}

function satisfies(params: Record<string, unknown>, c: PresenceConstraint): boolean {
  if (c.required && !c.required.every((key) => key in params)) return false;
  if (c.not && satisfies(params, c.not)) return false;
  return true;
}

// The rule is enforced in `execute`, so a client that only ever calls the tool
// learns it from a 400. A client that validates arguments against the advertised
// schema, or constrains generation from it, never gets that far — for those, the
// schema IS the contract, which is why the constraint is re-encoded there
// (the same reason gesture-rotate hand-writes its `anyOf`).
describe("keyboard inputSchema", () => {
  // `isAndroidTv` is module-level, and the TV test above leaves it resolving
  // true — without this the android udid here would route to the TV backend.
  beforeEach(() => {
    vi.clearAllMocks();
    isAndroidTv.mockResolvedValue(false);
  });

  it("leaves both halves optional, constrained only by the `not`", () => {
    const schema = createKeyboardTool(registry()).inputSchema!;
    expect(schema.type).toBe("object");
    const required = schema.required as string[];
    expect(required).toEqual(["udid"]);
    expect(required).not.toContain("text");
    expect(required).not.toContain("key");
  });

  it("advertises exactly the shapes `execute` accepts at runtime", async () => {
    const tool = createKeyboardTool(registry());
    const constraint = tool.inputSchema! as unknown as PresenceConstraint;
    const shapes: Array<[args: Record<string, unknown>, valid: boolean]> = [
      [{ text: "hi" }, true],
      [{ key: "enter" }, true],
      [{}, true], // neither is required — an empty request is a documented no-op
      [{ text: "hi", key: "enter" }, false],
      [{ text: "", key: "" }, false], // shape, not truthiness — same as `execute`
    ];

    for (const [args, valid] of shapes) {
      const params = { udid: "emulator-5554", ...args };
      expect(satisfies(params, constraint), `schema disagrees on ${JSON.stringify(args)}`).toBe(
        valid
      );

      // And the runtime agrees, so the two can't drift apart silently.
      vi.clearAllMocks();
      const rejected = await tool.execute({}, params as never).then(
        () => false,
        () => true
      );
      expect(rejected, `runtime disagrees on ${JSON.stringify(args)}`).toBe(!valid);
    }
  });

  it("states the constraint on `text` too, not only on `key`", () => {
    // A caller reading only the parameter it is filling in must still see the
    // rule; `boot-device` restates its exactly-one check in all four fields for
    // the same reason.
    const { text, key } = createKeyboardTool(registry()).zodSchema!.shape;
    expect(text.description).toMatch(/Cannot be combined with `key`/);
    expect(key.description).toMatch(/Cannot be combined with `text`/);
  });
});
