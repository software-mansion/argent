import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { createPasteTool } from "../src/tools/paste";
import { UnsupportedOperationError } from "../src/utils/capability";

vi.mock("../src/utils/check-deps", () => ({ ensureDeps: vi.fn(async () => {}) }));
vi.mock("../src/utils/ios-devices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/ios-devices")>();
  return { ...actual, isTvOsSimulator: vi.fn(async () => false) };
});
vi.mock("../src/utils/adb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/adb")>();
  return { ...actual, isAndroidTv: vi.fn(async () => false) };
});
vi.mock("../src/utils/android-input", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/android-input")>();
  return { ...actual, injectAndroidKeycode: vi.fn(async () => {}) };
});

import { isTvOsSimulator } from "../src/utils/ios-devices";
import { isAndroidTv } from "../src/utils/adb";
import { injectAndroidKeycode } from "../src/utils/android-input";

const IOS_UDID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEFFFF0000";
const ANDROID_SERIAL = "emulator-5554";
const ANDROID_PHONE_SERIAL = "R5CT10ABCDE";
const CHROMIUM_UDID = "chromium-cdp-9222";
const VEGA_SERIAL = "vega-00000000";
const API_URL = "http://127.0.0.1:49152";

/** A fake simulator-server API recording the HID key events it receives. */
function fakeApi() {
  const keys: Array<[string, number]> = [];
  return {
    keys,
    api: {
      apiUrl: API_URL,
      pressKey: (direction: string, code: number) => keys.push([direction, code]),
    },
  };
}

