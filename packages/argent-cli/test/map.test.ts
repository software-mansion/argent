import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  parseMapArgs,
  bootedMapCandidates,
  formatProgressLine,
  formatMapSummary,
  writeMapJson,
} from "../src/map.js";
import { FlagParseException } from "../src/flag-parser.js";

describe("parseMapArgs", () => {
  it("parses the bare positional bundle id with defaults", () => {
    expect(parseMapArgs(["com.example.app"])).toEqual({
      bundleId: "com.example.app",
      udid: null,
      maxScreens: null,
      maxActions: null,
      maxDepth: null,
      budgetS: null,
      deepLinks: [],
      window: true,
      json: false,
      jsonPath: null,
      help: false,
    });
  });

  it("parses every flag", () => {
    const args = parseMapArgs([
      "com.example.app",
      "--udid",
      "ABC-123",
      "--max-screens",
      "40",
      "--max-actions",
      "8",
      "--max-depth",
      "3",
      "--budget",
      "120",
      "--no-window",
      "--json=out/graph.json",
      "--deep-link",
      "myapp://home",
      "--deep-link=myapp://profile",
    ]);
    expect(args).toEqual({
      bundleId: "com.example.app",
      udid: "ABC-123",
      maxScreens: 40,
      maxActions: 8,
      maxDepth: 3,
      budgetS: 120,
      deepLinks: ["myapp://home", "myapp://profile"],
      window: false,
      json: true,
      jsonPath: "out/graph.json",
      help: false,
    });
  });

  it("--json without a path keeps the default output", () => {
    const args = parseMapArgs(["com.example.app", "--json"]);
    expect(args.json).toBe(true);
    expect(args.jsonPath).toBeNull();
  });

  it("--json does not swallow a trailing flag as its path", () => {
    const args = parseMapArgs(["com.example.app", "--json", "--no-window"]);
    expect(args.json).toBe(true);
    expect(args.jsonPath).toBeNull();
    expect(args.window).toBe(false);
  });

  it("--json before the bundle id treats the next token as the bundle id", () => {
    // Bare `--json` never consumes a following token (the path must be attached
    // as `--json=<path>`), so `argent map --json com.example.app` targets the
    // app regardless of ordering.
    const args = parseMapArgs(["--json", "com.example.app"]);
    expect(args.json).toBe(true);
    expect(args.jsonPath).toBeNull();
    expect(args.bundleId).toBe("com.example.app");
  });

  // Finding 1 [M]: the explicit `--json=<path>` form must set the output path
  // regardless of where it sits relative to the positional bundle id. The old
  // parser only consumed a space-separated path *after* the positional and
  // rejected `--json=...` outright as an unknown flag.
  it("--json=<path> sets the output path before the bundle id", () => {
    const args = parseMapArgs(["--json=out.json", "com.example.app"]);
    expect(args.json).toBe(true);
    expect(args.jsonPath).toBe("out.json");
    expect(args.bundleId).toBe("com.example.app");
  });

  it("--json=<path> sets the output path after the bundle id", () => {
    const args = parseMapArgs(["com.example.app", "--json=out/graph.json"]);
    expect(args.json).toBe(true);
    expect(args.jsonPath).toBe("out/graph.json");
    expect(args.bundleId).toBe("com.example.app");
  });

  it("--json= with an empty path fails loudly", () => {
    expect(() => parseMapArgs(["com.example.app", "--json="])).toThrow(/expects a path/);
  });

  it("sets help for --help and -h", () => {
    expect(parseMapArgs(["--help"]).help).toBe(true);
    expect(parseMapArgs(["-h"]).help).toBe(true);
  });

  it("rejects a missing flag value", () => {
    expect(() => parseMapArgs(["com.example.app", "--udid"])).toThrow(FlagParseException);
    expect(() => parseMapArgs(["com.example.app", "--max-screens"])).toThrow(/requires a value/);
  });

  it("rejects non-positive and non-integer numeric values", () => {
    expect(() => parseMapArgs(["com.example.app", "--max-screens", "abc"])).toThrow(
      /positive integer/
    );
    expect(() => parseMapArgs(["com.example.app", "--max-depth", "0"])).toThrow(/positive integer/);
    expect(() => parseMapArgs(["com.example.app", "--budget", "-5"])).toThrow(/positive integer/);
    expect(() => parseMapArgs(["com.example.app", "--max-actions", "2.5"])).toThrow(
      /positive integer/
    );
  });

  it("rejects over-cap numeric values here, not as a server-side ZodError blob", () => {
    expect(() => parseMapArgs(["com.example.app", "--max-screens", "200"])).toThrow(
      /--max-screens must be at most 100/
    );
    expect(() => parseMapArgs(["com.example.app", "--max-actions", "50"])).toThrow(
      /--max-actions must be at most 30/
    );
    expect(() => parseMapArgs(["com.example.app", "--max-depth", "20"])).toThrow(
      /--max-depth must be at most 10/
    );
    expect(() => parseMapArgs(["com.example.app", "--budget", "3600"])).toThrow(
      /--budget must be at most 1800/
    );
    // The cap is inclusive — the boundary value is accepted.
    expect(parseMapArgs(["com.example.app", "--max-screens", "100"]).maxScreens).toBe(100);
  });

  it("rejects more than 20 --deep-link urls here, not as a server-side ZodError blob", () => {
    const links = Array.from({ length: 21 }, (_, i) => `--deep-link=myapp://s${i}`);
    expect(() => parseMapArgs(["com.example.app", ...links])).toThrow(
      /--deep-link accepts at most 20 urls, got 21/
    );
    // The cap is inclusive — exactly 20 is accepted.
    const ok = Array.from({ length: 20 }, (_, i) => `--deep-link=myapp://s${i}`);
    expect(parseMapArgs(["com.example.app", ...ok]).deepLinks).toHaveLength(20);
  });

  it("rejects unknown flags and extra positionals", () => {
    expect(() => parseMapArgs(["com.example.app", "--frobnicate"])).toThrow(/Unknown flag/);
    expect(() => parseMapArgs(["com.example.app", "com.other.app"])).toThrow(/extra argument/);
  });

  // Finding 3 [L]: a value-taking flag must not swallow a following flag token
  // as its value. Previously `--udid --max-screens` set udid to "--max-screens"
  // (and `--udid --max-screens` alone silently parsed with no bundle id at all).
  it("rejects a following flag token as a flag's value", () => {
    expect(() => parseMapArgs(["--udid", "--max-screens"])).toThrow(/expects a value/);
    expect(() => parseMapArgs(["--udid", "--max-screens", "5", "com.foo"])).toThrow(
      /expects a value/
    );
  });

  // The guard above must still let a legitimate negative number reach the
  // numeric flags, which reject it with the clearer "positive integer" message
  // rather than a misleading "expects a value".
  it("still routes a negative numeric value to the positive-integer check", () => {
    expect(() => parseMapArgs(["com.example.app", "--budget", "-5"])).toThrow(/positive integer/);
  });

  // Deep-link seeding: --deep-link is REPEATABLE and collects into deepLinks,
  // forwarded to map-app as additional crawl entry points (an app is a graph,
  // not a tree). The attached --deep-link=<url> form mirrors --json=<path>.
  it("defaults deepLinks to an empty array", () => {
    expect(parseMapArgs(["com.example.app"]).deepLinks).toEqual([]);
  });

  it("collects repeated --deep-link values into deepLinks in order", () => {
    const args = parseMapArgs(["com.example.app", "--deep-link", "a", "--deep-link", "b"]);
    expect(args.deepLinks).toEqual(["a", "b"]);
    expect(args.bundleId).toBe("com.example.app");
  });

  it("accepts the attached --deep-link=<url> form", () => {
    const args = parseMapArgs(["com.example.app", "--deep-link=myapp://home"]);
    expect(args.deepLinks).toEqual(["myapp://home"]);
  });

  it("mixes the bare and attached deep-link forms (an =-bearing url survives)", () => {
    const args = parseMapArgs([
      "com.example.app",
      "--deep-link",
      "myapp://a",
      "--deep-link=myapp://b?x=1",
    ]);
    expect(args.deepLinks).toEqual(["myapp://a", "myapp://b?x=1"]);
  });

  it("--deep-link= with an empty value throws", () => {
    expect(() => parseMapArgs(["com.example.app", "--deep-link="])).toThrow(FlagParseException);
    expect(() => parseMapArgs(["com.example.app", "--deep-link="])).toThrow(/expects a url/);
  });

  it("--deep-link with no following token throws", () => {
    expect(() => parseMapArgs(["com.example.app", "--deep-link"])).toThrow(FlagParseException);
    expect(() => parseMapArgs(["com.example.app", "--deep-link"])).toThrow(/requires a value/);
  });

  it("rejects an empty bare --deep-link value", () => {
    expect(() => parseMapArgs(["com.example.app", "--deep-link", ""])).toThrow(FlagParseException);
  });

  it("--deep-link does not swallow a following flag token as its url", () => {
    expect(() => parseMapArgs(["com.example.app", "--deep-link", "--no-window"])).toThrow(
      /expects a value/
    );
  });

  it("combines deep links with the positional bundle id and other flags in any order", () => {
    const args = parseMapArgs([
      "--deep-link=myapp://a",
      "com.example.app",
      "--max-screens",
      "10",
      "--deep-link",
      "myapp://b",
      "--no-window",
    ]);
    expect(args.bundleId).toBe("com.example.app");
    expect(args.deepLinks).toEqual(["myapp://a", "myapp://b"]);
    expect(args.maxScreens).toBe(10);
    expect(args.window).toBe(false);
  });
});

