import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FAILURE_CODES,
  FailureError,
  getFailureSignal,
  ServiceInitializationError,
  type FailureCode,
} from "@argent/registry";
import type { AXFillResponse } from "../src/blueprints/ax-service";
import type { SetTextResult } from "../src/blueprints/android-devtools";

vi.mock("../src/utils/check-deps", () => ({ ensureDeps: vi.fn(async () => {}) }));
vi.mock("../src/utils/ios-devices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/ios-devices")>();
  return { ...actual, isTvOsSimulator: vi.fn(async () => false) };
});
vi.mock("../src/utils/sim-remote", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/sim-remote")>();
  return { ...actual, isRemoteTvOsSimulator: vi.fn(async () => false) };
});
vi.mock("../src/utils/adb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/adb")>();
  return { ...actual, isAndroidTv: vi.fn(async () => false) };
});
vi.mock("../src/utils/ios-device/app-session", () => ({
  requireCurrentIosDeviceApp: vi.fn(() => "com.example.app"),
}));
vi.mock("../src/utils/ios-device/runner-commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/ios-device/runner-commands")>();
  return { ...actual, typeText: vi.fn(async () => ({ reactivated: false })) };
});

import { createFillTool } from "../src/tools/fill";
import { KEY_TIMING } from "../src/tools/fill/keys";
import { isTvOsSimulator } from "../src/utils/ios-devices";
import { isRemoteTvOsSimulator } from "../src/utils/sim-remote";
import { isAndroidTv } from "../src/utils/adb";
import { typeText } from "../src/utils/ios-device/runner-commands";
import { RunnerCommandError } from "../src/utils/ios-device/runner-client";

const IOS = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEFFFF0000";
const REMOTE = "remote:AAAAAAAA-BBBB-CCCC-DDDD-EEEEFFFF0000";
const ANDROID = "emulator-5554";
const CHROMIUM = "chromium-cdp-9222";
const VEGA = "amazon-1234567890";
const IPHONE = "00008120-000154913A05A01E";

const BACKSPACE = 42;

/** Records every key the simulator-server is asked to press. */
function simulatorServer() {
  const keys: Array<[string, number]> = [];
  return {
    keys,
    downs: () => keys.filter(([dir]) => dir === "Down").map(([, code]) => code),
    api: { pressKey: async (dir: string, code: number) => void keys.push([dir, code]) },
  };
}

interface Services {
  ax?: { fill: ReturnType<typeof vi.fn> };
  helper?: { setText: ReturnType<typeof vi.fn> } | Error;
  sim?: ReturnType<typeof simulatorServer>;
  cdp?: { send: ReturnType<typeof vi.fn> } | Error;
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
      if (urn.startsWith("ChromiumCdp:")) {
        if (services.cdp instanceof Error) throw services.cdp;
        return { cdp: services.cdp };
      }
      if (urn.startsWith("IosDeviceRunner:")) return {};
      throw new Error(`unexpected service ${urn}`);
    }),
  } as any;
}

function axAnswers(...answers: AXFillResponse[]) {
  const fill = vi.fn();
  for (const a of answers) fill.mockResolvedValueOnce(a);
  return { fill };
}

