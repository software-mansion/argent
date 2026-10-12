import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFailureSignal } from "@argent/registry";
import type { AXFillResponse } from "../src/blueprints/ax-service";
import type { SetTextResult } from "../src/blueprints/android-devtools";

vi.mock("../src/utils/check-deps", () => ({ ensureDeps: vi.fn(async () => {}) }));
vi.mock("../src/utils/ios-devices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/ios-devices")>();
  return { ...actual, isTvOsSimulator: vi.fn(async () => false) };
});
vi.mock("../src/utils/adb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/adb")>();
  return { ...actual, isAndroidTv: vi.fn(async () => false), adbShell: vi.fn(async () => "") };
});
vi.mock("../src/utils/android-input", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/android-input")>();
  return { ...actual, injectAndroidText: vi.fn(async () => {}) };
});
vi.mock("../src/utils/ios-device/app-session", () => ({
  requireCurrentIosDeviceApp: vi.fn(() => "com.example.app"),
}));
vi.mock("../src/utils/ios-device/runner-commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/ios-device/runner-commands")>();
  return { ...actual, typeText: vi.fn(async () => ({ reactivated: false })) };
});

import { createFillTool } from "../src/tools/fill";
import { isTvOsSimulator } from "../src/utils/ios-devices";
import { adbShell, isAndroidTv } from "../src/utils/adb";
import { injectAndroidText } from "../src/utils/android-input";
import { typeText } from "../src/utils/ios-device/runner-commands";
import { RunnerCommandError } from "../src/utils/ios-device/runner-client";

const IOS = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEFFFF0000";
const ANDROID = "emulator-5554";
const CHROMIUM = "chromium-cdp-9222";
const VEGA = "amazon-1234567890";
const IPHONE = "00008120-000154913A05A01E";

/** Records every key the simulator-server is asked to press. */
function simulatorServer() {
  const keys: Array<[string, number]> = [];
  return {
    keys,
    api: { pressKey: async (dir: string, code: number) => void keys.push([dir, code]) },
  };
}

interface Services {
  ax?: { fill: ReturnType<typeof vi.fn> };
  helper?: { setText: ReturnType<typeof vi.fn> } | Error;
  sim?: ReturnType<typeof simulatorServer>;
  cdp?: { send: ReturnType<typeof vi.fn> };
}

function registryWith(services: Services) {
  return {
    resolveService: vi.fn(async (urn: string) => {
      if (urn.startsWith("AXService:")) return services.ax;
      if (urn.startsWith("AndroidDevtools:")) {
        if (services.helper instanceof Error) throw services.helper;
        return services.helper;
      }
      if (urn.startsWith("SimulatorServer:")) return services.sim?.api;
      if (urn.startsWith("ChromiumCdp:")) return { cdp: services.cdp };
      if (urn.startsWith("IosDeviceRunner:")) return {};
      throw new Error(`unexpected service ${urn}`);
    }),
  } as any;
}

function axAnswers(...answers: Array<AXFillResponse | null>) {
  const fill = vi.fn();
  for (const a of answers) fill.mockResolvedValueOnce(a);
  return { fill };
}

function helperAnswers(...answers: Array<SetTextResult | null>) {
  const setText = vi.fn();
  for (const a of answers) setText.mockResolvedValueOnce(a);
  return { setText };
}

async function run(services: Services, udid: string, text: string) {
  const tool = createFillTool(registryWith(services));
  return tool.execute({}, { udid, text });
}