function toolFor(api: unknown) {
  return createPasteTool({ resolveService: vi.fn(async () => api) } as any);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("paste tool", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => jsonResponse(200, { status: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe("iOS simulator", () => {
    it("fills the device clipboard over HTTP, then presses ⌘V as a chord", async () => {
      const { api, keys } = fakeApi();

      const result = await toolFor(api).execute({}, { udid: IOS_UDID, text: "123456" });

      expect(result).toEqual({ pasted: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${API_URL}/api/clipboard/text`);
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({ text: "123456" });
      // ⌘ down, V down, V up, ⌘ up — a real chord, never a bare "v".
      expect(keys).toEqual([
        ["Down", 0xe3],
        ["Down", 0x19],
        ["Up", 0x19],
        ["Up", 0xe3],
      ]);
    });

    it("presses nothing when the clipboard cannot be set", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { error: "no pasteboard server" }));
      const { api, keys } = fakeApi();

      const err = await toolFor(api)
        .execute({}, { udid: IOS_UDID, text: "x" })
        .catch((e: unknown) => e);
      expect((err as Error).message).toContain("no pasteboard server");
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.PASTE_CLIPBOARD_SET_FAILED);
      expect(keys).toEqual([]);
    });

    it("reports a simulator-server without the clipboard route as unsupported", async () => {
      // axum answers an unknown route with a bare 404 and an empty body.
      fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }));
      const { api, keys } = fakeApi();

      const err = await toolFor(api)
        .execute({}, { udid: IOS_UDID, text: "x" })
        .catch((e: unknown) => e);
      expect((err as Error).message).toMatch(/no clipboard endpoint.*keyboard tool/s);
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.PASTE_CLIPBOARD_UNSUPPORTED);
      expect(keys).toEqual([]);
    });

    it("serializes concurrent pastes on one device so each fill precedes its own chord", async () => {
      const events: string[] = [];
      const api = {
        apiUrl: API_URL,
        pressKey: (direction: string, code: number) => events.push(`key ${direction} ${code}`),
      };
      fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
        events.push(`fill ${JSON.parse(String(init.body)).text}`);
        return jsonResponse(200, { status: "ok" });
      });
      const tool = toolFor(api);

      await Promise.all([
        tool.execute({}, { udid: IOS_UDID, text: "first" }),
        tool.execute({}, { udid: IOS_UDID, text: "second" }),
      ]);

      expect(events).toEqual([
        "fill first",
        "key Down 227",
        "key Down 25",
        "key Up 25",
        "key Up 227",
        "fill second",
        "key Down 227",
        "key Down 25",
        "key Up 25",
        "key Up 227",
      ]);
    });

    it("keeps queuing after a failed paste on the same device", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { error: "boom" }));
      const { api, keys } = fakeApi();
      const tool = toolFor(api);

      const [first, second] = await Promise.allSettled([
        tool.execute({}, { udid: IOS_UDID, text: "a" }),
        tool.execute({}, { udid: IOS_UDID, text: "b" }),
      ]);

      expect(first.status).toBe("rejected");
      expect(second.status).toBe("fulfilled");
      expect(keys).toHaveLength(4);
    });

    it("rejects a tvOS simulator before resolving a simulator-server", async () => {
      vi.mocked(isTvOsSimulator).mockResolvedValueOnce(true);
      const resolveService = vi.fn();
      const tool = createPasteTool({ resolveService } as any);

      await expect(tool.execute({}, { udid: IOS_UDID, text: "x" })).rejects.toBeInstanceOf(
        UnsupportedOperationError
      );
      expect(resolveService).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("Android emulator", () => {
    it("fills the clipboard, then injects KEYCODE_PASTE over adb", async () => {
      const { api, keys } = fakeApi();

      const result = await toolFor(api).execute({}, { udid: ANDROID_SERIAL, text: "otp-42" });

      expect(result).toEqual({ pasted: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))
      ).toEqual({ text: "otp-42" });
      expect(vi.mocked(injectAndroidKeycode)).toHaveBeenCalledWith(ANDROID_SERIAL, 279);
      // No HID chord on Android — the emulator drops those on hw.keyboard=no AVDs.
      expect(keys).toEqual([]);
    });

    it("does not press paste when the clipboard set fails", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { error: "grpc unavailable" }));
      const { api } = fakeApi();

      const err = await toolFor(api)
        .execute({}, { udid: ANDROID_SERIAL, text: "x" })
        .catch((e: unknown) => e);
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.PASTE_CLIPBOARD_SET_FAILED);
      expect(vi.mocked(injectAndroidKeycode)).not.toHaveBeenCalled();
    });

    it("rejects an Android TV emulator", async () => {
      vi.mocked(isAndroidTv).mockResolvedValueOnce(true);
      const { api } = fakeApi();

      await expect(
        toolFor(api).execute({}, { udid: ANDROID_SERIAL, text: "x" })
      ).rejects.toBeInstanceOf(UnsupportedOperationError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("capability gate", () => {
    it.each([
      ["a physical Android phone", ANDROID_PHONE_SERIAL],
      ["a Chromium app", CHROMIUM_UDID],
      ["a Vega device", VEGA_SERIAL],
    ])("rejects %s without touching any backend", async (_label, udid) => {
      const resolveService = vi.fn();
      const tool = createPasteTool({ resolveService } as any);

      await expect(tool.execute({}, { udid, text: "x" })).rejects.toBeInstanceOf(
        UnsupportedOperationError
      );
      expect(resolveService).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(vi.mocked(injectAndroidKeycode)).not.toHaveBeenCalled();
    });
  });

  describe("schema", () => {
    it("requires non-empty text", () => {
      const tool = toolFor({});
      expect(tool.zodSchema!.safeParse({ udid: IOS_UDID, text: "" }).success).toBe(false);
      expect(tool.zodSchema!.safeParse({ udid: IOS_UDID }).success).toBe(false);
      expect(tool.zodSchema!.safeParse({ udid: IOS_UDID, text: "a" }).success).toBe(true);
    });

    it("tells the agent paste is not a keyboard substitute", () => {
      const { description } = toolFor({});
      expect(description).toMatch(/Do NOT use this in place of `keyboard`/);
      expect(description).toMatch(/where a real user would paste/);
    });
  });

  it("routes an ios-remote simulator through the transport's paste primitive", async () => {
    const paste = vi.fn(async () => {});
    const api = { apiUrl: "moq+remote://x", pressKey: vi.fn(), transport: { paste } };
    vi.doMock("../src/utils/sim-remote", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/utils/sim-remote")>();
      return { ...actual, isRemoteTvOsSimulator: vi.fn(async () => false) };
    });
    const { createPasteTool: create } = await import("../src/tools/paste");
    const tool = create({ resolveService: vi.fn(async () => api) } as any);

    await expect(tool.execute({}, { udid: `remote:${IOS_UDID}`, text: "abc" })).resolves.toEqual({
      pasted: true,
    });
    expect(paste).toHaveBeenCalledWith("abc");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.pressKey).not.toHaveBeenCalled();
  });
});