describe("bootedMapCandidates", () => {
  const devices = [
    { platform: "ios", udid: "IOS-BOOTED", name: "iPhone 16 Pro", state: "Booted" },
    { platform: "ios", udid: "IOS-OFF", name: "iPhone 16", state: "Shutdown" },
    {
      platform: "ios",
      udid: "TV-BOOTED",
      name: "Apple TV",
      state: "Booted",
      runtimeKind: "tv",
    },
    {
      platform: "android",
      serial: "emulator-5554",
      state: "device",
      avdName: "Pixel_8",
      model: "sdk_gphone64",
      kind: "emulator",
    },
    { platform: "android", serial: "emulator-5556", state: "offline", avdName: "Pixel_7" },
    {
      platform: "android",
      serial: "adb-tv",
      state: "device",
      avdName: "TV_AVD",
      runtimeKind: "tv",
    },
    { platform: "chromium", id: "chromium-9222", state: "running" },
    { platform: "vega", serial: "vega-1", state: "running" },
  ];

  it("keeps only booted iOS simulators and ready Android devices", () => {
    expect(bootedMapCandidates(devices)).toEqual([
      { id: "IOS-BOOTED", label: "IOS-BOOTED  iPhone 16 Pro (ios)" },
      { id: "emulator-5554", label: "emulator-5554  Pixel_8 (android)" },
    ]);
  });

  it("labels an Android physical device by model when it has no AVD name", () => {
    const [candidate] = bootedMapCandidates([
      { platform: "android", serial: "R5CT1", state: "device", avdName: null, model: "Pixel 9" },
    ]);
    expect(candidate).toEqual({ id: "R5CT1", label: "R5CT1  Pixel 9 (android)" });
  });

  it("tolerates junk shapes", () => {
    expect(bootedMapCandidates(undefined)).toEqual([]);
    expect(bootedMapCandidates("nope")).toEqual([]);
    expect(bootedMapCandidates([null, 42, {}, { platform: "ios", state: "Booted" }])).toEqual([]);
  });
});

