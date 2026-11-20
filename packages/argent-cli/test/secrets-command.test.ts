import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { secrets } from "../src/secrets.js";
import { SECRET_ENV_PREFIX } from "@argent/configuration-core";

// Real-filesystem integration test, mirroring config-command.test.ts: drives the
// actual `secrets()` entry point against a sandboxed global home (HOME) and
// project cwd (a tmp dir with a `.git` marker so the project root resolves
// there). The point of this command is that it never prints a value, so most
// cases assert on what the output does NOT contain.

// A linked remote tool-server would add a caveat line; the routing lookup reads
// real state on the machine running the tests, so pin it to "not linked".
const linked = vi.hoisted(() => ({ url: null as string | null }));
vi.mock("@argent/tools-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@argent/tools-client")>()),
  getResolvedToolsUrl: async () => ({ url: linked.url, token: null }),
}));

let homeDir: string;
let projectDir: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalCwd: string;
let clearedSecretEnv: [string, string][];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

const output = () => logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

beforeEach(() => {
  homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-sec-home-")));
  projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-sec-proj-")));
  fs.mkdirSync(path.join(projectDir, ".git"), { recursive: true });
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalCwd = process.cwd();
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.chdir(projectDir);
  // The environment is a secret source in its own right, ranked above every
  // file this test writes. An ARGENT_SECRET_<NAME> exported in the developer's
  // shell — argent's own documented way to supply one — therefore joins the
  // listings below as an extra name, and shadows a fixture that shares its
  // name. This package has no ARGENT_*-stripping setup file, so clear them
  // here.
  clearedSecretEnv = Object.entries(process.env)
    .filter((e): e is [string, string] => e[0].startsWith(SECRET_ENV_PREFIX) && e[1] !== undefined)
    .map(([k, v]) => [k, v]);
  for (const [k] of clearedSecretEnv) delete process.env[k];
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never);
});

afterEach(() => {
  linked.url = null;
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  for (const [k, v] of clearedSecretEnv) process.env[k] = v;
  vi.restoreAllMocks();
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("argent secrets", () => {
  it("lists names per source without printing a value", async () => {
    write(path.join(projectDir, ".argent", "secrets.env"), "APP_PASSWORD=hunter2\n");
    write(path.join(homeDir, ".argent", "secrets.env"), "TOTP_SEED=JBSWY3DP\n");

    await secrets([]);

    const out = output();
    expect(out).toContain("APP_PASSWORD");
    expect(out).toContain("TOTP_SEED");
    expect(out).toContain(path.join(projectDir, ".argent", "secrets.env"));
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("JBSWY3DP");
  });

  it("marks a name a nearer source already claimed", async () => {
    write(path.join(projectDir, ".argent", "secrets.env"), "APP_USER=project\n");
    write(path.join(projectDir, ".env"), "ARGENT_SECRET_APP_USER=dotenv\n");

    await secrets([]);

    const out = output();
    expect(out).toContain("APP_USER (shadowed above)");
    expect(out).toContain("1 name in effect: APP_USER");
    expect(out).not.toContain("dotenv");
  });

  it("marks sources that are absent, and explains one that needs the prefix", async () => {
    write(path.join(projectDir, ".env"), "STRIPE_SECRET_KEY=sk_live_x\n");

    await secrets(["list"]);

    const out = output();
    expect(out).toContain("not found");
    expect(out).toContain("only prefixed keys are exposed");
    expect(out).toContain("No secrets are defined.");
    expect(out).not.toContain("sk_live_x");
  });

  it("emits machine-readable names and sources with --json", async () => {
    write(path.join(projectDir, ".argent", "secrets.env"), "APP_PASSWORD=hunter2\n");

    await secrets(["--json"]);

    const parsed = JSON.parse(output()) as {
      secrets: string[];
      sources: Array<{ source: string; present: boolean; names: string[] }>;
    };
    expect(parsed.secrets).toEqual(["APP_PASSWORD"]);
    expect(parsed.sources.some((s) => s.present && s.names.includes("APP_PASSWORD"))).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain("hunter2");
  });

  it("documents where to add a secret in --help", async () => {
    await secrets(["--help"]);
    const out = output();
    expect(out).toContain("~/.argent/secrets.env");
    expect(out).toContain("ARGENT_SECRET_");
    expect(out).toContain("gitignore this file");
  });

  it.each([
    [false, "http://192.0.2.10:3001", "Run `argent enable forward-secrets`"],
    [true, "https://192.0.2.10:3001", "A call sends it the value `argent secrets` lists"],
    [true, "http://127.0.0.1:3001", "A call sends it the value `argent secrets` lists"],
    [
      true,
      "http://192.0.2.10:3001",
      "refuses a call that names a secret of this machine: http://192.0.2.10:3001 is reached neither over https://",
    ],
    [true, "127.0.0.1:3001", "of this machine: 127.0.0.1:3001 is not a URL."],
  ])("with forward-secrets %s and a link to %s, says what a call sends", async (on, url, note) => {
    if (on)
      write(path.join(projectDir, ".argent", "flags.json"), '{"flags":{"forward-secrets":true}}');
    linked.url = url;
    await secrets([]);
    expect(output()).toContain(`Note: a remote tool-server is linked (${url}). `);
    expect(output()).toContain(note);
  });

  it("says forward-secrets refuses an https link whose certificate is not checked", async () => {
    write(path.join(projectDir, ".argent", "flags.json"), '{"flags":{"forward-secrets":true}}');
    linked.url = "https://192.0.2.10:3001";
    vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    try {
      await secrets([]);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(output()).toContain(
      "of this machine: NODE_TLS_REJECT_UNAUTHORIZED=0 turns off the certificate check of https://192.0.2.10:3001. Unset it"
    );
  });

  it("rejects an unknown subcommand", async () => {
    await expect(secrets(["frobnicate"])).rejects.toThrow(ExitError);
    expect(errSpy.mock.calls.join(" ")).toContain('unknown subcommand "secrets frobnicate"');
  });
});
