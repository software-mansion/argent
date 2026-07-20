import { afterEach, describe, expect, it, vi } from "vitest";
import { createKeyboardTool } from "../src/tools/keyboard";
import { pasteTool } from "../src/tools/paste";
import {
  availableSecretNames,
  redactSecretsFromError,
  resolveSecretPlaceholders,
} from "../src/utils/secrets";
import { InvalidToolInputError } from "../src/utils/capability";

vi.mock("../src/utils/simulator-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/simulator-client")>();
  return { ...actual, sendCommand: vi.fn() };
});

import { sendCommand } from "../src/utils/simulator-client";

// The chromium branch resolves its CDP api via registry.resolveService, so a
// stub registry + a chromium-shaped udid exercises the tool's full `execute`
// (resolveDevice → capability gate → dispatch) without any device.
const CHROMIUM_UDID = "chromium-cdp-9222";
const IOS_UDID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEFFFF0000";

function registryWith(api: unknown) {
  return { resolveService: vi.fn(async () => api) } as any;
}

function recordingCdpApi() {
  const chars: string[] = [];
  return {
    chars,
    api: {
      dispatchKeyEvent: async (event: { type: string; text?: string }) => {
        if (event.type === "char" && event.text) chars.push(event.text);
      },
    },
  };
}

const ENV: NodeJS.ProcessEnv = {
  ARGENT_SECRET_APP_PASSWORD: "hunter2",
  ARGENT_SECRET_TOTP_SEED: "JBSWY3DP",
  UNRELATED: "not-a-secret",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(sendCommand).mockReset();
});

