import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { providers } from "../src/providers.js";

/**
 * Drive the real `argent providers` entry point against a sandboxed home.
 * Nothing below the command layer is mocked. These descriptors go to a real
 * disk and come back through the same `@argent/device-providers` the
 * tool-server uses, which is the only way to prove `publish` and `list` agree
 * about where the file goes.
 */

/**
 * `process.exit` replaced by a throw, so a command's exit code is assertable.
 */
class Exit extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

let home: string;
let providersDir: string;
let out: string[];
let err: string[];

const IOS_UDID = "1A2B3C4D-5E6F-7081-92A3-B4C5D6E7F809";
const DEAD_PID = 0x7fffffff;

function descriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    devices: [
      {
        capabilities: ["simctl"],
        kind: "simulator",
        name: "iPhone 16 Pro",
        nativeId: IOS_UDID,
        platform: "ios",
        state: "Booted",
      },
    ],
    id: "acme-3f2a9c",
    name: "Acme IDE",
    schemaVersion: 1,
    supportUrl: "https://example.invalid/issues",
    workspace: { name: "my-app", path: "/Users/me/src/my-app" },
    ...overrides,
  };
}

function withStdin(body: string): void {
  Object.defineProperty(process, "stdin", {
    configurable: true,
    value: Readable.from([Buffer.from(body, "utf8")]),
  });
}

/**
 * Run a subcommand, returning the exit code it asked for (0 when it returned).
 */
async function runProviders(...argv: string[]): Promise<number> {
  try {
    await providers(argv);
    return 0;
  } catch (e) {
    if (e instanceof Exit) return e.code;
    throw e;
  }
}

function stdout(): string {
  return out.join("\n");
}

function stderr(): string {
  return err.join("\n");
}

const realStdin = Object.getOwnPropertyDescriptor(process, "stdin")!;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-cli-providers-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  delete process.env.ARGENT_DEVICE_PROVIDERS;
  delete process.env.ARGENT_DISABLE_DEVICE_PROVIDERS;
  providersDir = path.join(home, ".argent", "providers");

  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...args) => void out.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => void err.push(args.join(" ")));
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Exit(code ?? 0);
  }) as never);
});

afterEach(() => {
  Object.defineProperty(process, "stdin", realStdin);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("argent providers publish", () => {
  it("writes the descriptor from stdin to its canonical path", async () => {
    withStdin(JSON.stringify(descriptor()));

    expect(await runProviders("publish", "--stdin", "--pid", String(process.pid))).toBe(0);

    const file = path.join(providersDir, "acme-3f2a9c.json");
    expect(stdout()).toContain(file);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).pid).toBe(process.pid);
  });

  it("reads a descriptor from --file", async () => {
    const source = path.join(home, "descriptor.json");
    fs.writeFileSync(source, JSON.stringify(descriptor()));

    expect(await runProviders("publish", "--file", source)).toBe(0);
    expect(fs.existsSync(path.join(providersDir, "acme-3f2a9c.json"))).toBe(true);
  });

  it("reports an unchanged republish without touching the file", async () => {
    withStdin(JSON.stringify(descriptor()));
    await runProviders("publish", "--stdin", "--pid", String(process.pid));

    withStdin(JSON.stringify(descriptor()));
    out = [];
    expect(await runProviders("publish", "--stdin", "--json", "--pid", String(process.pid))).toBe(
      0
    );

    expect(JSON.parse(stdout()).changed).toBe(false);
  });

  it("exits 1 with the issues on stderr for a descriptor argent would reject", async () => {
    withStdin(JSON.stringify(descriptor({ id: "Not A Slug" })));

    expect(await runProviders("publish", "--stdin")).toBe(1);
    expect(stderr()).toContain("id:");
    expect(fs.existsSync(providersDir)).toBe(false);
  });

  it("exits 1 for a document that is not JSON", async () => {
    withStdin("{ not json");
    expect(await runProviders("publish", "--stdin")).toBe(1);
    expect(stderr()).toContain("not valid JSON");
  });

  it("exits 1 for a schemaVersion argent does not understand", async () => {
    withStdin(JSON.stringify(descriptor({ schemaVersion: 2 })));
    expect(await runProviders("publish", "--stdin")).toBe(1);
    expect(stderr()).toContain("schemaVersion is 2");
  });

  /** A real hole, but not a failure — not every provider can name a process. */
  it("warns, but succeeds, when nothing supplies a pid", async () => {
    withStdin(JSON.stringify(descriptor()));

    expect(await runProviders("publish", "--stdin")).toBe(0);
    expect(stderr()).toContain("no pid recorded");
  });

  it("exits 2 when given neither --file nor --stdin", async () => {
    expect(await runProviders("publish")).toBe(2);
    expect(stderr()).toContain("--file");
  });

  it("exits 2 for a --pid that is not a positive integer", async () => {
    expect(await runProviders("publish", "--stdin", "--pid", "nope")).toBe(2);
  });

  /** This replaces a provider's startup cleanup, so it must happen on publish. */
  it("prunes orphaned descriptors on the way through", async () => {
    fs.mkdirSync(providersDir, { recursive: true });
    const orphan = path.join(providersDir, "zenith-dead.json");

    fs.writeFileSync(
      orphan,
      JSON.stringify(descriptor({ devices: [], id: "zenith-dead", pid: DEAD_PID }))
    );

    withStdin(JSON.stringify(descriptor()));
    expect(await runProviders("publish", "--stdin", "--json", "--pid", String(process.pid))).toBe(
      0
    );

    expect(JSON.parse(stdout()).pruned).toEqual([orphan]);
    expect(fs.existsSync(orphan)).toBe(false);
  });
});