describe("formatProgressLine", () => {
  it("renders a discovered screen prominently", () => {
    const line = formatProgressLine(
      { kind: "screen", nodeId: "s3", title: "Settings", depth: 2, screens: 4 },
      30
    );
    expect(line).toEqual({ text: "[4/30] Settings (depth 2)", dim: false });
  });

  it("renders action / restart / phase events as dim one-liners", () => {
    expect(
      formatProgressLine(
        { kind: "action", nodeId: "s1", label: "Log in", explored: 2, total: 9 },
        30
      )
    ).toEqual({ text: "    · Log in (2/9)", dim: true });
    expect(formatProgressLine({ kind: "restart", reason: "replay diverged" }, 30)).toEqual({
      text: "    ↻ restart: replay diverged",
      dim: true,
    });
    expect(formatProgressLine({ kind: "phase", message: "launching app" }, 30)).toEqual({
      text: "    launching app",
      dim: true,
    });
  });

  it("returns null for unknown shapes", () => {
    expect(formatProgressLine(null, 30)).toBeNull();
    expect(formatProgressLine("screen", 30)).toBeNull();
    expect(formatProgressLine({ no: "kind" }, 30)).toBeNull();
    expect(formatProgressLine({ kind: "novel-event" }, 30)).toBeNull();
  });

  it("strips control bytes from device-sourced titles and labels (terminal-injection guard)", () => {
    // A crawled app's accessibility text is untrusted; an ESC/OSC payload must
    // not reach the terminal. \x1b]52 is a clipboard-write, \x1b[2J a screen
    // clear, \x07 the BEL that terminates an OSC.
    const evilTitle = "Home\x1b]52;c;cGF5bG9hZA==\x07\x1b[2J";
    const screen = formatProgressLine(
      { kind: "screen", nodeId: "s0", title: evilTitle, depth: 0, screens: 1 },
      30
    );
    // Exact equality pins that every ESC/BEL byte is gone (the visible tail of
    // each sequence remains as inert text).
    expect(screen!.text).toBe("[1/30] Home]52;c;cGF5bG9hZA==[2J (depth 0)");

    const action = formatProgressLine(
      { kind: "action", nodeId: "s0", label: "Tap\x1b[31mme", explored: 1, total: 2 },
      30
    );
    expect(action!.text).toBe("    · Tap[31mme (1/2)");
  });
});