async function failure(services: Services, udid: string, text: string) {
  try {
    await run(services, udid, text);
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected fill to fail");
}

const BACKSPACE = 42;
const FORWARD_DELETE = 76;

beforeEach(() => {
  vi.mocked(isTvOsSimulator).mockResolvedValue(false);
  vi.mocked(isAndroidTv).mockResolvedValue(false);
  vi.mocked(adbShell).mockClear();
  vi.mocked(injectAndroidText).mockClear();
  vi.mocked(typeText).mockReset();
  vi.mocked(typeText).mockResolvedValue({ reactivated: false });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("fill: iOS simulator", () => {
  it("answers accessibility when the ax-service write reads back", async () => {
    const ax = axAnswers({ focused: true, verified: true, length: 5 });
    const sim = simulatorServer();
    await expect(run({ ax, sim }, IOS, "hello")).resolves.toEqual({
      method: "accessibility",
      verified: true,
      length: 5,
    });
    expect(ax.fill).toHaveBeenCalledWith("hello");
    expect(sim.keys).toHaveLength(0);
  });

  it("clears with an empty text", async () => {
    const ax = axAnswers({ focused: true, verified: true, length: 0 });
    await expect(run({ ax }, IOS, "")).resolves.toEqual({
      method: "accessibility",
      verified: true,
      length: 0,
    });
    expect(ax.fill).toHaveBeenCalledWith("");
  });

  it("fails with FILL_NO_FOCUSED_FIELD and presses nothing when nothing has focus", async () => {
    const sim = simulatorServer();
    const err = await failure(
      { ax: axAnswers({ focused: false, verified: false }), sim },
      IOS,
      "x"
    );
    expect(getFailureSignal(err)?.error_code).toBe("FILL_NO_FOCUSED_FIELD");
    expect(sim.keys).toHaveLength(0);
  });

  it("falls back to keys, unverified, on an ax-service that predates fill", async () => {
    const sim = simulatorServer();
    await expect(run({ ax: axAnswers(null), sim }, IOS, "ab")).resolves.toEqual({
      method: "keys",
      verified: null,
    });
    const downs = sim.keys.filter(([dir]) => dir === "Down").map(([, code]) => code);
    // 100 (backspace, forward delete) pairs, then a (4) and b (5).
    expect(downs.slice(0, 200).filter((c) => c === BACKSPACE)).toHaveLength(100);
    expect(downs.slice(0, 200).filter((c) => c === FORWARD_DELETE)).toHaveLength(100);
    expect(downs.slice(200)).toEqual([4, 5]);
  });

  it("refuses text the key fallback cannot type before deleting anything", async () => {
    const sim = simulatorServer();
    const err = await failure({ ax: axAnswers(null), sim }, IOS, "Zażółć");
    expect(getFailureSignal(err)?.error_code).toBe("KEYBOARD_CHARACTER_UNSUPPORTED");
    expect(sim.keys).toHaveLength(0);
  });

  it("types into a native secure field the daemon left untouched, then checks it", async () => {
    const ax = axAnswers(
      { focused: true, verified: false, secure: true, length: 4 },
      { focused: true, verified: true, length: 6 }
    );
    const sim = simulatorServer();
    await expect(run({ ax, sim }, IOS, "s3cret")).resolves.toEqual({
      method: "keys",
      verified: true,
      length: 6,
    });
    expect(ax.fill).toHaveBeenLastCalledWith("s3cret", { check: true });
  });

  it("refuses untypeable text for a native secure field without touching it", async () => {
    const ax = axAnswers({ focused: true, verified: false, secure: true, length: 4 });
    const sim = simulatorServer();
    const err = await failure({ ax, sim }, IOS, "pässword");
    expect(getFailureSignal(err)?.error_code).toBe("FILL_UNSUPPORTED_FIELD");
    expect(sim.keys).toHaveLength(0);
    expect(ax.fill).toHaveBeenCalledTimes(1);
  });

  it("clears a web password input with one backspace when the daemon asks for it", async () => {
    const ax = axAnswers(
      { focused: true, verified: false, needsBackspace: true, length: 8 },
      { focused: true, verified: true, length: 0 }
    );
    const sim = simulatorServer();
    await expect(run({ ax, sim }, IOS, "")).resolves.toEqual({
      method: "accessibility",
      verified: true,
      length: 0,
    });
    expect(sim.keys).toEqual([
      ["Down", BACKSPACE],
      ["Up", BACKSPACE],
    ]);
  });

  it("retries with keys when the write does not read back, and fails if the keys do not either", async () => {
    const ax = axAnswers(
      { focused: true, verified: false, length: 3 },
      { focused: true, verified: false, length: 3 }
    );
    const sim = simulatorServer();
    const err = await failure({ ax, sim }, IOS, "abc");
    expect(getFailureSignal(err)?.error_code).toBe("FILL_NOT_VERIFIED");
    expect(err.message).toContain("keys");
    expect(sim.keys.length).toBeGreaterThan(400);
  });

  it("answers keys when the retry reads back", async () => {
    const ax = axAnswers(
      { focused: true, verified: false, length: 0 },
      { focused: true, verified: true, length: 3 }
    );
    await expect(run({ ax, sim: simulatorServer() }, IOS, "abc")).resolves.toEqual({
      method: "keys",
      verified: true,
      length: 3,
    });
  });

  it("fails without typing when the write does not read back and keys cannot type the text", async () => {
    const ax = axAnswers({ focused: true, verified: false, length: 0 });
    const sim = simulatorServer();
    const err = await failure({ ax, sim }, IOS, "你好");
    expect(getFailureSignal(err)?.error_code).toBe("FILL_NOT_VERIFIED");
    expect(sim.keys).toHaveLength(0);
  });

  it("refuses a tvOS simulator before touching it", async () => {
    vi.mocked(isTvOsSimulator).mockResolvedValue(true);
    const ax = axAnswers();
    const err = await failure({ ax }, IOS, "x");
    expect(getFailureSignal(err)?.error_code).toBe("TOOL_CAPABILITY_UNSUPPORTED_OPERATION");
    expect(ax.fill).not.toHaveBeenCalled();
  });
});

describe("fill: Android", () => {
  it("answers helper when ACTION_SET_TEXT reads back", async () => {
    const helper = helperAnswers({ focused: true, performed: true, verified: true, length: 4 });
    await expect(run({ helper }, ANDROID, "text")).resolves.toEqual({
      method: "helper",
      verified: true,
      length: 4,
    });
    expect(adbShell).not.toHaveBeenCalled();
  });

  it("fails with FILL_NO_FOCUSED_FIELD when no editable node has focus", async () => {
    const helper = helperAnswers({ focused: false, verified: false });
    const err = await failure({ helper }, ANDROID, "x");
    expect(getFailureSignal(err)?.error_code).toBe("FILL_NO_FOCUSED_FIELD");
    expect(adbShell).not.toHaveBeenCalled();
  });

  it("falls back to one keyevent burst and input text on a helper without setText", async () => {
    await expect(run({ helper: helperAnswers(null) }, ANDROID, "abc")).resolves.toEqual({
      method: "keys",
      verified: null,
    });
    expect(adbShell).toHaveBeenCalledTimes(1);
    const command = vi.mocked(adbShell).mock.calls[0]![1];
    expect(command.startsWith("input keyevent ")).toBe(true);
    expect(command.match(/\b67\b/g)).toHaveLength(100);
    expect(command.match(/\b112\b/g)).toHaveLength(100);
    expect(injectAndroidText).toHaveBeenCalledWith(ANDROID, "abc");
  });

  it("falls back to keys when the helper cannot start", async () => {
    await expect(run({ helper: new Error("install failed") }, ANDROID, "")).resolves.toEqual({
      method: "keys",
      verified: null,
    });
    expect(injectAndroidText).not.toHaveBeenCalled();
  });

  it("retries with keys and checks again when the write does not read back", async () => {
    const helper = helperAnswers(
      { focused: true, performed: true, verified: false, length: 1 },
      { focused: true, verified: true, length: 3 }
    );
    await expect(run({ helper }, ANDROID, "abc")).resolves.toEqual({
      method: "keys",
      verified: true,
      length: 3,
    });
    expect(helper.setText).toHaveBeenLastCalledWith("abc", { check: true });
  });

  it("fails without typing when the write does not read back and keys cannot type the text", async () => {
    const helper = helperAnswers({ focused: true, performed: true, verified: false });
    const err = await failure({ helper }, ANDROID, "😀");
    expect(getFailureSignal(err)?.error_code).toBe("FILL_NOT_VERIFIED");
    expect(adbShell).not.toHaveBeenCalled();
  });

  it("refuses an Android TV before touching it", async () => {
    vi.mocked(isAndroidTv).mockResolvedValue(true);
    const helper = helperAnswers();
    const err = await failure({ helper }, ANDROID, "x");
    expect(getFailureSignal(err)?.error_code).toBe("TOOL_CAPABILITY_UNSUPPORTED_OPERATION");
    expect(helper.setText).not.toHaveBeenCalled();
  });

  it("never carries the text in a key-fallback transport error", async () => {
    vi.mocked(injectAndroidText).mockRejectedValueOnce(
      new Error("adb shell input text 'correct horse battery' failed")
    );
    const err = await failure({ helper: helperAnswers(null) }, ANDROID, "correct horse battery");
    expect(err.message).not.toContain("correct horse");
    expect(err.stack ?? "").not.toContain("correct horse");
  });
});

describe("fill: Chromium", () => {
  function cdpAnswering(value: unknown) {
    return { send: vi.fn(async () => ({ result: { value } })) };
  }

  it("answers cdp with the page's verdict", async () => {
    const cdp = cdpAnswering({ status: "ok", verified: true, length: 5 });
    await expect(run({ cdp }, CHROMIUM, "hello")).resolves.toEqual({
      method: "cdp",
      verified: true,
      length: 5,
    });
    const [method, params] = cdp.send.mock.calls[0] as unknown as [string, unknown];
    expect(method).toBe("Runtime.evaluate");
    expect(params).toMatchObject({ awaitPromise: true, returnByValue: true });
  });

  it.each([
    [{ status: "no_focus" }, "FILL_NO_FOCUSED_FIELD"],
    [{ status: "unsupported", detail: "a date input" }, "FILL_UNSUPPORTED_FIELD"],
    [{ status: "ok", verified: false, length: 2 }, "FILL_NOT_VERIFIED"],
    [{ status: "error" }, "FILL_NOT_VERIFIED"],
    [undefined, "FILL_NOT_VERIFIED"],
  ])("maps %j to %s", async (answer, code) => {
    const err = await failure({ cdp: cdpAnswering(answer) }, CHROMIUM, "hello");
    expect(getFailureSignal(err)?.error_code).toBe(code);
  });
});

describe("fill: physical iPhone", () => {
  it("presses Delete 100 times through the runner, then types the text", async () => {
    await expect(run({}, IPHONE, "Zażółć")).resolves.toEqual({ method: "keys", verified: null });
    const calls = vi.mocked(typeText).mock.calls.map(([, , chars]) => chars);
    expect(calls).toEqual(["\b".repeat(100), "Zażółć"]);
  });

  it("maps the runner's no-focus answer to FILL_NO_FOCUSED_FIELD", async () => {
    vi.mocked(typeText).mockRejectedValueOnce(
      new RunnerCommandError("no focus", { code: "TEXT_INPUT_NOT_FOCUSED" })
    );
    const err = await failure({}, IPHONE, "x");
    expect(getFailureSignal(err)?.error_code).toBe("FILL_NO_FOCUSED_FIELD");
  });
});

describe("fill: unsupported targets", () => {
  it("refuses Vega through the capability gate", async () => {
    const err = await failure({}, VEGA, "x");
    expect(getFailureSignal(err)?.error_code).toBe("TOOL_CAPABILITY_UNSUPPORTED_OPERATION");
  });
});

describe("fill: secrets and leaks", () => {
  it("resolves a secret placeholder and returns nothing of it", async () => {
    vi.stubEnv("ARGENT_SECRET_FILL_PW", "hunter2-secret");
    const ax = axAnswers({ focused: true, verified: true, length: 14 });
    const result = await run({ ax }, IOS, "{{secret:FILL_PW}}");
    expect(ax.fill).toHaveBeenCalledWith("hunter2-secret");
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(JSON.stringify(result)).not.toContain("FILL_PW");
  });

  it("names neither the text nor the secret in a failure", async () => {
    vi.stubEnv("ARGENT_SECRET_FILL_PW", "hunter2-secret");
    const ax = axAnswers(
      { focused: true, verified: false, length: 0 },
      { focused: true, verified: false, length: 0 }
    );
    const err = await failure({ ax, sim: simulatorServer() }, IOS, "{{secret:FILL_PW}}");
    expect(getFailureSignal(err)?.error_code).toBe("FILL_NOT_VERIFIED");
    expect(err.message).not.toContain("hunter2");
  });

  it("keeps the text out of every result and error message", async () => {
    const text = "Sup3r-Secr3t-Value";
    const outcomes: unknown[] = [];
    const cases: Array<[Services, string]> = [
      [{ ax: axAnswers({ focused: true, verified: true, length: 18 }) }, IOS],
      [{ ax: axAnswers({ focused: false, verified: false }) }, IOS],
      [{ ax: axAnswers(null), sim: simulatorServer() }, IOS],
      [{ helper: helperAnswers({ focused: true, verified: true, length: 18 }) }, ANDROID],
      [
        {
          helper: helperAnswers(
            { focused: true, verified: false },
            { focused: true, verified: false }
          ),
        },
        ANDROID,
      ],
      [
        {
          cdp: {
            send: vi.fn(async () => ({ result: { value: { status: "ok", verified: false } } })),
          },
        },
        CHROMIUM,
      ],
    ];
    for (const [services, udid] of cases) {
      try {
        outcomes.push(await run(services, udid, text));
      } catch (err) {
        outcomes.push((err as Error).message);
      }
    }
    expect(outcomes).toHaveLength(cases.length);
    expect(JSON.stringify(outcomes)).not.toContain(text);
  });

  it("never quotes the text in its interaction messages", () => {
    const tool = createFillTool(registryWith({}));
    const params = { udid: IOS, text: "Sup3r-Secr3t-Value" };
    const started = tool.interaction?.startedMsg?.({ params } as any);
    const completed = tool.interaction?.completedMsg?.({ params } as any);
    expect(`${started} ${completed}`).not.toContain(params.text);
  });

  it("is hidden from MCP", () => {
    expect(createFillTool(registryWith({})).hideFromMcp).toBe(true);
  });
});
