import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKeyboardTool } from "../src/tools/keyboard";
import { createPasteTool } from "../src/tools/paste";
import {
  availableSecretNames,
  redactSecretsFromError,
  resolveSecretPlaceholders,
  type SecretSourceOptions,
} from "../src/utils/secrets";
import { InvalidToolInputError } from "../src/utils/capability";

vi.mock("../src/utils/simulator-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/simulator-client")>();
  return { ...actual, sendCommand: vi.fn(), setSimulatorClipboardText: vi.fn() };
});
// The paste tool probes the runtime kind before touching the simulator-server;
// stub it so the test never shells out to `simctl`.
vi.mock("../src/utils/ios-devices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/ios-devices")>();
  return { ...actual, isTvOsSimulator: vi.fn(async () => false) };
});
vi.mock("../src/utils/check-deps", () => ({ ensureDeps: vi.fn(async () => {}) }));

import { sendCommand, setSimulatorClipboardText } from "../src/utils/simulator-client";

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

/**
 * A sandboxed pair of scopes: an empty project directory (marked, so the
 * project-root walk-up stops there) and an empty home. Secret resolution reads
 * the real filesystem, so every case anchors both scopes here — otherwise a
 * stray `.env` in the checkout, or the developer's own
 * `~/.argent/secrets.env`, would decide the result.
 */
let sandbox: { project: string; home: string; options: SecretSourceOptions };

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

/** Options anchored at the sandbox, with `env` as the only environment source. */
function opts(env: NodeJS.ProcessEnv = ENV): SecretSourceOptions {
  return { ...sandbox.options, env };
}

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "argent-secrets-"));
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  // A project marker so `findProjectRoot` stops here instead of walking out of
  // the temp directory and into whatever lies above it.
  fs.writeFileSync(path.join(project, "package.json"), "{}");
  sandbox = { project, home, options: { cwd: project, homeDir: home } };
  // The tool paths (below) resolve with no options at all, so the sandbox has
  // to reach them through the process itself.
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.spyOn(process, "cwd").mockReturnValue(project);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(sendCommand).mockReset();
  fs.rmSync(path.dirname(sandbox.project), { recursive: true, force: true });
});