describe("argent providers withdraw", () => {
  it("removes a published descriptor", async () => {
    withStdin(JSON.stringify(descriptor()));
    await runProviders("publish", "--stdin", "--pid", String(process.pid));

    out = [];

    expect(await runProviders("withdraw", "acme-3f2a9c", "--json")).toBe(0);
    expect(JSON.parse(stdout()).removed).toBe(true);
    expect(fs.existsSync(path.join(providersDir, "acme-3f2a9c.json"))).toBe(false);
  });

  it("succeeds, reporting nothing removed, for an id that was never published", async () => {
    expect(await runProviders("withdraw", "never-published", "--json")).toBe(0);
    expect(JSON.parse(stdout()).removed).toBe(false);
  });

  it("exits 2 rather than letting a path escape the providers directory", async () => {
    expect(await runProviders("withdraw", "../../etc/passwd")).toBe(2);
    expect(stderr()).toContain("not a valid provider id");
  });

  it("exits 2 when no id is given", async () => {
    expect(await runProviders("withdraw")).toBe(2);
  });
});

describe("argent providers list", () => {
  it("reports nothing when no provider is registered", async () => {
    expect(await runProviders("list", "--json")).toBe(0);
    expect(JSON.parse(stdout())).toMatchObject({ ok: true, providers: [] });
  });

  it("reports the provider, its devices and its liveness", async () => {
    withStdin(JSON.stringify(descriptor()));
    await runProviders("publish", "--stdin", "--pid", String(process.pid));
    out = [];

    expect(await runProviders("list", "--json")).toBe(0);

    const payload = JSON.parse(stdout());
    expect(payload.directory).toBe(providersDir);
    expect(payload.providers).toHaveLength(1);

    const [provider] = payload.providers;

    expect(provider).toMatchObject({
      id: "acme-3f2a9c",
      invalidDevices: 0,
      name: "Acme IDE",
      pid: process.pid,
      processAlive: true,
      supportUrl: "https://example.invalid/issues",
      workspace: { name: "my-app", path: "/Users/me/src/my-app" },
    });

    expect(provider.devices).toEqual([
      {
        capabilities: ["simctl"],
        id: `ext:acme-3f2a9c:${IOS_UDID}`,
        name: "iPhone 16 Pro",
        nativeId: IOS_UDID,
        platform: "ios",
        state: "Booted",
      },
    ]);
  });

  /**
   * `list` is the support view: a partly-rejected descriptor must still show
   * up, or the user goes looking in the wrong place.
   */
  it("counts device entries argent would reject rather than hiding the provider", async () => {
    fs.mkdirSync(providersDir, { recursive: true });
    fs.writeFileSync(
      path.join(providersDir, "acme-3f2a9c.json"),
      JSON.stringify(descriptor({ devices: [{ nativeId: "junk" }] }))
    );

    expect(await runProviders("list", "--json")).toBe(0);

    const [provider] = JSON.parse(stdout()).providers;
    expect(provider.devices).toEqual([]);
    expect(provider.invalidDevices).toBe(1);
  });

  it("leaves the providers directory untouched", async () => {
    withStdin(JSON.stringify(descriptor({ pid: DEAD_PID })));
    await runProviders("publish", "--stdin");
    const before = fs.readdirSync(providersDir);

    await runProviders("list", "--json");

    expect(fs.readdirSync(providersDir)).toEqual(before);
  });
});