describe("resolveSecretPlaceholders", () => {
  it("substitutes a placeholder with the prefixed env var's value", () => {
    const { text, secrets } = resolveSecretPlaceholders("{{secret:APP_PASSWORD}}", ENV);
    expect(text).toBe("hunter2");
    expect(secrets).toEqual([{ name: "APP_PASSWORD", value: "hunter2" }]);
  });

  it("substitutes placeholders embedded in longer text, repeats included", () => {
    const { text, secrets } = resolveSecretPlaceholders(
      "user:{{secret:APP_PASSWORD}}:{{secret:TOTP_SEED}}:{{secret:APP_PASSWORD}}",
      ENV
    );
    expect(text).toBe("user:hunter2:JBSWY3DP:hunter2");
    // Each secret is reported once, however many times it appears.
    expect(secrets.map((s) => s.name)).toEqual(["APP_PASSWORD", "TOTP_SEED"]);
  });

  it("returns text unchanged with no placeholders", () => {
    const { text, secrets } = resolveSecretPlaceholders("plain text", ENV);
    expect(text).toBe("plain text");
    expect(secrets).toEqual([]);
  });

  it("rejects an unknown name, listing available names but never values", () => {
    let caught: Error | undefined;
    try {
      resolveSecretPlaceholders("{{secret:NOPE}}", ENV);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(InvalidToolInputError);
    expect(caught!.message).toContain('Unknown secret "NOPE"');
    expect(caught!.message).toContain("ARGENT_SECRET_NOPE");
    expect(caught!.message).toContain("APP_PASSWORD");
    expect(caught!.message).toContain("TOTP_SEED");
    expect(caught!.message).not.toContain("hunter2");
    expect(caught!.message).not.toContain("JBSWY3DP");
  });

  it("says (none) when no secrets are exposed", () => {
    expect(() => resolveSecretPlaceholders("{{secret:X}}", { PATH: "/bin" })).toThrow(/\(none\)/);
  });

  it("ignores malformed placeholders (bad name, wrong shape)", () => {
    const raw = "{{secret:has-dash}} {{secret}} {secret:APP_PASSWORD}";
    expect(resolveSecretPlaceholders(raw, ENV).text).toBe(raw);
  });

  it("accepts a redundant ARGENT_SECRET_ prefix in the name, any casing", () => {
    for (const spelling of [
      "{{secret:ARGENT_SECRET_APP_PASSWORD}}",
      "{{secret:Argent_SECRET_APP_PASSWORD}}",
      "{{secret:argent_secret_APP_PASSWORD}}",
    ]) {
      const { text, secrets } = resolveSecretPlaceholders(spelling, ENV);
      expect(text).toBe("hunter2");
      // The recorded name is canonical, so error/redaction output steers
      // toward the correct spelling.
      expect(secrets).toEqual([{ name: "APP_PASSWORD", value: "hunter2" }]);
    }
  });

  it("prefers an exact match over prefix-stripping", () => {
    const env: NodeJS.ProcessEnv = {
      ARGENT_SECRET_ARGENT_SECRET_X: "literal",
      ARGENT_SECRET_X: "bare",
    };
    expect(resolveSecretPlaceholders("{{secret:ARGENT_SECRET_X}}", env).text).toBe("literal");
  });

  it("quotes the typed name but recommends the canonical var when both spellings miss", () => {
    let caught: Error | undefined;
    try {
      resolveSecretPlaceholders("{{secret:ARGENT_SECRET_NOPE}}", ENV);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught!.message).toContain('Unknown secret "ARGENT_SECRET_NOPE"');
    expect(caught!.message).toContain("export ARGENT_SECRET_NOPE");
    expect(caught!.message).not.toContain("ARGENT_SECRET_ARGENT_SECRET_NOPE");
  });
});

describe("availableSecretNames", () => {
  it("lists only prefixed vars, sorted, without the prefix", () => {
    expect(availableSecretNames(ENV)).toEqual(["APP_PASSWORD", "TOTP_SEED"]);
  });
});

describe("redactSecretsFromError", () => {
  it("scrubs values from message and stack, preserving the error class", () => {
    const err = new InvalidToolInputError("adb input text hunter2 failed");
    const out = redactSecretsFromError(err, [{ name: "APP_PASSWORD", value: "hunter2" }]);
    expect(out).toBe(err);
    expect(err.message).toBe("adb input text {{secret:APP_PASSWORD}} failed");
    expect(err.name).toBe("InvalidToolInputError");
    expect(err.stack ?? "").not.toContain("hunter2");
  });

  it("skips empty values instead of corrupting the message", () => {
    const err = new Error("boom");
    redactSecretsFromError(err, [{ name: "EMPTY", value: "" }]);
    expect(err.message).toBe("boom");
  });
});

describe("keyboard tool with secret placeholders", () => {
  it("types the resolved value but echoes the placeholder in `typed`", async () => {
    vi.stubEnv("ARGENT_SECRET_APP_PASSWORD", "hunter2");
    const { api, chars } = recordingCdpApi();
    const tool = createKeyboardTool(registryWith(api));

    const result = await tool.execute(
      {},
      { udid: CHROMIUM_UDID, text: "{{secret:APP_PASSWORD}}", delayMs: 0 }
    );

    expect(chars.join("")).toBe("hunter2");
    expect(result.typed).toBe("{{secret:APP_PASSWORD}}");
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("leaves plain text calls untouched", async () => {
    const { api, chars } = recordingCdpApi();
    const tool = createKeyboardTool(registryWith(api));

    const result = await tool.execute({}, { udid: CHROMIUM_UDID, text: "hello", delayMs: 0 });

    expect(chars.join("")).toBe("hello");
    expect(result.typed).toBe("hello");
  });

  it("rejects an unknown secret before any key event is dispatched", async () => {
    const dispatchKeyEvent = vi.fn(async () => {});
    const tool = createKeyboardTool(registryWith({ dispatchKeyEvent }));

    await expect(
      tool.execute({}, { udid: CHROMIUM_UDID, text: "{{secret:MISSING}}", delayMs: 0 })
    ).rejects.toThrow(/Unknown secret "MISSING"/);
    expect(dispatchKeyEvent).not.toHaveBeenCalled();
  });

  it("scrubs the resolved value from backend errors", async () => {
    vi.stubEnv("ARGENT_SECRET_APP_PASSWORD", "hunter2");
    const api = {
      dispatchKeyEvent: async () => {
        throw new Error("CDP rejected input: hunter2");
      },
    };
    const tool = createKeyboardTool(registryWith(api));

    let caught: Error | undefined;
    try {
      await tool.execute({}, { udid: CHROMIUM_UDID, text: "{{secret:APP_PASSWORD}}", delayMs: 0 });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain("{{secret:APP_PASSWORD}}");
    expect(caught!.message).not.toContain("hunter2");
    expect(caught!.stack ?? "").not.toContain("hunter2");
  });
});

describe("paste tool with secret placeholders", () => {
  it("pastes the resolved value without echoing it", async () => {
    vi.stubEnv("ARGENT_SECRET_APP_PASSWORD", "hunter2");

    const result = await pasteTool.execute(
      { simulatorServer: {} },
      { udid: IOS_UDID, text: "{{secret:APP_PASSWORD}}" }
    );

    expect(vi.mocked(sendCommand)).toHaveBeenCalledWith({}, { cmd: "paste", text: "hunter2" });
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("scrubs the resolved value from backend errors", async () => {
    vi.stubEnv("ARGENT_SECRET_APP_PASSWORD", "hunter2");
    vi.mocked(sendCommand).mockImplementationOnce(() => {
      throw new Error("paste failed for: hunter2");
    });

    await expect(
      pasteTool.execute(
        { simulatorServer: {} },
        { udid: IOS_UDID, text: "{{secret:APP_PASSWORD}}" }
      )
    ).rejects.toThrow(/paste failed for: \{\{secret:APP_PASSWORD\}\}/);
  });
});
