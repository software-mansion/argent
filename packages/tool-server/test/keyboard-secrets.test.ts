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

  it("scrubs a secret the shell rewrote on its way to the device", () => {
    // The message every backend that shells out produces is a COMMAND LINE, and
    // `shellQuote` (utils/adb.ts, utils/harmony-hdc.ts — the same POSIX escape)
    // turns each `'` into `'\''`. A literal search for the raw value walks past
    // that, so an apostrophe in a password was the difference between a redacted
    // message and the credential handed to the agent in full. Fixtures are the
    // real command lines: `adb shell input text …` and `hdc … uitest uiInput …`.
    const value = "don't-tell";
    const quoted = `'${value.replaceAll("'", `'\\''`)}'`;
    expect(quoted).toBe(`'don'\\''t-tell'`); // the escaping this defends against

    for (const line of [
      `adb shell input text ${quoted} failed`,
      `uitest uiInput text ${quoted} failed on 127.0.0.1:5555: Invalid parameters.`,
    ]) {
      const err = new Error(line);
      redactSecretsFromError(err, [{ name: "APP_PASSWORD", value }]);
      expect(err.message, line).not.toContain("don't-tell");
      // Not just absent — absent because it was REPLACED. A scrub that dropped
      // the fragments would leave `t-tell` behind and still pass the line above.
      expect(err.message, line).toContain("{{secret:APP_PASSWORD}}");
      expect(err.message, line).not.toMatch(/t-tell/);
    }
  });

  it("scrubs the fragment a backend that splits the text leaks", () => {
    // `injectAndroidText` starts a new `adb shell input text` at every `%` so
    // the device never sees a format specifier, and the Android TV remote types
    // one word per space keyevent. The call that fails is the one echoed back,
    // so the message carries a PIECE of the secret — neither the whole value
    // nor its escaping, which is what a whole-value search looks for. The
    // fixtures are built by the real split, not written by hand.
    const percentValue = "Tr0ub4dor&3%xyzzy";
    const segments = percentValue.match(/[^%]*%|[^%]+/g) ?? [];
    expect(segments).toEqual(["Tr0ub4dor&3%", "xyzzy"]);

    for (const segment of segments) {
      const err = new Error(
        `adb -s emulator-5554 shell input text '${segment}' failed: error: device offline`
      );
      redactSecretsFromError(err, [{ name: "APP_PASSWORD", value: percentValue }]);
      expect(err.message, segment).not.toContain(segment);
      expect(err.message, segment).toContain("{{secret:APP_PASSWORD}}");
    }

    const spacedValue = "hunter2 admin";
    for (const word of spacedValue.split(" ")) {
      const err = new Error(`adb -s emulator-5554 shell input text '${word}' failed`);
      redactSecretsFromError(err, [{ name: "APP_PASSWORD", value: spacedValue }]);
      expect(err.message, word).not.toContain(word);
    }
  });

  it("covers both splits for a secret that has a space AND a percent", () => {
    // The two paths cut the same value differently, so only a value with both
    // separators tells them apart: a phone runs `injectAndroidText` over the
    // WHOLE text and breaks at the `%`, while the TV remote hands it one word at
    // a time and each word is broken at its own `%`. Either source alone leaves
    // the other path's piece unredacted.
    // `pass admin%` spans the space, so only the whole-value split yields it;
    // `admin%` is a cut inside the second word, so only the per-word split does.
    const value = "hunter2%pass admin%root";
    for (const piece of ["pass admin%", "admin%"]) {
      const err = new Error(`adb -s emulator-5554 shell input text '${piece}' failed`);
      redactSecretsFromError(err, [{ name: "APP_PASSWORD", value }]);
      expect(err.message, piece).toBe(
        "adb -s emulator-5554 shell input text '{{secret:APP_PASSWORD}}' failed"
      );
    }
  });

  it("redacts a secret shorter than the piece floor when it arrives whole", () => {
    // The floor is about PIECES. A short value still reaches a message intact,
    // and dropping it for being short would hand over the whole credential.
    const err = new Error(
      "uitest uiInput text '911' failed on 127.0.0.1:5555: Invalid parameters."
    );
    redactSecretsFromError(err, [{ name: "PIN", value: "911" }]);
    expect(err.message).toBe(
      "uitest uiInput text '{{secret:PIN}}' failed on 127.0.0.1:5555: Invalid parameters."
    );
  });

  it("leaves the diagnostic readable around the fragment it redacts", () => {
    // Only the pieces the backends really send are searched for, not every
    // substring: a value that merely CONTAINS a word of the diagnostic must not
    // blank it, or the agent is left with a message it cannot act on. Here the
    // secret contains `device` and `adb`, and the split yields neither.
    const err = new Error(
      "adb -s emulator-5554 shell input text 'hunter2%' failed: device offline"
    );
    redactSecretsFromError(err, [{ name: "APP_PASSWORD", value: "hunter2%mydevice-adb" }]);
    expect(err.message).toBe(
      "adb -s emulator-5554 shell input text '{{secret:APP_PASSWORD}}' failed: device offline"
    );
  });

  it("does not redact the marker it just wrote", () => {
    // The marker is text like any other, so a secret with a piece inside
    // `{{secret:` gets re-matched within its own replacement unless the scrub
    // reads only the original — nesting markers until the diagnostic is
    // unreadable. The value has to be one whose SPELLINGS meet the marker for
    // this to bite: `secret pass` splits into `secret`, which does.
    const err = new Error("uitest uiInput text 'secret pass' failed: Invalid parameters.");
    redactSecretsFromError(err, [{ name: "APP_PASSWORD", value: "secret pass" }]);
    expect(err.message).toBe(
      "uitest uiInput text '{{secret:APP_PASSWORD}}' failed: Invalid parameters."
    );
  });

  it("keeps a piece too short to be worth blanking a word for", () => {
    // A word-per-keyevent backend yields pieces as short as one character.
    // Redacting those would replace every `a` in the message; three characters
    // of a credential is not a disclosure worth that. The value never arrives
    // whole here, so nothing should change at all.
    const err = new Error("adb -s emulator-5554 shell input text 'a' failed: device offline");
    const before = err.message;
    redactSecretsFromError(err, [{ name: "APP_PASSWORD", value: "a hunter2" }]);
    expect(err.message).toBe(before);
  });

  it("scrubs a long secret without stalling the server", () => {
    // The scrub runs inside a tool's `execute`, so it is on the event loop a
    // paste of a PEM-sized secret shares with every other call.
    const value = `-----BEGIN PRIVATE KEY-----\n${"MIIEvQIBADANBg".repeat(200)}\n-----END PRIVATE KEY-----`;
    const err = new Error(`adb -s emulator-5554 shell input text '${value}' failed`);
    const startedAt = performance.now();
    redactSecretsFromError(err, [{ name: "KEY", value }]);
    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(err.message).toBe("adb -s emulator-5554 shell input text '{{secret:KEY}}' failed");
  });

  it("redacts a secret past the length a regex could hold", () => {
    // The scrub must not be built out of the secret in a form that can refuse to
    // compile: an alternation `RegExp` throws past 32768 characters, and the
    // `SyntaxError` quotes the pattern — so the one call that exists to keep the
    // credential out of the message would hand over every character of it. A
    // base64 keystore or a cert bundle reaches this size, and `paste` is the
    // documented way to enter one.
    const value = "A".repeat(40_000);
    const err = new Error(
      `adb -s emulator-5554 shell input text '${value}' failed: device offline`
    );
    expect(() => redactSecretsFromError(err, [{ name: "KEY", value }])).not.toThrow();
    expect(err.message).toBe(
      "adb -s emulator-5554 shell input text '{{secret:KEY}}' failed: device offline"
    );
  });

  it("still scrubs the raw value when nothing quoted it", () => {
    // Positive control for the pair above: the backends that inject over HID or
    // CDP never build a shell line, so the value reaches an error message
    // verbatim. A scrub narrowed to the escaped spelling would miss those.
    const err = new Error("No keycode for character in don't-tell");
    redactSecretsFromError(err, [{ name: "APP_PASSWORD", value: "don't-tell" }]);
    expect(err.message).toBe("No keycode for character in {{secret:APP_PASSWORD}}");
  });

  it("leaves a passphrase's ordinary words alone outside an echoed command line", () => {
    // A word-per-keyevent backend echoes ONE WORD back, so its pieces have to
    // be searched for — but a passphrase's pieces ARE ordinary words. Matched
    // globally they blank every `device`, `offline` and `battery` in any
    // diagnostic that happens to share vocabulary with the secret, and the
    // agent loses the actionable half of the message.
    const err = new Error(
      "adb -s emulator-5554 shell input text 'x' failed: error: device offline; the battery is low"
    );
    const before = err.message;
    redactSecretsFromError(err, [
      { name: "PASSPHRASE", value: "correct horse battery staple device offline" },
    ]);
    expect(err.message).toBe(before);
  });

  it("still catches a single echoed word between the quotes of the command line", () => {
    // The shape the word split exists for: the TV remote's failing call quotes
    // exactly the one word it was typing.
    const err = new Error("adb -s emulator-5554 shell input text 'staple' failed");
    redactSecretsFromError(err, [
      { name: "PASSPHRASE", value: "correct horse battery staple device offline" },
    ]);
    expect(err.message).toBe(
      "adb -s emulator-5554 shell input text '{{secret:PASSPHRASE}}' failed"
    );
  });

  it("does not let one secret's piece demote another secret's whole value", () => {
    // The gate travels per spelling TEXT across all secrets in the call: when
    // a passphrase's word IS another secret's entire value, that text must
    // stay matched globally — HID/CDP echoes reach an error message unquoted,
    // and quote-gating it there leaks the other credential in full.
    const message = "device battery drained; HID echoed device verbatim";
    for (const secrets of [
      [
        { name: "PASSPHRASE", value: "correct device battery" },
        { name: "DEVICE", value: "device" },
      ],
      [
        { name: "DEVICE", value: "device" },
        { name: "PASSPHRASE", value: "correct device battery" },
      ],
    ]) {
      const err = new Error(message);
      redactSecretsFromError(err, secrets);
      expect(err.message, JSON.stringify(secrets.map((s) => s.name))).toBe(
        "{{secret:DEVICE}} battery drained; HID echoed {{secret:DEVICE}} verbatim"
      );
    }
  });

  it("redacts a piece at the length floor and passes one below it", () => {
    // Pins the fence from both sides: at MIN-1 a fragment of a live credential
    // silently stopped being redacted once, and only a fixture about piece
    // LENGTH notices. Both fragments arrive quoted, as a per-word backend emits
    // them.
    const errAtFloor = new Error("adb -s emulator-5554 shell input text 'hunt' failed");
    redactSecretsFromError(errAtFloor, [{ name: "APP_PASSWORD", value: "hunt admin" }]);
    expect(errAtFloor.message).toBe(
      "adb -s emulator-5554 shell input text '{{secret:APP_PASSWORD}}' failed"
    );
    const errBelow = new Error("adb -s emulator-5554 shell input text 'hun' failed");
    const before = errBelow.message;
    redactSecretsFromError(errBelow, [{ name: "APP_PASSWORD", value: "hun admin" }]);
    expect(errBelow.message).toBe(before);
  });

  it("scrubs a stack that was already materialised before the call", () => {
    // V8 builds `Error.prototype.stack` lazily from the live message, so a
    // fixture that never touches `.stack` is rendered from the scrubbed message
    // and cannot see the scrub line deleted. Reading the stack first freezes the
    // raw credential into it — which is the state this line exists to clean up.
    const err = new Error("adb -s emulator-5554 shell input text 'hunter2' failed");
    expect(err.stack).toContain("hunter2");
    redactSecretsFromError(err, [{ name: "APP_PASSWORD", value: "hunter2 admin" }]);
    expect(err.stack ?? "").not.toContain("hunter2");
    expect(err.stack ?? "").toContain("{{secret:APP_PASSWORD}}");
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