function helperAnswers(...answers: SetTextResult[]) {
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

const savedTiming = { ...KEY_TIMING };

beforeEach(() => {
  Object.assign(KEY_TIMING, { holdMs: 0, settleMs: 0, typeDelayMs: 0 });
  vi.mocked(isTvOsSimulator).mockResolvedValue(false);
  vi.mocked(isRemoteTvOsSimulator).mockResolvedValue(false);
  vi.mocked(isAndroidTv).mockResolvedValue(false);
  vi.mocked(typeText).mockReset();
  vi.mocked(typeText).mockResolvedValue({ reactivated: false });
});

afterEach(() => {
  Object.assign(KEY_TIMING, savedTiming);
  vi.unstubAllEnvs();
});

describe("fill: iOS simulator", () => {
  it("answers verified when the ax-service write reads back", async () => {
    const ax = axAnswers({ focused: true, verified: true });
    const sim = simulatorServer();
    await expect(run({ ax, sim }, IOS, "hello")).resolves.toEqual({ verified: true });
    expect(ax.fill).toHaveBeenCalledWith("hello", { typeable: true });
    expect(sim.keys).toHaveLength(0);
  });

  it("tells the daemon text with a newline cannot be typed into a secure field", async () => {
    const ax = axAnswers({ focused: true, verified: true });
    await run({ ax }, IOS, "a\nb");
    expect(ax.fill).toHaveBeenCalledWith("a\nb", { typeable: false });
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

  it("refuses a newline for a single-line field, with nothing typed", async () => {
    const ax = axAnswers({ focused: true, verified: false, singleLine: true });
    const sim = simulatorServer();
    const err = await failure({ ax, sim }, IOS, "a\nb");
    expect(getFailureSignal(err)?.error_code).toBe("FILL_UNSUPPORTED_FIELD");
    expect(err.message).toContain("newline");
    expect(sim.keys).toHaveLength(0);
  });

  it("fails with FILL_NOT_VERIFIED, saying the field may have changed, when the daemon timed out", async () => {
    const ax = axAnswers({ focused: true, verified: false, timedOut: true });
    const err = await failure({ ax, sim: simulatorServer() }, IOS, "abc");
    expect(getFailureSignal(err)).toMatchObject({
      error_code: "FILL_NOT_VERIFIED",
      error_kind: "timeout",
    });
    expect(err.message).toContain("may have changed");
  });

  it("says nothing was changed when the daemon could not select the text", async () => {
    const ax = axAnswers({ focused: true, verified: false, untouched: true });
    const sim = simulatorServer();
    const err = await failure({ ax, sim }, IOS, "abc");
    expect(getFailureSignal(err)?.error_code).toBe("FILL_NOT_VERIFIED");
    expect(err.message).toContain("nothing was changed");
    expect(err.message).not.toContain("may");
    expect(sim.keys).toHaveLength(0);
  });

  it("keeps 'may hold other text' for a read-back that does not match", async () => {
    const ax = axAnswers({ focused: true, verified: false });
    const err = await failure({ ax, sim: simulatorServer() }, IOS, "abc");
    expect(err.message).toContain("may hold other or partial text");
  });

  it("fails with FILL_UNSUPPORTED_FIELD on a date or time input", async () => {
    const ax = axAnswers({ focused: true, verified: false, unsupported: true });
    const sim = simulatorServer();
    const err = await failure({ ax, sim }, IOS, "2024-01-01");
    expect(getFailureSignal(err)?.error_code).toBe("FILL_UNSUPPORTED_FIELD");
    expect(sim.keys).toHaveLength(0);
  });

  it("fails with FILL_NOT_VERIFIED when the write does not read back", async () => {
    const ax = axAnswers({ focused: true, verified: false });
    const sim = simulatorServer();
    const err = await failure({ ax, sim }, IOS, "abc");
    expect(getFailureSignal(err)?.error_code).toBe("FILL_NOT_VERIFIED");
    expect(sim.keys).toHaveLength(0);
    expect(ax.fill).toHaveBeenCalledTimes(1);
  });

  describe("secure field", () => {
    it("types into the field the daemon cleared, then checks it", async () => {
      const ax = axAnswers(
        { focused: true, verified: false, secure: true, cleared: true },
        { focused: true, verified: true }
      );
      const sim = simulatorServer();
      await expect(run({ ax, sim }, IOS, "ab")).resolves.toEqual({ verified: true });
      // No delete burst: the daemon cleared it. Only a (4) and b (5).
      expect(sim.downs()).toEqual([4, 5]);
      expect(ax.fill).toHaveBeenLastCalledWith("ab", { check: true });
    });

    it("says nothing was changed, typing nothing, when the daemon could not select it", async () => {
      const ax = axAnswers({
        focused: true,
        verified: false,
        secure: true,
        cleared: false,
        untouched: true,
      });
      const sim = simulatorServer();
      const err = await failure({ ax, sim }, IOS, "ab");
      expect(getFailureSignal(err)?.error_code).toBe("FILL_NOT_VERIFIED");
      expect(err.message).toContain("nothing was changed");
      expect(sim.keys).toHaveLength(0);
    });

    it("fails without typing when the daemon could not clear it", async () => {
      const ax = axAnswers({ focused: true, verified: false, secure: true, cleared: false });
      const sim = simulatorServer();
      const err = await failure({ ax, sim }, IOS, "ab");
      expect(getFailureSignal(err)?.error_code).toBe("FILL_NOT_VERIFIED");
      expect(sim.keys).toHaveLength(0);
    });

    it("refuses text keys cannot type, and the daemon left the field as it was", async () => {
      const ax = axAnswers({ focused: true, verified: false, secure: true });
      const sim = simulatorServer();
      const err = await failure({ ax, sim }, IOS, "pässword");
      expect(getFailureSignal(err)?.error_code).toBe("FILL_UNSUPPORTED_FIELD");
      expect(ax.fill).toHaveBeenCalledWith("pässword", { typeable: false });
      expect(sim.keys).toHaveLength(0);
    });

    it("fails when the typed text does not read back", async () => {
      const ax = axAnswers(
        { focused: true, verified: false, secure: true, cleared: true },
        { focused: true, verified: false }
      );
      const err = await failure({ ax, sim: simulatorServer() }, IOS, "ab");
      expect(getFailureSignal(err)?.error_code).toBe("FILL_NOT_VERIFIED");
    });
  });

  it("clears a web password input with one backspace when the daemon asks for it", async () => {
    const ax = axAnswers(
      { focused: true, verified: false, needsBackspace: true },
      { focused: true, verified: true }
    );
    const sim = simulatorServer();
    await expect(run({ ax, sim }, IOS, "")).resolves.toEqual({ verified: true });
    expect(sim.keys).toEqual([
      ["Down", BACKSPACE],
      ["Up", BACKSPACE],
    ]);
  });

  it("fails when the backspace did not clear the web password input", async () => {
    const ax = axAnswers(
      { focused: true, verified: false, needsBackspace: true },
      { focused: true, verified: false }
    );
    const sim = simulatorServer();
    const err = await failure({ ax, sim }, IOS, "");
    expect(getFailureSignal(err)?.error_code).toBe("FILL_NOT_VERIFIED");
    expect(sim.downs()).toEqual([BACKSPACE]);
  });

  it("refuses a tvOS simulator before touching it", async () => {
    vi.mocked(isTvOsSimulator).mockResolvedValue(true);
    const ax = axAnswers();
    const err = await failure({ ax }, IOS, "x");
    expect(getFailureSignal(err)?.error_code).toBe("TOOL_CAPABILITY_UNSUPPORTED_OPERATION");
    expect(ax.fill).not.toHaveBeenCalled();
  });

  it("refuses a remote tvOS simulator before touching it", async () => {
    vi.mocked(isRemoteTvOsSimulator).mockResolvedValue(true);
    const ax = axAnswers();
    const err = await failure({ ax }, REMOTE, "x");
    expect(getFailureSignal(err)?.error_code).toBe("TOOL_CAPABILITY_UNSUPPORTED_OPERATION");
    expect(ax.fill).not.toHaveBeenCalled();
  });
});

describe("fill: Android", () => {
  it("answers verified when ACTION_SET_TEXT reads back", async () => {
    const helper = helperAnswers({ focused: true, performed: true, verified: true });
    await expect(run({ helper }, ANDROID, "text")).resolves.toEqual({ verified: true });
  });

  it("fails with FILL_NO_FOCUSED_FIELD when no editable node has focus", async () => {
    const helper = helperAnswers({ focused: false, verified: false });
    const err = await failure({ helper }, ANDROID, "x");
    expect(getFailureSignal(err)?.error_code).toBe("FILL_NO_FOCUSED_FIELD");
  });

  it("fails with FILL_NOT_VERIFIED when the write does not read back", async () => {
    const helper = helperAnswers({ focused: true, performed: true, verified: false });
    const err = await failure({ helper }, ANDROID, "x\ny");
    expect(getFailureSignal(err)?.error_code).toBe("FILL_NOT_VERIFIED");
    expect(helper.setText).toHaveBeenCalledTimes(1);
  });

  it("refuses a newline for a single-line field", async () => {
    const helper = helperAnswers({ focused: true, verified: false, singleLine: true });
    const err = await failure({ helper }, ANDROID, "a\nb");
    expect(getFailureSignal(err)?.error_code).toBe("FILL_UNSUPPORTED_FIELD");
  });

  it("fails with FILL_NOT_VERIFIED, saying the field may have changed, when the helper timed out", async () => {
    const helper = helperAnswers({ focused: true, verified: false, timedOut: true });
    const err = await failure({ helper }, ANDROID, "abc");
    expect(getFailureSignal(err)).toMatchObject({
      error_code: "FILL_NOT_VERIFIED",
      error_kind: "timeout",
    });
    expect(err.message).toContain("may have changed");
  });

  it("refuses an Android TV before touching it", async () => {
    vi.mocked(isAndroidTv).mockResolvedValue(true);
    const helper = helperAnswers();
    const err = await failure({ helper }, ANDROID, "x");
    expect(getFailureSignal(err)?.error_code).toBe("TOOL_CAPABILITY_UNSUPPORTED_OPERATION");
    expect(helper.setText).not.toHaveBeenCalled();
  });
});

describe("fill: Chromium", () => {
  function cdpAnswering(value: unknown) {
    return { send: vi.fn(async () => ({ result: { value } })) };
  }

  function cdpError(code: FailureCode) {
    return new FailureError("cdp failed", {
      error_code: code,
      failure_stage: "debugger_cdp_send",
      failure_area: "tool_server",
      error_kind: "timeout",
    });
  }

  it("answers with the page's verdict, after a no-op the page answered", async () => {
    const cdp = cdpAnswering({ status: "ok", verified: true });
    await expect(run({ cdp }, CHROMIUM, "hello")).resolves.toEqual({ verified: true });
    const calls = cdp.send.mock.calls as unknown as Array<
      [string, Record<string, unknown>, number]
    >;
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(["Runtime.evaluate", { expression: "0" }, 2_000]);
    expect(calls[1]![0]).toBe("Runtime.evaluate");
    expect(calls[1]![1]).toMatchObject({ awaitPromise: true, returnByValue: true });
    expect(calls[1]![1].expression).toContain('"hello"');
    expect(calls[1]![2]).toBe(10_000);
  });

  it("sends nothing that writes to a page that does not answer the no-op", async () => {
    const cdp = {
      send: vi.fn().mockRejectedValue(cdpError(FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT)),
    };
    const err = await failure({ cdp }, CHROMIUM, "hello");
    expect(getFailureSignal(err)).toMatchObject({
      error_code: "FILL_NOT_VERIFIED",
      error_kind: "timeout",
      failure_stage: "fill_chromium_page_blocked",
    });
    expect(err.message).toContain("fill changed nothing");
    expect(cdp.send).toHaveBeenCalledTimes(1);
  });

  it("says the field may still change when the page does not finish the fill in time", async () => {
    const cdp = { send: vi.fn() };
    cdp.send.mockResolvedValueOnce({ result: { value: 0 } });
    cdp.send.mockRejectedValueOnce(cdpError(FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT));
    const err = await failure({ cdp }, CHROMIUM, "hello");
    expect(getFailureSignal(err)).toMatchObject({
      error_code: "FILL_NOT_VERIFIED",
      error_kind: "timeout",
      failure_stage: "fill_chromium_timeout",
    });
    expect(err.message).toContain("may still change when the page resumes");
  });

  function connectError(code: FailureCode) {
    return new ServiceInitializationError("ChromiumCdp:x", "connect failed", {
      cause: cdpError(code),
    });
  }

  it("maps a connect timeout, which wrote nothing", async () => {
    const cdp = connectError(FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT);
    const err = await failure({ cdp }, CHROMIUM, "hello");
    expect(getFailureSignal(err)).toMatchObject({
      error_code: "FILL_NOT_VERIFIED",
      error_kind: "timeout",
      failure_stage: "fill_chromium_connect",
    });
    expect(err.message).toContain("fill changed nothing");
  });

  it("passes any other connect failure through", async () => {
    const cdp = connectError(FAILURE_CODES.DEBUGGER_CDP_NOT_CONNECTED);
    const err = await failure({ cdp }, CHROMIUM, "hello");
    expect(getFailureSignal(err)?.error_code).toBe("DEBUGGER_CDP_NOT_CONNECTED");
  });

  it("passes any other CDP failure through", async () => {
    const cdp = {
      send: vi.fn().mockRejectedValue(cdpError(FAILURE_CODES.DEBUGGER_CDP_NOT_CONNECTED)),
    };
    const err = await failure({ cdp }, CHROMIUM, "hello");
    expect(getFailureSignal(err)?.error_code).toBe("DEBUGGER_CDP_NOT_CONNECTED");
  });

  it.each([
    [{ status: "no_focus" }, "FILL_NO_FOCUSED_FIELD"],
    [{ status: "unsupported", detail: "a date input" }, "FILL_UNSUPPORTED_FIELD"],
    [{ status: "ok", verified: false }, "FILL_NOT_VERIFIED"],
    [{ status: "error" }, "FILL_NOT_VERIFIED"],
    [undefined, "FILL_NOT_VERIFIED"],
  ])("maps %j to %s", async (answer, code) => {
    const err = await failure({ cdp: cdpAnswering(answer) }, CHROMIUM, "hello");
    expect(getFailureSignal(err)?.error_code).toBe(code);
  });
});

describe("fill: physical iPhone", () => {
  it("presses Delete 100 times through the runner, then types the text", async () => {
    await expect(run({}, IPHONE, "Zażółć")).resolves.toEqual({ verified: false });
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
    const ax = axAnswers({ focused: true, verified: true });
    const result = await run({ ax }, IOS, "{{secret:FILL_PW}}");
    expect(ax.fill).toHaveBeenCalledWith("hunter2-secret", { typeable: true });
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(JSON.stringify(result)).not.toContain("FILL_PW");
  });

  it("names neither the text nor the secret in a failure", async () => {
    vi.stubEnv("ARGENT_SECRET_FILL_PW", "hunter2-secret");
    const ax = axAnswers({ focused: true, verified: false });
    const err = await failure({ ax, sim: simulatorServer() }, IOS, "{{secret:FILL_PW}}");
    expect(getFailureSignal(err)?.error_code).toBe("FILL_NOT_VERIFIED");
    expect(err.message).not.toContain("hunter2");
  });

  it("keeps the text out of every result and error message", async () => {
    const text = "Sup3r-Secr3t-Value";
    const cases: Array<[Services, string]> = [
      [{ ax: axAnswers({ focused: true, verified: true }) }, IOS],
      [{ ax: axAnswers({ focused: false, verified: false }) }, IOS],
      [{ helper: helperAnswers({ focused: true, verified: true }) }, ANDROID],
      [{ helper: helperAnswers({ focused: true, verified: false }) }, ANDROID],
      [
        {
          cdp: {
            send: vi.fn(async () => ({ result: { value: { status: "ok", verified: false } } })),
          },
        },
        CHROMIUM,
      ],
    ];
    const outcomes: unknown[] = [];
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