describe("formatMapSummary", () => {
  const stats = { screens: 12, edges: 18, restarts: 2, elapsedMs: 93_400 };

  it("words a completed crawl", () => {
    expect(formatMapSummary("completed", stats)).toBe(
      "Mapped 12 screens, 18 edges, 2 restarts in 93.4s"
    );
  });

  it("words a cancelled crawl as a partial map", () => {
    expect(formatMapSummary("cancelled", stats)).toBe(
      "Cancelled — partial map: 12 screens, 18 edges, 2 restarts in 93.4s"
    );
  });

  it("words a failed crawl as a partial map", () => {
    expect(formatMapSummary("failed", stats)).toBe(
      "Failed — partial map: 12 screens, 18 edges, 2 restarts in 93.4s"
    );
  });

  it("singularizes counts of one", () => {
    expect(
      formatMapSummary("completed", { screens: 1, edges: 1, restarts: 1, elapsedMs: 1000 })
    ).toBe("Mapped 1 screen, 1 edge, 1 restart in 1.0s");
  });
});

// Finding 2 [M]: cancelling a crawl must still write the requested --json
// output. Both the normal-finish and cancel paths now route through this shared
// writer (which took no fetched-state argument before the fix — the cancel path
// simply returned before reaching the write block, discarding the artifact).
describe("writeMapJson", () => {
  let dir: string;
  let cwd: string;

  beforeEach(() => {
    cwd = process.cwd();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-map-json-"));
  });

  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes the state as pretty JSON with a trailing newline to the given path", () => {
    const state = { nodes: [{ id: "a" }], edges: [] };
    const outPath = path.join(dir, "graph.json");
    const written = writeMapJson(state, outPath);
    expect(written).toBe(outPath);
    const text = fs.readFileSync(outPath, "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(state);
  });

  it("creates missing parent directories", () => {
    const outPath = path.join(dir, "nested", "deep", "graph.json");
    writeMapJson({ ok: true }, outPath);
    expect(fs.existsSync(outPath)).toBe(true);
  });

  it("defaults to ./argent-map.json when no path is given", () => {
    process.chdir(dir);
    const written = writeMapJson({ ok: true }, null);
    // Resolve the expected path against the same cwd writeMapJson used — on
    // macOS os.tmpdir() is a /var → /private/var symlink, so comparing against
    // the raw `dir` would spuriously differ.
    expect(written).toBe(path.resolve("argent-map.json"));
    expect(fs.existsSync(written)).toBe(true);
  });
});
