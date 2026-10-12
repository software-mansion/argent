import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFailureSignal } from "@argent/registry";
import type { AXFillResponse, AXTreeNode, AXTreeResponse } from "../src/blueprints/ax-service";
import type { SetTextResult } from "../src/blueprints/android-devtools";
import type { UiTree, UiTreeNode } from "../src/tools/ui-tree";

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
  return { ...actual, isAndroidTv: vi.fn(async () => false), adbShell: vi.fn(async () => "") };
});
vi.mock("../src/utils/android-input", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/android-input")>();
  return { ...actual, injectAndroidText: vi.fn(async () => {}) };
});
vi.mock("../src/tools/ui-tree/android", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/ui-tree/android")>();
  return { ...actual, readAndroidUiTree: vi.fn() };
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
import { textMatches } from "../src/tools/fill/text-match";
import { isTvOsSimulator } from "../src/utils/ios-devices";
import { isRemoteTvOsSimulator } from "../src/utils/sim-remote";
import { adbShell, isAndroidTv } from "../src/utils/adb";
import { injectAndroidText } from "../src/utils/android-input";
import { readAndroidUiTree } from "../src/tools/ui-tree/android";
import { typeText } from "../src/utils/ios-device/runner-commands";
import { RunnerCommandError } from "../src/utils/ios-device/runner-client";

const IOS = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEFFFF0000";
const REMOTE = "remote:AAAAAAAA-BBBB-CCCC-DDDD-EEEEFFFF0000";
const ANDROID = "emulator-5554";
const CHROMIUM = "chromium-cdp-9222";
const VEGA = "amazon-1234567890";
const IPHONE = "00008120-000154913A05A01E";

const BACKSPACE = 42;
const ARROW_RIGHT = 79;

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
  ax?: { fill: ReturnType<typeof vi.fn>; tree?: ReturnType<typeof vi.fn> };
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
  return { fill, tree: vi.fn(async (): Promise<AXTreeResponse> => treeOf()) };
}

function treeOf(...nodes: Array<Partial<AXTreeNode>>): AXTreeResponse {
  return {
    alertVisible: false,
    truncated: false,
    nodes: nodes.map((n, index) => ({ index, ...n })),
  };
}

const focusedIos = (extra: Partial<AXTreeNode> = {}): Partial<AXTreeNode> => ({
  traits: ["textEntry", "isEditing"],
  ...extra,
});

function helperAnswers(...answers: Array<SetTextResult | null>) {
  const setText = vi.fn();
  for (const a of answers) setText.mockResolvedValueOnce(a);
  return { setText };
}

function androidTree(...nodes: Array<Partial<UiTreeNode>>): UiTree {
  return {
    schemaVersion: 1,
    source: "android-devtools",
    truncated: false,
    unsupportedFields: [],
    roots: [
      { role: "Screen", children: nodes.map((n) => ({ role: "TextField", children: [], ...n })) },
    ],
  };
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
  Object.assign(KEY_TIMING, { holdMs: 0, cadenceMs: 0, settleMs: 0, typeDelayMs: 0 });
  vi.mocked(isTvOsSimulator).mockResolvedValue(false);
  vi.mocked(isRemoteTvOsSimulator).mockResolvedValue(false);
  vi.mocked(isAndroidTv).mockResolvedValue(false);
  vi.mocked(adbShell).mockClear();
  vi.mocked(injectAndroidText).mockClear();
  vi.mocked(readAndroidUiTree).mockReset();
  vi.mocked(typeText).mockReset();
  vi.mocked(typeText).mockResolvedValue({ reactivated: false });
});