describe("argent providers prune", () => {
  function writeOrphan(id: string, pid: number): string {
    fs.mkdirSync(providersDir, { recursive: true });
    const file = path.join(providersDir, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify(descriptor({ devices: [], id, pid })));
    return file;
  }

  it("removes a descriptor whose process is gone", async () => {
    const file = writeOrphan("acme-dead", DEAD_PID);

    expect(await runProviders("prune", "--json")).toBe(0);
    expect(JSON.parse(stdout()).pruned.map((entry: { path: string }) => entry.path)).toEqual([
      file,
    ]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("removes nothing under --dry-run", async () => {
    const file = writeOrphan("acme-dead", DEAD_PID);

    expect(await runProviders("prune", "--dry-run", "--json")).toBe(0);

    const payload = JSON.parse(stdout());
    expect(payload.dryRun).toBe(true);
    expect(payload.pruned).toHaveLength(1);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("keeps a descriptor whose process is alive", async () => {
    const file = writeOrphan("acme-live", process.pid);
    expect(await runProviders("prune", "--json")).toBe(0);
    expect(JSON.parse(stdout()).pruned).toEqual([]);
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe("argent providers dispatch", () => {
  it("exits 2 on an unknown subcommand", async () => {
    expect(await runProviders("frobnicate")).toBe(2);
  });

  it("exits 2 with no subcommand at all", async () => {
    expect(await runProviders()).toBe(2);
  });

  it("prints help for every subcommand without doing anything", async () => {
    for (const subcommand of ["check", "publish", "withdraw", "list", "prune"]) {
      expect(await runProviders(subcommand, "--help")).toBe(0);
    }

    expect(stdout()).toContain("Usage: argent providers <subcommand>");
    expect(fs.existsSync(providersDir)).toBe(false);
  });

  it("exits 2 on a stray operand for a subcommand that takes none", async () => {
    expect(await runProviders("list", "acme")).toBe(2);
  });
});

describe("argent providers check", () => {
  it("reports a conformant descriptor as ok", async () => {
    withStdin(JSON.stringify(descriptor()));
    await runProviders("publish", "--stdin", "--pid", String(process.pid));
    out = [];

    expect(await runProviders("check", "--json")).toBe(0);

    const payload = JSON.parse(stdout());
    expect(payload.ok).toBe(true);
    expect(payload.providers[0].id).toBe("acme-3f2a9c");
  });

  it("warns about a descriptor with no pid", async () => {
    const source = path.join(home, "descriptor.json");
    fs.writeFileSync(source, JSON.stringify(descriptor()));

    expect(await runProviders("check", "--file", source, "--json")).toBe(0);

    const messages = JSON.parse(stdout()).providers[0].findings.map(
      (finding: { message: string }) => finding.message
    );
    expect(messages.join("\n")).toContain("no pid");
  });

  it("exits 1 and names the field for a descriptor argent would reject", async () => {
    const source = path.join(home, "bad.json");
    fs.writeFileSync(source, JSON.stringify(descriptor({ id: "Not A Slug" })));

    expect(await runProviders("check", "--file", source, "--json")).toBe(1);
    expect(stdout()).toContain("id:");
  });
});
