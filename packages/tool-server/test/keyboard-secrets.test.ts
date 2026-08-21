import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKeyboardTool } from "../src/tools/keyboard";
import { pasteTool } from "../src/tools/paste";
import {
  availableSecretNames,
  redactSecretsFromError,
  resolveSecretPlaceholders,
  type SecretSourceOptions,
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
  let cleared = false;
  let probes = 0;
  return {
    chars,
    api: {
      dispatchKeyEvent: async (event: { type: string; text?: string; commands?: string[] }) => {
        if (event.commands) cleared = true;
        if (event.type === "char" && event.text) chars.push(event.text);
      },
      // Only the FIRST probe resolves-and-parks the focused editable; every
      // later one re-reads that parked element. A `{ clear, text }` call issues
      // three of them (resolve, read-back, post-typing release), so alternating
      // the two payload shapes would hand the third the `FocusedEditable` shape:
      // it carries no `tracked`, and the focus-split check that reads it would
      // fall through untested — the one path that quotes a page-supplied label
      // back alongside a resolved secret. A stub answering only the first probe
      // sends every clear down the best-effort branch instead of the one
      // production takes against a page it can read. Report a field that is
      // populated until the clear runs, and that keeps focus afterwards (the
      // ordinary shape — a field that blurs on empty refuses the typing).
      evaluate: async () => {
        probes++;
        return JSON.stringify(
          probes === 1
            ? { verdict: "editable", label: "INPUT#pw", length: 8, mac: true, parked: true }
            : { tracked: true, focused: true, length: cleared ? 0 : 8 }
        );
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

  it("clears then types the secret, echoing the placeholder and keeping `cleared`", async () => {
    // `execute` re-wraps the backend result to swap the resolved value back out
    // for the placeholder (`{ ...result, typed: params.text }`). That spread has
    // to carry `cleared` through — losing it would report a replace-a-field call
    // as a plain append.
    vi.stubEnv("ARGENT_SECRET_APP_PASSWORD", "hunter2");
    const { api, chars } = recordingCdpApi();
    const tool = createKeyboardTool(registryWith(api));

    const result = await tool.execute(
      {},
      { udid: CHROMIUM_UDID, clear: true, text: "{{secret:APP_PASSWORD}}", delayMs: 0 }
    );

    expect(chars.join("")).toBe("hunter2");
    expect(result.typed).toBe("{{secret:APP_PASSWORD}}");
    expect(result.cleared).toBe(true);
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("says nothing about the secret's length when the page split it across fields", async () => {
    // The one clear-path failure that quotes a page-supplied field label back
    // into the agent's context, and the one that would otherwise quote how many
    // characters landed — which for a password is credential material.
    vi.stubEnv("ARGENT_SECRET_APP_PASSWORD", "hunter2");
    let probes = 0;
    const api = {
      dispatchKeyEvent: async () => {},
      evaluate: async () => {
        probes++;
        if (probes === 1) {
          return JSON.stringify({
            verdict: "editable",
            label: "INPUT#pw",
            length: 8,
            mac: true,
            parked: true,
            secret: true,
          });
        }
        // Probe 2 is the clear's read-back (empty, focus held); probe 3 is the
        // post-typing release, by which point the page has moved focus and only
        // part of the value is in the field.
        return JSON.stringify(
          probes === 2
            ? { tracked: true, length: 0, focused: true, secret: true }
            : { tracked: true, length: 1, focused: false, secret: true }
        );
      },
    };
    const tool = createKeyboardTool(registryWith(api));

    let caught: Error | undefined;
    try {
      await tool.execute(
        {},
        { udid: CHROMIUM_UDID, clear: true, text: "{{secret:APP_PASSWORD}}", delayMs: 0 }
      );
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/not all of the text reached/);
    expect(caught!.message).not.toContain("hunter2");
    expect(caught!.message).not.toMatch(/\b7 of\b/);
  });

  it("says nothing about its length when the field itself is not a password", async () => {
    // The page-side `secret` flag is `type === "password"` alone, so it is false
    // for every other box a credential is typed into: an API-key field, a TOTP
    // input, a password field a show/hide control has switched to `type="text"`.
    // The REQUEST is what makes the count sensitive here, and `redactSecrets-
    // FromError` substitutes the value string — it cannot redact a number.
    vi.stubEnv("ARGENT_SECRET_APP_PASSWORD", "hunter2");
    let probes = 0;
    const api = {
      dispatchKeyEvent: async () => {},
      evaluate: async () => {
        probes++;
        if (probes === 1) {
          return JSON.stringify({
            verdict: "editable",
            label: "INPUT#apiKey",
            length: 8,
            mac: true,
            parked: true,
          });
        }
        return JSON.stringify(
          probes === 2
            ? { tracked: true, length: 0, focused: true }
            : { tracked: true, length: 1, focused: false }
        );
      },
    };
    const tool = createKeyboardTool(registryWith(api));

    let caught: Error | undefined;
    try {
      await tool.execute(
        {},
        { udid: CHROMIUM_UDID, clear: true, text: "{{secret:APP_PASSWORD}}", delayMs: 0 }
      );
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/not all of the text reached/);
    expect(caught!.message).not.toMatch(/\b7 character/);
  });

  it("says nothing about the residue's length when the clear was refused", async () => {
    // The sibling of the split message, on the other failure the clear can
    // report. The residue counted here is the field's OWN surviving value, and
    // the box a credential is typed into is usually the box that already holds
    // one — so with a `{{secret:…}}` in the request the count is the previous
    // credential's exact length, in the agent's context, transcript and logs.
    vi.stubEnv("ARGENT_SECRET_APP_PASSWORD", "hunter2");
    let probes = 0;
    const api = {
      dispatchKeyEvent: async () => {},
      evaluate: async () => {
        probes++;
        // A plain `type="text"` API-key box, so the page-side `secret` flag is
        // false and only the REQUEST makes the count sensitive. Probe 2 is the
        // read-back: the page cancelled the chord, so the value survived.
        return JSON.stringify(
          probes === 1
            ? { verdict: "editable", label: "INPUT#apiKey", mac: true, parked: true }
            : { tracked: true, length: 39, focused: true }
        );
      },
    };
    const tool = createKeyboardTool(registryWith(api));

    let caught: Error | undefined;
    try {
      await tool.execute(
        {},
        { udid: CHROMIUM_UDID, clear: true, text: "{{secret:APP_PASSWORD}}", delayMs: 0 }
      );
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/still holds its contents/);
    expect(caught!.message).not.toMatch(/\b39 character/);
  });

  it("still counts the residue of an ordinary clear the page refused", async () => {
    // The other half, again: with no secret in the request the count is what
    // makes the message actionable.
    let probes = 0;
    const api = {
      dispatchKeyEvent: async () => {},
      evaluate: async () => {
        probes++;
        return JSON.stringify(
          probes === 1
            ? { verdict: "editable", label: "INPUT#q", mac: true, parked: true }
            : { tracked: true, length: 39, focused: true }
        );
      },
    };
    const tool = createKeyboardTool(registryWith(api));

    await expect(
      tool.execute({}, { udid: CHROMIUM_UDID, clear: true, text: "plain", delayMs: 0 })
    ).rejects.toThrow(/still holds 39 character\(s\)/);
  });

  it("still counts the characters of ordinary text the page split", async () => {
    // The other half: with no secret in the request the counts are what make the
    // message actionable, so suppressing them everywhere would cost more than it
    // protects.
    let probes = 0;
    const api = {
      dispatchKeyEvent: async () => {},
      evaluate: async () => {
        probes++;
        if (probes === 1) {
          return JSON.stringify({
            verdict: "editable",
            label: "INPUT#apiKey",
            length: 8,
            mac: true,
            parked: true,
          });
        }
        return JSON.stringify(
          probes === 2
            ? { tracked: true, length: 0, focused: true }
            : { tracked: true, length: 1, focused: false }
        );
      },
    };
    const tool = createKeyboardTool(registryWith(api));

    await expect(
      tool.execute({}, { udid: CHROMIUM_UDID, clear: true, text: "hunter2", delayMs: 0 })
    ).rejects.toThrow(/only 1 of the 7 character\(s\)/);
  });

  it("scrubs the resolved value from errors thrown on the clear path", async () => {
    vi.stubEnv("ARGENT_SECRET_APP_PASSWORD", "hunter2");
    const api = {
      // Fail on the clear's very first dispatch, before any character is typed.
      dispatchKeyEvent: async () => {
        throw new Error("CDP rejected clear while typing hunter2");
      },
    };
    const tool = createKeyboardTool(registryWith(api));

    let caught: Error | undefined;
    try {
      await tool.execute(
        {},
        { udid: CHROMIUM_UDID, clear: true, text: "{{secret:APP_PASSWORD}}", delayMs: 0 }
      );
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain("{{secret:APP_PASSWORD}}");
    expect(caught!.message).not.toContain("hunter2");
    expect(caught!.stack ?? "").not.toContain("hunter2");
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