afterEach(() => {
  Object.assign(KEY_TIMING, savedTiming);
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
    expect(ax.fill).toHaveBeenCalledWith("hello", { typeable: true });
    expect(sim.keys).toHaveLength(0);
  });

  it("tells the daemon text with a newline cannot be typed into a secure field", async () => {
    const ax = axAnswers({ focused: true, verified: true, length: 3 });
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

  it("fails with FILL_UNSUPPORTED_FIELD on a date or time input", async () => {
    const ax = axAnswers({ focused: true, verified: false, unsupported: true });
    const sim = simulatorServer();
    const err = await failure({ ax, sim }, IOS, "2024-01-01");
    expect(getFailureSignal(err)?.error_code).toBe("FILL_UNSUPPORTED_FIELD");
    expect(sim.keys).toHaveLength(0);
  });

  it("fails with FILL_NOT_VERIFIED, and never falls back to keys, when the write does not read back", async () => {
    const ax = axAnswers({ focused: true, verified: false, length: 3 });
    const sim = simulatorServer();
    const err = await failure({ ax, sim }, IOS, "abc");
    expect(getFailureSignal(err)?.error_code).toBe("FILL_NOT_VERIFIED");
    expect(sim.keys).toHaveLength(0);
    expect(ax.fill).toHaveBeenCalledTimes(1);
  });

  describe("secure field", () => {
    it("types into the field the daemon cleared, then checks it", async () => {
      const ax = axAnswers(
        { focused: true, verified: false, secure: true, cleared: true, length: 0 },
        { focused: true, verified: true, length: 2 }
      );
      const sim = simulatorServer();
      await expect(run({ ax, sim }, IOS, "ab")).resolves.toEqual({
        method: "keys",
        verified: true,
        length: 2,
      });
      // No delete burst: the daemon cleared it. Only a (4) and b (5).
      expect(sim.downs()).toEqual([4, 5]);
      expect(ax.fill).toHaveBeenLastCalledWith("ab", { check: true });
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
        { focused: true, verified: false, length: 1 }
      );
      const err = await failure({ ax, sim: simulatorServer() }, IOS, "ab");
      expect(getFailureSignal(err)?.error_code).toBe("FILL_NOT_VERIFIED");
    });
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

  it("fails when the backspace did not clear the web password input", async () => {
    const ax = axAnswers(
      { focused: true, verified: false, needsBackspace: true, length: 8 },
      { focused: true, verified: false, length: 8 }
    );
    const sim = simulatorServer();
    const err = await failure({ ax, sim }, IOS, "");
    expect(getFailureSignal(err)?.error_code).toBe("FILL_NOT_VERIFIED");
    expect(sim.downs()).toEqual([BACKSPACE]);
  });

  describe("ax-service without fill", () => {
    it("sizes the burst from the focused input, then reads the text back", async () => {
      const ax = axAnswers(null);
      ax.tree
        .mockResolvedValueOnce(treeOf({ label: "App" }, focusedIos({ value: "abcd" })))
        .mockResolvedValueOnce(treeOf({ label: "App" }, focusedIos({ value: "Hi" })));
      const sim = simulatorServer();
      await expect(run({ ax, sim }, IOS, "Hi")).resolves.toEqual({
        method: "keys",
        verified: true,
        length: 2,
      });
      // 5 Right Arrows put the caret at the end, 5 Backspaces clear, then H i.
      expect(sim.downs()).toEqual([
        ...Array(5).fill(ARROW_RIGHT),
        ...Array(5).fill(BACKSPACE),
        225, // Shift for H
        11,
        12,
      ]);
    });

    it("fails with FILL_NOT_VERIFIED when the typed text reads back different", async () => {
      // iOS capitalized the first letter.
      const ax = axAnswers(null);
      ax.tree
        .mockResolvedValueOnce(treeOf(focusedIos({ value: "" })))
        .mockResolvedValueOnce(treeOf(focusedIos({ value: "Abc" })));
      const err = await failure({ ax, sim: simulatorServer() }, IOS, "abc");
      expect(getFailureSignal(err)?.error_code).toBe("FILL_NOT_VERIFIED");
    });

    it("accepts a placeholder as an empty field after a clear", async () => {
      const ax = axAnswers(null);
      ax.tree
        .mockResolvedValueOnce(treeOf(focusedIos({ value: "abc" })))
        .mockResolvedValueOnce(
          treeOf(focusedIos({ value: "Email", placeholder: "Email", hintShowing: true }))
        );
      await expect(run({ ax, sim: simulatorServer() }, IOS, "")).resolves.toEqual({
        method: "keys",
        verified: true,
        length: 0,
      });
    });

    it("fails with FILL_NO_FOCUSED_FIELD, sending nothing, when the tree has no focused input", async () => {
      const ax = axAnswers(null);
      ax.tree.mockResolvedValueOnce(treeOf({ label: "App" }, { traits: ["textEntry"] }));
      const sim = simulatorServer();
      const err = await failure({ ax, sim }, IOS, "x");
      expect(getFailureSignal(err)?.error_code).toBe("FILL_NO_FOCUSED_FIELD");
      expect(sim.keys).toHaveLength(0);
    });

    it("refuses a newline for a single-line input, and allows it in a text view", async () => {
      const ax = axAnswers(null);
      ax.tree.mockResolvedValueOnce(treeOf(focusedIos({ value: "" })));
      const sim = simulatorServer();
      const err = await failure({ ax, sim }, IOS, "a\nb");
      expect(getFailureSignal(err)?.error_code).toBe("FILL_UNSUPPORTED_FIELD");
      expect(sim.keys).toHaveLength(0);

      const view = axAnswers(null);
      view.tree
        .mockResolvedValueOnce(
          treeOf(focusedIos({ value: "", traits: ["textEntry", "isEditing", "textView"] }))
        )
        .mockResolvedValueOnce(
          treeOf(focusedIos({ value: "a\nb", traits: ["textEntry", "isEditing", "textView"] }))
        );
      await expect(run({ ax: view, sim: simulatorServer() }, IOS, "a\nb")).resolves.toMatchObject({
        method: "keys",
        verified: true,
      });
    });

    it("sends the full burst, unverified, when the daemon has no tree either", async () => {
      const ax = axAnswers(null);
      ax.tree.mockRejectedValue(new Error("ax-service predates `tree`; update argent"));
      const sim = simulatorServer();
      await expect(run({ ax, sim }, IOS, "")).resolves.toEqual({ method: "keys", verified: null });
      expect(sim.downs().filter((c) => c === BACKSPACE)).toHaveLength(100);
      expect(sim.downs().filter((c) => c === ARROW_RIGHT)).toHaveLength(100);
    });

    it("refuses text the keys cannot type before anything is read or sent", async () => {
      const ax = axAnswers(null);
      const sim = simulatorServer();
      const err = await failure({ ax, sim }, IOS, "Zażółć");
      expect(getFailureSignal(err)?.error_code).toBe("KEYBOARD_CHARACTER_UNSUPPORTED");
      expect(ax.tree).not.toHaveBeenCalled();
      expect(sim.keys).toHaveLength(0);
    });
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

  it("fails with FILL_NOT_VERIFIED, and never falls back to keys, when the write does not read back", async () => {
    const helper = helperAnswers({ focused: true, performed: true, verified: false, length: 2 });
    const err = await failure({ helper }, ANDROID, "x\ny");
    expect(getFailureSignal(err)?.error_code).toBe("FILL_NOT_VERIFIED");
    expect(adbShell).not.toHaveBeenCalled();
    expect(helper.setText).toHaveBeenCalledTimes(1);
  });

  describe("helper without setText", () => {
    it("sizes the burst from the focused field and reads the text back", async () => {
      vi.mocked(readAndroidUiTree)
        .mockResolvedValueOnce(androidTree({ focused: true, editable: true, value: "abcd" }))
        .mockResolvedValueOnce(androidTree({ focused: true, editable: true, value: "abc" }));
      await expect(run({ helper: helperAnswers(null) }, ANDROID, "abc")).resolves.toEqual({
        method: "keys",
        verified: true,
        length: 3,
      });
      const command = vi.mocked(adbShell).mock.calls[0]![1];
      expect(command.match(/\b67\b/g)).toHaveLength(5);
      expect(command.match(/\b112\b/g)).toHaveLength(5);
      expect(injectAndroidText).toHaveBeenCalledWith(ANDROID, "abc");
    });

    it("fails with FILL_NO_FOCUSED_FIELD, sending nothing, when no editable node has focus", async () => {
      vi.mocked(readAndroidUiTree).mockResolvedValueOnce(
        androidTree({ focused: false, editable: true, value: "a" })
      );
      const err = await failure({ helper: helperAnswers(null) }, ANDROID, "x");
      expect(getFailureSignal(err)?.error_code).toBe("FILL_NO_FOCUSED_FIELD");
      expect(adbShell).not.toHaveBeenCalled();
    });

    it("gives a password the full burst and answers unverified", async () => {
      vi.mocked(readAndroidUiTree).mockResolvedValueOnce(
        androidTree({ focused: true, editable: true, password: true })
      );
      await expect(run({ helper: helperAnswers(null) }, ANDROID, "pw")).resolves.toEqual({
        method: "keys",
        verified: null,
      });
      expect(vi.mocked(adbShell).mock.calls[0]![1].match(/\b67\b/g)).toHaveLength(100);
    });

    it("fails with FILL_NOT_VERIFIED when the typed text reads back different", async () => {
      vi.mocked(readAndroidUiTree)
        .mockResolvedValueOnce(androidTree({ focused: true, editable: true, value: "" }))
        .mockResolvedValueOnce(androidTree({ focused: true, editable: true, value: "ab" }));
      const err = await failure({ helper: helperAnswers(null) }, ANDROID, "abc");
      expect(getFailureSignal(err)?.error_code).toBe("FILL_NOT_VERIFIED");
    });
  });

  it("falls back to the full burst, unverified, when the helper cannot start", async () => {
    await expect(run({ helper: new Error("install failed") }, ANDROID, "")).resolves.toEqual({
      method: "keys",
      verified: null,
    });
    expect(readAndroidUiTree).not.toHaveBeenCalled();
    expect(vi.mocked(adbShell).mock.calls[0]![1].match(/\b67\b/g)).toHaveLength(100);
    expect(injectAndroidText).not.toHaveBeenCalled();
  });

  it("refuses text the keys cannot type before anything is sent", async () => {
    const err = await failure({ helper: helperAnswers(null) }, ANDROID, "😀");
    expect(getFailureSignal(err)?.error_code).toBe("KEYBOARD_CHARACTER_UNSUPPORTED");
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
    const err = await failure({ helper: new Error("no helper") }, ANDROID, "correct horse battery");
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

describe("textMatches", () => {
  it.each([
    ["abc", "abc", true],
    ["Abc", "abc", false],
    ["•••", "abc", true],
    ["••c", "abc", true],
    ["••", "abc", false],
    ["", "", true],
    ["", "a", false],
    // The same text, decomposed: AX may answer either form.
    ["Zażółć", "Zażółć", true],
  ])("%j shows %j: %s", (current, expected, result) => {
    expect(textMatches(current, expected)).toBe(result);
  });
});

describe("fill: secrets and leaks", () => {
  it("resolves a secret placeholder and returns nothing of it", async () => {
    vi.stubEnv("ARGENT_SECRET_FILL_PW", "hunter2-secret");
    const ax = axAnswers({ focused: true, verified: true, length: 14 });
    const result = await run({ ax }, IOS, "{{secret:FILL_PW}}");
    expect(ax.fill).toHaveBeenCalledWith("hunter2-secret", { typeable: true });
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(JSON.stringify(result)).not.toContain("FILL_PW");
  });

  it("names neither the text nor the secret in a failure", async () => {
    vi.stubEnv("ARGENT_SECRET_FILL_PW", "hunter2-secret");
    const ax = axAnswers({ focused: true, verified: false, length: 0 });
    const err = await failure({ ax, sim: simulatorServer() }, IOS, "{{secret:FILL_PW}}");
    expect(getFailureSignal(err)?.error_code).toBe("FILL_NOT_VERIFIED");
    expect(err.message).not.toContain("hunter2");
  });

  it("keeps the text out of every result and error message", async () => {
    const text = "Sup3r-Secr3t-Value";
    const legacy = axAnswers(null);
    legacy.tree
      .mockResolvedValueOnce(treeOf(focusedIos({ value: "old" })))
      .mockResolvedValueOnce(treeOf(focusedIos({ value: "other" })));
    const cases: Array<[Services, string]> = [
      [{ ax: axAnswers({ focused: true, verified: true, length: 18 }) }, IOS],
      [{ ax: axAnswers({ focused: false, verified: false }) }, IOS],
      [{ ax: legacy, sim: simulatorServer() }, IOS],
      [{ helper: helperAnswers({ focused: true, verified: true, length: 18 }) }, ANDROID],
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