describe("resolveSecretPlaceholders", () => {
  it("substitutes a placeholder with the prefixed env var's value", () => {
    const { text, secrets } = resolveSecretPlaceholders("{{secret:APP_PASSWORD}}", opts());
    expect(text).toBe("hunter2");
    expect(secrets).toEqual([{ name: "APP_PASSWORD", value: "hunter2" }]);
  });

  it("substitutes placeholders embedded in longer text, repeats included", () => {
    const { text, secrets } = resolveSecretPlaceholders(
      "user:{{secret:APP_PASSWORD}}:{{secret:TOTP_SEED}}:{{secret:APP_PASSWORD}}",
      opts()
    );
    expect(text).toBe("user:hunter2:JBSWY3DP:hunter2");
    // Each secret is reported once, however many times it appears.
    expect(secrets.map((s) => s.name)).toEqual(["APP_PASSWORD", "TOTP_SEED"]);
  });

  it("returns text unchanged with no placeholders", () => {
    const { text, secrets } = resolveSecretPlaceholders("plain text", opts());
    expect(text).toBe("plain text");
    expect(secrets).toEqual([]);
  });

  it("rejects an unknown name, listing available names but never values", () => {
    let caught: Error | undefined;
    try {
      resolveSecretPlaceholders("{{secret:NOPE}}", opts());
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
    expect(() => resolveSecretPlaceholders("{{secret:X}}", opts({ PATH: "/bin" }))).toThrow(
      /\(none\)/
    );
  });

  it("ignores malformed placeholders (bad name, wrong shape)", () => {
    const raw = "{{secret:has-dash}} {{secret}} {secret:APP_PASSWORD}";
    expect(resolveSecretPlaceholders(raw, opts()).text).toBe(raw);
  });

  it("accepts a redundant ARGENT_SECRET_ prefix in the name, any casing", () => {
    for (const spelling of [
      "{{secret:ARGENT_SECRET_APP_PASSWORD}}",
      "{{secret:Argent_SECRET_APP_PASSWORD}}",
      "{{secret:argent_secret_APP_PASSWORD}}",
    ]) {
      const { text, secrets } = resolveSecretPlaceholders(spelling, opts());
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
    expect(resolveSecretPlaceholders("{{secret:ARGENT_SECRET_X}}", opts(env)).text).toBe("literal");
  });

  it("quotes the typed name but recommends the canonical var when both spellings miss", () => {
    let caught: Error | undefined;
    try {
      resolveSecretPlaceholders("{{secret:ARGENT_SECRET_NOPE}}", opts());
    } catch (err) {
      caught = err as Error;
    }
    expect(caught!.message).toContain('Unknown secret "ARGENT_SECRET_NOPE"');
    expect(caught!.message).toContain("export ARGENT_SECRET_NOPE");
    expect(caught!.message).not.toContain("ARGENT_SECRET_ARGENT_SECRET_NOPE");
  });
});

describe("secrets from dotenv files", () => {
  // Source semantics (exposure rules, precedence, degradation) are covered in
  // @argent/configuration-core; these cases pin what this layer adds — that the
  // chain is actually consulted, and that a miss explains itself.
  const NO_ENV: NodeJS.ProcessEnv = { PATH: "/bin" };
  const projectSecrets = () => path.join(sandbox.project, ".argent", "secrets.env");
  const globalSecrets = () => path.join(sandbox.home, ".argent", "secrets.env");

  /**
   * Just the enumerated source list from an unknown-name error — the placement
   * advice below it names the same files as *suggestions*, so assertions about
   * what was actually consulted have to read this block alone.
   */
  const sourcesBlock = (message: string) =>
    message.split("first match wins:\n")[1]!.split("\nTo make it available")[0]!;

  it("substitutes a placeholder from a secrets file, not just the environment", () => {
    writeFile(projectSecrets(), "APP_PASSWORD=from-project\n");
    const { text, secrets } = resolveSecretPlaceholders("{{secret:APP_PASSWORD}}", opts(NO_ENV));
    expect(text).toBe("from-project");
    // Recorded like any other secret, so redaction covers a file-sourced value.
    expect(secrets).toEqual([{ name: "APP_PASSWORD", value: "from-project" }]);
  });

  it("reads the whole chain against one snapshot per call", () => {
    writeFile(projectSecrets(), "A=1\n");
    writeFile(globalSecrets(), "B=2\n");
    expect(resolveSecretPlaceholders("{{secret:A}}/{{secret:B}}", opts(NO_ENV)).text).toBe("1/2");
  });

  it("lists the sources it consulted, with paths and never a value", () => {
    writeFile(projectSecrets(), "OTHER=secret-value\n");
    writeFile(path.join(sandbox.project, ".env"), "UNPREFIXED=app-config\n");
    let caught: Error | undefined;
    try {
      resolveSecretPlaceholders("{{secret:MISSING}}", opts(NO_ENV));
    } catch (err) {
      caught = err as Error;
    }
    const block = sourcesBlock(caught!.message);
    expect(block).toContain(projectSecrets());
    expect(block).toContain(path.join(sandbox.project, ".env.local"));
    expect(block).toContain(globalSecrets());
    expect(block).toContain("not found");
    // A shared file that exists but exposes nothing says why, so "my .env has
    // it" does not read as "argent ignored my file".
    expect(block).toContain("only prefixed keys are exposed");
    expect(caught!.message).not.toContain("secret-value");
    expect(caught!.message).not.toContain("app-config");
  });

  it("reaches the tools, which resolve against the running process's scopes", async () => {
    writeFile(globalSecrets(), "APP_PASSWORD=hunter2\n");
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
});

describe("availableSecretNames", () => {
  it("lists only prefixed vars, sorted, without the prefix", () => {
    expect(availableSecretNames(opts())).toEqual(["APP_PASSWORD", "TOTP_SEED"]);
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

  it("redacts the same way whatever order the secrets arrive in", () => {
    const host = { name: "HOST", value: "api.example.com" };
    const url = { name: "URL", value: "https://api.example.com/v1/tok-9d3f0a1b2c" };
    const text = `calling ${url.value} now`;
    for (const order of [
      [host, url],
      [url, host],
    ]) {
      const err = new Error(text);
      redactSecretsFromError(err, order);
      expect(err.message).toBe("calling {{secret:URL}} now");
    }
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
  function pasteRegistry() {
    const api = { apiUrl: "http://127.0.0.1:1", pressKey: vi.fn() };
    return { api, tool: createPasteTool(registryWith(api)) };
  }

  it("pastes the resolved value without echoing it", async () => {
    vi.stubEnv("ARGENT_SECRET_APP_PASSWORD", "hunter2");
    const { api, tool } = pasteRegistry();

    const result = await tool.execute({}, { udid: IOS_UDID, text: "{{secret:APP_PASSWORD}}" });

    expect(vi.mocked(setSimulatorClipboardText)).toHaveBeenCalledWith(api, "hunter2");
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("scrubs the resolved value from backend errors", async () => {
    vi.stubEnv("ARGENT_SECRET_APP_PASSWORD", "hunter2");
    vi.mocked(setSimulatorClipboardText).mockImplementationOnce(async () => {
      throw new Error("paste failed for: hunter2");
    });
    const { tool } = pasteRegistry();

    await expect(
      tool.execute({}, { udid: IOS_UDID, text: "{{secret:APP_PASSWORD}}" })
    ).rejects.toThrow(/paste failed for: \{\{secret:APP_PASSWORD\}\}/);
  });
});
