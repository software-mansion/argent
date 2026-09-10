import { execFileSync } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Registry } from "@argent/registry";
import { createRunFlowTool } from "../../../src/tools/flows/flow-run";
import { flowAddScriptTool } from "../../../src/tools/flows/flow-add-script";
import { flowFinishRecordingTool } from "../../../src/tools/flows/flow-finish-recording";
import { flowStartRecordingTool } from "../../../src/tools/flows/flow-start-recording";
import {
  FlowScriptExecutor,
  SCRIPT_STEP_LOG_LIMIT_BYTES,
  type FlowScriptRequest,
  type FlowScriptResult,
  type FlowScriptSecret,
} from "../../../src/tools/flows/script/flow-script-executor";
import { createScriptWorkspace, type ScriptWorkspace } from "../../helpers/flow-script-workspace";
import { resolveHostBash } from "../../helpers/host-bash";
import { scopeTempHome } from "../../helpers/temp-home";

/**
 * A script step's LOG, redacted to the standard its failure text already met.
 *
 * The log was scrubbed for each value's raw bytes and nothing else, so every
 * rendering the failure message was already protected against - an encoder, a
 * byte dump, a re-framed base64 payload, a value the log's own limit cut -
 * reached the step report, the `--json` output and the MCP call log in the
 * clear, from a script that did nothing but print what it sent.
 *
 * Real child processes throughout, hence the generous timeouts.
 */

const workspaces: ScriptWorkspace[] = [];

function workspace(): ScriptWorkspace {
  const ws = createScriptWorkspace("log-redact");
  workspaces.push(ws);
  return ws;
}

afterEach(() => {
  while (workspaces.length) workspaces.pop()!.cleanup();
});

let noBash: string | undefined;

beforeAll(async () => {
  const found = await resolveHostBash();
  if (!("path" in found)) noBash = found.problem;
});

function skipWithoutBash(ctx: { skip: (note?: string) => void }): void {
  if (noBash) ctx.skip(`this host has no bash to run a .sh step with: ${noBash}`);
}

function executor() {
  return new FlowScriptExecutor({ concurrency: 4, maxTimeoutMs: 60_000 });
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * One script, with each secret in its environment under its own name - the
 * shape `runFlowScriptStep` hands the executor. A `.sh` runs under bash.
 */
async function runScript(
  file: string,
  source: string,
  secrets: readonly FlowScriptSecret[],
  extra: Partial<FlowScriptRequest> = {}
): Promise<FlowScriptResult> {
  const ws = workspace();
  return executor().execute({
    scriptPath: ws.write(file, source),
    ...(file.endsWith(".sh") ? { interpreter: "bash" as const } : {}),
    projectRoot: ws.dir,
    env: Object.fromEntries(secrets.map(({ name, value }) => [name, value])),
    secrets,
    ...extra,
  });
}

/** The shortest run of a spelling this file counts as disclosure. */
const RUN = 6;

/**
 * The spellings a reader reverses in one step: the value, the bodies a JSON and
 * a URL encoder write, base64 and hex, both cases, and each line of a
 * multi-line value. Derived by the real encoders and kept apart from the
 * executor's own list, so the two cannot agree by construction.
 */
function spellingsOf(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const spellings = [
    value,
    JSON.stringify(value).slice(1, -1),
    encodeURIComponent(value),
    new URLSearchParams([["", value]]).toString().slice(1),
    bytes.toString("base64"),
    bytes.toString("base64url"),
    bytes.toString("hex"),
    value.toUpperCase(),
    value.toLowerCase(),
  ];
  if (value.includes("\n")) spellings.push(...value.split("\n"));
  return spellings;
}

/**
 * Every six-character run of any spelling the text holds. A run that long is
 * enough to find, and any longer fragment holds one, so this is also every
 * prefix a cut could have left.
 */
function leakedRuns(text: string, value: string): string[] {
  const found = new Set<string>();
  for (const spelling of spellingsOf(value)) {
    for (let at = 0; at + RUN <= spelling.length; at++) {
      const run = spelling.slice(at, at + RUN);
      if (text.includes(run)) found.add(run);
    }
  }
  return [...found];
}

/** The text as a reader decoding each base64 run, at each frame offset, reads it. */
function base64View(text: string): string {
  return [...text.matchAll(/[A-Za-z0-9+/]{8,}/g)]
    .flatMap((match) => [0, 1, 2, 3].map((offset) => match[0].slice(offset)))
    .map((run) => Buffer.from(run, "base64").toString("latin1"))
    .join("\n");
}

/** The bytes a hex dump lists - `<Buffer …>`, `od -tx1` - read back. */
function hexDumpView(text: string): string {
  return Buffer.from(
    [...text.matchAll(/\b[0-9a-f]{2}\b/gi)].map((match) => parseInt(match[0], 16))
  ).toString("latin1");
}

/** No run of the value survives, read as written or decoded the way a reader would. */
function expectNoRun(text: string, secret: FlowScriptSecret): void {
  expect(leakedRuns(text, secret.value)).toEqual([]);
  expect(leakedRuns(base64View(text), secret.value)).toEqual([]);
  expect(leakedRuns(hexDumpView(text), secret.value)).toEqual([]);
}

function expectRedacted(text: string, secret: FlowScriptSecret): void {
  expect(text).toContain(`{{secret:${secret.name}}}`);
  expectNoRun(text, secret);
}

const MARKER_OPEN = "{{secret:";

/** Every marker opened is whole, and none is cut off at the end. */
function expectWholeMarkers(text: string, name: string): void {
  expect(text.split(`${MARKER_OPEN}${name}}}`).length).toBe(text.split(MARKER_OPEN).length);
  const openings = [...MARKER_OPEN].map((_, at) => MARKER_OPEN.slice(0, at + 1));
  expect(openings.filter((opening) => text.endsWith(opening))).toEqual([]);
}

/** A password holding what each encoder rewrites: a quote, a space, `/`, `+`, `&` and a tab. */
const PASSWORD: FlowScriptSecret = { name: "PASSWORD", value: 'pa"ss w0rd/9d3f+0a1b&7c2e\tq' };

const PEM: FlowScriptSecret = {
  name: "PEM",
  value:
    "-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkqhkiG9w0BAQEFAASCAUAwggE8AgEAAkEA1234\n-----END PRIVATE KEY-----",
};

const PASS: FlowScriptSecret = { name: "PASS", value: "hunter2-9d3f0a1b7c2e" };

const LIVEKEY: FlowScriptSecret = { name: "LIVEKEY", value: "sk-live-9d3f2a7c41b8e05f6a2d" };

describe("script log redaction - a value an encoder rewrote", () => {
  it("replaces a value console.log printed as it is", async () => {
    const result = await runScript(
      "plain.mjs",
      `console.log("login with " + process.env.PASSWORD);`,
      [PASSWORD]
    );

    expect(result.log).toBe("login with {{secret:PASSWORD}}\n");
    expectRedacted(result.log, PASSWORD);
  }, 30_000);

  // A request body logged before it is sent. JSON writes the quote and the tab
  // as escapes, and `\t` is one no backslash-dropping repair reads back.
  it("replaces a value JSON.stringify escaped", async () => {
    const result = await runScript(
      "json.mjs",
      `console.log(JSON.stringify({ k: process.env.PASSWORD }));`,
      [PASSWORD]
    );

    expect(result.log).toBe('{"k":"{{secret:PASSWORD}}"}\n');
    expectRedacted(result.log, PASSWORD);
  }, 30_000);

  // `util.inspect` writes a Buffer as its bytes, so no spelling of the value is
  // in the text at all: only the byte-space repair over the whole log reads it.
  it("replaces a value util.inspect wrote as a Buffer's bytes", async () => {
    const result = await runScript(
      "buffer.mjs",
      `console.log(Buffer.from(process.env.PASSWORD));`,
      [PASSWORD]
    );

    expect(result.log).toMatch(/^<Buffer .*>\n$/);
    expectRedacted(result.log, PASSWORD);
  }, 30_000);

  it("replaces a value encodeURIComponent escaped", async () => {
    const result = await runScript(
      "uri.mjs",
      `console.log("GET https://api.example.com/login?p=" + encodeURIComponent(process.env.PASSWORD));`,
      [PASSWORD]
    );

    expect(result.log).toBe("GET https://api.example.com/login?p={{secret:PASSWORD}}\n");
    expectRedacted(result.log, PASSWORD);
  }, 30_000);

  it("replaces a value printed as base64 and as hex", async () => {
    const result = await runScript(
      "binary.mjs",
      `const bytes = Buffer.from(process.env.PASSWORD);
       console.log("b64 " + bytes.toString("base64"));
       console.log("hex " + bytes.toString("hex"));`,
      [PASSWORD]
    );

    expect(result.log).toBe("b64 {{secret:PASSWORD}}\nhex {{secret:PASSWORD}}\n");
    expectRedacted(result.log, PASSWORD);
  }, 30_000);

  // Whole, and as `util.inspect` renders it inside an object: one quoted chunk
  // PER LINE joined by `' +`, which only the line spellings answer.
  it("replaces a multi-line value printed whole, and split by line", async () => {
    const result = await runScript(
      "pem.mjs",
      `console.log(process.env.PEM);
       console.log({ key: process.env.PEM });`,
      [PEM]
    );

    expect(result.log.startsWith("{{secret:PEM}}\n")).toBe(true);
    expect(result.log).toContain("key: '{{secret:PEM}}\\n' +");
    expectRedacted(result.log, PEM);
  }, 30_000);

  // A service-account key is pretty-printed JSON, so its first and last lines
  // are `{` and `}`, and a value can hold a whitespace-only line. As spellings
  // of their own they took every brace and every run of spaces the script
  // printed, and the rescan in `finish` then took the braces of the
  // placeholders it had just written. Only a line long enough to be a fragment
  // of the credential is a spelling.
  it("leaves text alone that only a short line of a multi-line value matches", async () => {
    const serviceAccount: FlowScriptSecret = {
      name: "SA_JSON",
      value:
        '{\n  "type": "service_account",\n  "private_key_id": "0a1b2c3d4e5f60718293a4b5c6d7e8f9"\n}',
    };
    const gapped: FlowScriptSecret = {
      name: "GAPPED",
      value: "line-one-abcdef\n  \nline-three-uvwxyz",
    };
    const result = await runScript(
      "short-lines.mjs",
      `console.log(JSON.stringify({ status: "ok", items: [1, 2, 3] }));
       console.log("a  b  c");
       console.log({ key: process.env.SA_JSON });
       throw new Error('request failed with body {"code": 500}');`,
      [serviceAccount, gapped]
    );

    expect(result.log).toContain('{"status":"ok","items":[1,2,3]}\na  b  c\n');
    expect(result.failure?.message).toContain('request failed with body {"code": 500}');
    expectRedacted(result.log, serviceAccount);
    expectWholeMarkers(result.log, "SA_JSON");
  }, 30_000);
});

/**
 * base64 frames in THREE-byte groups, so a prefix whose length is not a
 * multiple of three moves every byte of the value into a different frame and no
 * spelling of it appears. `curl -u bob:$PASS` builds exactly this header.
 */
describe("script log redaction - a value re-framed behind a prefix", () => {
  it("replaces the password in a Basic header a .sh printed", async (ctx) => {
    skipWithoutBash(ctx);
    const result = await runScript(
      "basic.sh",
      `echo "Authorization: Basic $(printf 'bob:%s' "$PASS" | base64)"`,
      [PASS]
    );

    expect(result.ok).toBe(true);
    expect(result.log).toMatch(/^Authorization: Basic \S*\{\{secret:PASS\}\}\S*\n$/);
    expectRedacted(result.log, PASS);
    // The placeholder is shorter than the frames it replaced, so nothing here
    // came near a limit.
    expect(result.logTruncated).toBe(false);
  }, 30_000);
});

/**
 * `xxd`, `hexdump -C` and `od -c` print a value in ROWS: its bytes as hex with
 * the same bytes as text beside them, or one character to a cell. No spelling
 * of the value survives that, and every row opens with an offset that ends a
 * byte run - so the log held the credential in sixteen-character slices. The
 * dumps are pasted in as the tools printed them, so the cases do not depend on
 * which tools, or whose builds of them, the host has.
 */
describe("script log redaction - a value a dump tool laid out in rows", () => {
  const KEY: FlowScriptSecret = { name: "KEY", value: "sk-live-51Hq7xK2mN9pR4tV8wY3zA6bC0dE" };
  /** Multi-byte, with `日` across the row break and an ASCII stretch longer than a run. */
  const WIDE: FlowScriptSecret = { name: "WIDE", value: "pässwörd-€-日本-9d3f7a2c" };
  const SHORT: FlowScriptSecret = { name: "SHORT", value: "s3cr3t-9d3f0a1b" };
  const PUBLIC = "just-a-public-build-id-0042";

  const KEY_XXD = [
    "00000000: 736b 2d6c 6976 652d 3531 4871 3778 4b32  sk-live-51Hq7xK2",
    "00000010: 6d4e 3970 5234 7456 3877 5933 7a41 3662  mN9pR4tV8wY3zA6b",
    "00000020: 4330 6445                                C0dE",
  ];

  /**
   * The text as a reader of a dump joins it back up: the blanks and BSD's `**`
   * cells taken out, so a text column's slices, `od -c`'s cells and `xxd`'s hex
   * words meet again. `hexDumpView` reads two-digit bytes and no words.
   */
  function dumpView(text: string): string {
    return text.replace(/\s+|\*\*/g, "");
  }

  function expectNoDumpRun(text: string, secret: FlowScriptSecret): void {
    expectRedacted(text, secret);
    const joined = dumpView(text);
    expect(leakedRuns(joined, secret.value)).toEqual([]);
    // `xxd -u` writes its hex upper-case.
    expect(leakedRuns(joined.toLowerCase(), secret.value)).toEqual([]);
  }

  /** Each line's first field - the offset of a row - in order. */
  function offsets(text: string): string[] {
    return text.split("\n").map((line) => line.split(" ")[0]!);
  }

  /** The log of a step that printed these lines and nothing else. */
  async function logOf(lines: readonly string[], secret: FlowScriptSecret): Promise<string> {
    const result = await runScript(
      "dump.mjs",
      `process.stdout.write(${JSON.stringify(lines.join("\n"))});`,
      [secret]
    );
    expect(result.ok).toBe(true);
    return result.log;
  }

  // The three as macOS prints them - vim's xxd, BSD's hexdump and od - for a
  // value three rows long.
  it("replaces a value xxd, hexdump -C and od -c printed, in the hex and in the text column", async () => {
    const log = await logOf(
      [
        "== xxd",
        ...KEY_XXD,
        "== hexdump -C",
        "00000000  73 6b 2d 6c 69 76 65 2d  35 31 48 71 37 78 4b 32  |sk-live-51Hq7xK2|",
        "00000010  6d 4e 39 70 52 34 74 56  38 77 59 33 7a 41 36 62  |mN9pR4tV8wY3zA6b|",
        "00000020  43 30 64 45                                       |C0dE|",
        "00000024",
        "== od -c",
        "0000000    s   k   -   l   i   v   e   -   5   1   H   q   7   x   K   2",
        "0000020    m   N   9   p   R   4   t   V   8   w   Y   3   z   A   6   b",
        "0000040    C   0   d   E                                                ",
        "0000044",
        "",
      ],
      KEY
    );

    expect(log).toBe(
      [
        "== xxd",
        "00000000: {{secret:KEY}}  {{secret:KEY}}",
        "00000010: {{secret:KEY}}  {{secret:KEY}}",
        "00000020: {{secret:KEY}}                                {{secret:KEY}}",
        "== hexdump -C",
        "00000000  {{secret:KEY}}  |{{secret:KEY}}|",
        "00000010  {{secret:KEY}}  |{{secret:KEY}}|",
        "00000020  {{secret:KEY}}                                       |{{secret:KEY}}|",
        "00000024",
        "== od -c",
        "0000000    {{secret:KEY}}",
        "0000020    {{secret:KEY}}",
        "0000040    {{secret:KEY}}                                                ",
        "0000044",
        "",
      ].join("\n")
    );
    expectNoDumpRun(log, KEY);
  }, 30_000);

  // The words a value shares with the text in front of it go with it; the
  // rest of the row stays.
  it("replaces a value that starts part-way into a row, and nothing in front of it", async () => {
    const log = await logOf(
      [
        "00000000: 4175 7468 6f72 697a 6174 696f 6e3a 2042  Authorization: B",
        "00000010: 6561 7265 7220 736b 2d6c 6976 652d 3531  earer sk-live-51",
        "00000020: 4871 3778 4b32 6d4e 3970 5234 7456 3877  Hq7xK2mN9pR4tV8w",
        "00000030: 5933 7a41 3662 4330 6445                 Y3zA6bC0dE",
      ],
      KEY
    );

    expect(log).toBe(
      [
        "00000000: 4175 7468 6f72 697a 6174 696f 6e3a 2042  Authorization: B",
        "00000010: 6561 7265 7220 {{secret:KEY}}  earer {{secret:KEY}}",
        "00000020: {{secret:KEY}}  {{secret:KEY}}",
        "00000030: {{secret:KEY}}                 {{secret:KEY}}",
      ].join("\n")
    );
    expectNoDumpRun(log, KEY);
  }, 30_000);

  // GNU's od writes one blank less in front of the first cell and pads no row;
  // `od -t x1` keeps its offsets here, which is what ends a byte run.
  it("replaces a value GNU and BSD od -t x1, GNU od -c, and xxd -g1 and -u printed", async () => {
    const dump = [
      "== GNU od -c",
      "0000000   s   k   -   l   i   v   e   -   5   1   H   q   7   x   K   2",
      "0000020   m   N   9   p   R   4   t   V   8   w   Y   3   z   A   6   b",
      "0000040   C   0   d   E",
      "0000044",
      "== GNU od -t x1",
      "0000000 73 6b 2d 6c 69 76 65 2d 35 31 48 71 37 78 4b 32",
      "0000020 6d 4e 39 70 52 34 74 56 38 77 59 33 7a 41 36 62",
      "0000040 43 30 64 45",
      "0000044",
      "== BSD od -t x1",
      "0000000    73  6b  2d  6c  69  76  65  2d  35  31  48  71  37  78  4b  32",
      "0000020    6d  4e  39  70  52  34  74  56  38  77  59  33  7a  41  36  62",
      "0000040    43  30  64  45                                                ",
      "0000044",
      "== xxd -g1",
      "00000000: 73 6b 2d 6c 69 76 65 2d 35 31 48 71 37 78 4b 32  sk-live-51Hq7xK2",
      "00000010: 6d 4e 39 70 52 34 74 56 38 77 59 33 7a 41 36 62  mN9pR4tV8wY3zA6b",
      "00000020: 43 30 64 45                                      C0dE",
      "== xxd -u",
      "00000000: 736B 2D6C 6976 652D 3531 4871 3778 4B32  sk-live-51Hq7xK2",
      "00000010: 6D4E 3970 5234 7456 3877 5933 7A41 3662  mN9pR4tV8wY3zA6b",
      "00000020: 4330 6445                                C0dE",
    ];
    const log = await logOf(dump, KEY);

    expectNoDumpRun(log, KEY);
    expect(offsets(log)).toEqual(offsets(dump.join("\n")));
    expect(log.split("{{secret:KEY}}").length - 1).toBe(3 * 3 + 2 * 3 * 2);
  }, 30_000);

  // `xxd` and `hexdump -C` render a byte outside printable ASCII as a dot, and
  // BSD's `od -c` writes a multi-byte character whole in its first cell with
  // `**` in the rest - across a row break when the character straddles one.
  // In the C locale both od builds write octal instead.
  it("replaces a multi-byte value in each layout", async () => {
    const dump = [
      "== xxd",
      "00000000: 70c3 a473 7377 c3b6 7264 2de2 82ac 2de6  p..ssw..rd-...-.",
      "00000010: 97a5 e69c ac2d 3964 3366 3761 3263       .....-9d3f7a2c",
      "== hexdump -C",
      "00000000  70 c3 a4 73 73 77 c3 b6  72 64 2d e2 82 ac 2d e6  |p..ssw..rd-...-.|",
      "00000010  97 a5 e6 9c ac 2d 39 64  33 66 37 61 32 63        |.....-9d3f7a2c|",
      "0000001e",
      "== BSD od -c, UTF-8",
      "0000000    p   ä  **   s   s   w   ö  **   r   d   -   €  **  **   -  日",
      "0000020   **  **  本  **  **   -   9   d   3   f   7   a   2   c        ",
      "0000036",
      "== BSD od -c, C",
      "0000000    p 303 244   s   s   w 303 266   r   d   - 342 202 254   - 346",
      "0000020  227 245 346 234 254   -   9   d   3   f   7   a   2   c        ",
      "0000036",
      "== GNU od -c, C",
      "0000000   p 303 244   s   s   w 303 266   r   d   - 342 202 254   - 346",
      "0000020 227 245 346 234 254   -   9   d   3   f   7   a   2   c",
      "0000036",
    ];
    const log = await logOf(dump, WIDE);

    expectNoDumpRun(log, WIDE);
    expect(offsets(log)).toEqual(offsets(dump.join("\n")));
    // Every cell of every character went, `**` and octal alike.
    expect(log).not.toMatch(/\*\*|[äö€日本]| [0-7]{3}\b/);
  }, 30_000);

  // A value short enough for one row is in its text column whole, so the
  // whole-value scrub takes it there first - and its hex words, which spell it
  // just as well, are left beside a placeholder.
  it("replaces the hex words of a value short enough for one xxd row", async () => {
    const log = await logOf(
      ["00000000: 7333 6372 3374 2d39 6433 6630 6131 62    s3cr3t-9d3f0a1b"],
      SHORT
    );

    expect(log).toBe("00000000: {{secret:SHORT}}    {{secret:SHORT}}");
    expectNoDumpRun(log, SHORT);
  }, 30_000);

  // A two-digit rendering is stitched across ONE row break by the byte pass,
  // so the hex of a value two rows long is taken there. Its text column is
  // not, and a row whose hex was rewritten no longer reads as a row.
  it("replaces the text column beside a value two rows long", async () => {
    const log = await logOf(
      [
        "00000000  68 75 6e 74 65 72 32 2d  39 64 33 66 30 61 31 62  |hunter2-9d3f0a1b|",
        "00000010  37 63 32 65                                       |7c2e|",
        "00000014",
        "00000000: 68 75 6e 74 65 72 32 2d 39 64 33 66 30 61 31 62  hunter2-9d3f0a1b",
        "00000010: 37 63 32 65                                      7c2e",
      ],
      PASS
    );

    expect(log).toBe(
      [
        "00000000  {{secret:PASS}}  |{{secret:PASS}}|",
        "00000010  {{secret:PASS}}                                       |{{secret:PASS}}|",
        "00000014",
        "00000000: {{secret:PASS}}  {{secret:PASS}}",
        "00000010: {{secret:PASS}}                                      {{secret:PASS}}",
      ].join("\n")
    );
    expectNoDumpRun(log, PASS);
  }, 30_000);

  // Only a spelling's bytes are replaced, so a dump of anything else comes out
  // as printed - and so does a line that merely opens with digits.
  it("leaves a dump of a value that is no secret, and prose shaped like a row, as printed", async () => {
    const kept = [
      "0000000 files changed, 3 insertions(+)",
      "00000010: build finished in 4s  ok",
      "00000000  started 12:00:01  |ok|",
      "20240611 deploy 7f3a9d2 to production",
      "0000020  cafe babe  sk-test",
      "00000000: 6a75 7374 2d61 2d70 7562 6c69 632d 6275  just-a-public-bu",
      "00000010: 696c 642d 6964 2d30 3034 32              ild-id-0042",
      "00000000  6a 75 73 74 2d 61 2d 70  75 62 6c 69 63 2d 62 75  |just-a-public-bu|",
      "00000010  69 6c 64 2d 69 64 2d 30  30 34 32                 |ild-id-0042|",
      "0000001b",
      "0000000    j   u   s   t   -   a   -   p   u   b   l   i   c   -   b   u",
      "0000020    i   l   d   -   i   d   -   0   0   4   2                    ",
      "0000033",
    ];
    const log = await logOf([...kept, "== the key", ...KEY_XXD], KEY);

    expect(log.startsWith(`${kept.join("\n")}\n== the key\n`)).toBe(true);
    expectNoDumpRun(log, KEY);
  }, 30_000);

  // The same through whichever of the tools this host has, beside a value that
  // is no secret dumped the same way - which has to come out as the tool wrote it.
  it("replaces a value the host's own dump tools printed, and leaves the rest of the dump", async (ctx) => {
    skipWithoutBash(ctx);
    const found = await resolveHostBash();
    if (!("path" in found)) return;
    const run = (command: string) =>
      execFileSync(found.path, ["-c", command], { encoding: "utf8" });
    const tools = ["xxd", "hexdump -C", "od -c"].filter((tool) => {
      try {
        run(`command -v ${tool.split(" ")[0]}`);
        return true;
      } catch {
        return false;
      }
    });
    if (tools.length === 0) ctx.skip("this host has none of xxd, hexdump and od");
    const result = await runScript(
      "dumps.sh",
      tools.map((tool) => `printf %s "$KEY" | ${tool}\nprintf %s '${PUBLIC}' | ${tool}`).join("\n"),
      [KEY]
    );

    expect(result.ok).toBe(true);
    expectNoDumpRun(result.log, KEY);
    for (const tool of tools) expect(result.log).toContain(run(`printf %s '${PUBLIC}' | ${tool}`));
  }, 30_000);
});

describe("script log redaction - a spelling split across pipe chunks", () => {
  // Split just past the escape, so the first half is no prefix of the raw
  // value: only the spelling list says it may be the front of one.
  const HALVES = `const body = JSON.stringify(process.env.PASSWORD).slice(1, -1);
     const wait = (ms) => new Promise((r) => setTimeout(r, ms));`;

  it("replaces a spelling one stream wrote in two pieces", async () => {
    const result = await runScript(
      "halves.mjs",
      `${HALVES}
       process.stdout.write('{"password":"' + body.slice(0, 9));
       await wait(120);
       process.stdout.write(body.slice(9) + '"}\\n');`,
      [PASSWORD]
    );

    expect(result.log).toBe('{"password":"{{secret:PASSWORD}}"}\n');
    expectRedacted(result.log, PASSWORD);
  }, 30_000);

  // The whole-text pass joins what one stream wrote, so it rescues the case
  // above without the live scrub. It cannot rejoin a spelling the OTHER stream
  // wrote into the middle of: the live scrub has to have held the front back.
  it("replaces a spelling the other stream wrote between the halves of", async () => {
    const result = await runScript(
      "halves-between.mjs",
      `${HALVES}
       process.stdout.write('{"password":"' + body.slice(0, 9));
       await wait(60);
       process.stderr.write("retrying\\n");
       await wait(60);
       process.stdout.write(body.slice(9) + '"}\\n');`,
      [PASSWORD]
    );

    expect(result.log).toBe('{"password":"retrying\n{{secret:PASSWORD}}"}\n');
    expectRedacted(result.log, PASSWORD);
  }, 30_000);
});

/**
 * The per-step limit cuts wherever the budget runs out. A value it cuts leaves
 * a PREFIX, which matches no whole spelling - so the log has to be told it was
 * cut, as the failure text is, and drop or repair what the cut left.
 */
describe("script log redaction - a value the per-step limit cut", () => {
  /** Padding that puts the limit `into` characters past `lead` on the last line. */
  function padTo(lead: string, into: number): number {
    return SCRIPT_STEP_LOG_LIMIT_BYTES - 1 - lead.length - into;
  }

  /**
   * The padding, drained by the parent before `then` writes, so the limit falls
   * inside the chunk `then` wrote rather than wherever the pipe would have split
   * one long write.
   */
  function afterPadding(lead: string, into: number, then: string): string {
    return `await new Promise((resolve) => process.stdout.write("x".repeat(${padTo(lead, into)}) + "\\n", resolve));
       await new Promise((resolve) => setTimeout(resolve, 100));
       ${then}`;
  }

  function expectCutInside(result: FlowScriptResult, lead: string, secret: FlowScriptSecret) {
    expect(result.logTruncated).toBe(true);
    expect(Buffer.byteLength(result.log)).toBeLessThanOrEqual(SCRIPT_STEP_LOG_LIMIT_BYTES);
    // The cut fell on the line placed for it, or this case tested nothing.
    expect(result.log.slice(result.log.lastIndexOf("\n") + 1).startsWith(lead)).toBe(true);
    expectNoRun(result.log, secret);
    expectWholeMarkers(result.log, secret.name);
  }

  it("leaves no front of a value it cut, printed raw or as JSON", async () => {
    for (const [render, lead] of [
      ["process.env.PASSWORD", ""],
      ["JSON.stringify({ token: process.env.PASSWORD })", '{"token":"'],
    ] as const) {
      const result = await runScript(
        "cut-value.mjs",
        afterPadding(lead, 12, `console.log(${render});`),
        [PASSWORD]
      );

      expectCutInside(result, lead, PASSWORD);
    }
  }, 30_000);

  it("leaves no front of a value in a base64 payload it cut", async () => {
    const lead = "Authorization: Basic ";
    const result = await runScript(
      "cut-base64.mjs",
      afterPadding(
        lead,
        16,
        `console.log(${JSON.stringify(lead)} + Buffer.from("api:" + process.env.LIVEKEY).toString("base64"));`
      ),
      [LIVEKEY]
    );

    expectCutInside(result, lead, LIVEKEY);
  }, 30_000);

  // The limit can also fall exactly between two writes: the first fills the
  // step's budget to the byte, and only the next one is refused. The log ends
  // at a cut all the same, so the payload in front of it may be the front of a
  // value.
  it("leaves no front of a value in a base64 payload the limit cut between two writes", async () => {
    const lead = "Authorization: Basic ";
    const result = await runScript(
      "cut-between.mjs",
      afterPadding(
        lead,
        16,
        `const payload = Buffer.from("api:" + process.env.LIVEKEY).toString("base64");
         await new Promise((resolve) => process.stdout.write(${JSON.stringify(lead)} + payload.slice(0, 16), resolve));
         await new Promise((resolve) => setTimeout(resolve, 150));
         console.log(payload.slice(16));`
      ),
      [LIVEKEY]
    );

    expectCutInside(result, lead, LIVEKEY);
  }, 30_000);

  // Mid-token as well: a character limit stops wherever it falls, so the last
  // number of the rendering can be half of one.
  it("leaves no front of a value in a <Buffer …> rendering it cut", async () => {
    const lead = "<Buffer ";
    const result = await runScript(
      "cut-buffer.mjs",
      afterPadding(lead, 31, `console.log(Buffer.from(process.env.LIVEKEY));`),
      [LIVEKEY]
    );

    expectCutInside(result, lead, LIVEKEY);
  }, 30_000);

  // The list is read live, so a value can become a secret after the limit has
  // already cut it. The live scrub never knew it and wrote its front into the
  // log; only the pass that runs once the streams end knows the log ends at a
  // cut, and so that what is left there may be the front of a value.
  it("drops the front of a value whose secret arrived after the cut", async () => {
    const ws = workspace();
    const lead = "token=";
    const written = ws.resolve("written.mark");
    const go = ws.resolve("go.mark");
    const script = ws.write(
      "late.mjs",
      `import fs from "node:fs";
       ${afterPadding(
         lead,
         12,
         `await new Promise((resolve) => process.stdout.write(${JSON.stringify(lead)} + process.env.LIVEKEY + "\\n", resolve));`
       )}
       fs.writeFileSync(${JSON.stringify(written)}, "");
       while (!fs.existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 20));`
    );
    const secrets: FlowScriptSecret[] = [];
    const pending = executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { LIVEKEY: LIVEKEY.value },
      secrets,
      timeoutMs: 20_000,
    });
    await until(() => fsSync.existsSync(written), "the script to write past the limit");
    // Long enough for the parent to drain what the child flushed, so the cut is
    // made before the value is a secret.
    await new Promise((resolve) => setTimeout(resolve, 200));
    secrets.push(LIVEKEY);
    fsSync.writeFileSync(go, "");
    const result = await pending;

    expectCutInside(result, lead, LIVEKEY);
  }, 30_000);
});

/**
 * A replacement is not a shortening: `{{secret:PIN}}` is fourteen characters
 * for one. The live scrub is charged for the markers it writes, but the repairs
 * run after the budget is spent, and a byte rendering of a one-character value
 * grows sevenfold under them.
 */
describe("script log redaction - a scrub that grows the log", () => {
  const PIN: FlowScriptSecret = { name: "PIN", value: "7" };

  it("keeps a log the repairs grew inside the per-step limit, with every marker whole", async () => {
    const result = await runScript(
      "grow.mjs",
      `import util from "node:util";
       process.stdout.write(("pin " + process.env.PIN + "\\n").repeat(2000));
       console.log(util.inspect(new Uint8Array(Buffer.from(process.env.PIN.repeat(20000))), { maxArrayLength: Infinity }));`,
      [PIN]
    );

    expect(result.logTruncated).toBe(true);
    expect(result.log.startsWith("pin {{secret:PIN}}\n".repeat(2000))).toBe(true);
    // The rendering's own bytes were replaced too, which is what grew it.
    expect(result.log).toMatch(/Uint8Array\(20000\) \[\s+\{\{secret:PIN\}\}/);
    expect(Buffer.byteLength(result.log)).toBeLessThanOrEqual(SCRIPT_STEP_LOG_LIMIT_BYTES);
    expectWholeMarkers(result.log, PIN.name);
  }, 30_000);

  // Far under the limit the growth has room: the placeholder is paid from what
  // the step has left, and the lines after it are kept.
  const SHORT: FlowScriptSecret = { name: "PASS", value: "s3cr3t" };
  const basicThenDone = `console.log("Basic " + Buffer.from("bob:" + process.env.PASS).toString("base64"));
     console.log("done");`;

  it("keeps every line of a short log a repair made longer", async () => {
    const result = await runScript("grow-short.mjs", basicThenDone, [SHORT]);

    expect(result.log).toBe("Basic Ym9i{{secret:PASS}}==\ndone\n");
    expect(result.logTruncated).toBe(false);
  }, 30_000);

  // The run's budget pays for the growth too, and stops it where it runs out.
  it("charges the growth to the run's budget, and cuts the log where that runs out", async () => {
    const logBudget = { remainingBytes: 30 };
    const result = await runScript("grow-budget.mjs", basicThenDone, [SHORT], { logBudget });

    expect(result.log).toBe("Basic Ym9i{{secret:PASS}}==\ndo");
    expect(result.logTruncated).toBe(true);
    expect(logBudget.remainingBytes).toBe(0);
  }, 30_000);
});

describe("script log redaction - what must stay", () => {
  const TOKEN: FlowScriptSecret = { name: "TOKEN", value: "hunter2-9d3f0a1b7c2e" };

  // The failure text reads a trailing omission marker as argent's own cut and
  // drops the front of a value in front of it. A log carries no such marker -
  // its cut is a flag - so text a script printed in that shape is the script's.
  it("leaves text that spells no value alone, even a line shaped like argent's cut marker", async () => {
    const printed =
      "digest deadbeefcafe0123 aGVsbG8gd29ybGQ= <Buffer 01 02 03> ordinary words\n" +
      "fetched 3 items, h… [12 more characters omitted]";
    const result = await runScript(
      "prose.mjs",
      `process.stdout.write(${JSON.stringify(printed)});`,
      [TOKEN]
    );

    expect(result.log).toBe(printed);
    expect(result.logTruncated).toBe(false);
  }, 30_000);

  // The front of a value is dropped only where the LIMIT cut. A log that ended
  // on its own ends where the script stopped writing, whatever that spells.
  it("leaves the end of a log nothing cut, where it opens a value", async () => {
    const result = await runScript(
      "open-end.mjs",
      `process.stdout.write("Resolving packages: 42% h");`,
      [TOKEN]
    );

    expect(result.log).toBe("Resolving packages: 42% h");
    expect(result.logTruncated).toBe(false);
  }, 30_000);
});

/**
 * `set -x` is how a `.sh` step is debugged, and it writes every command to
 * stderr with its arguments expanded - so a credential in a header is in the
 * trace, and a failing command's trace is the last stderr line, which ends the
 * step's reason.
 */
describe("script log redaction - a bash step's xtrace", () => {
  it("replaces the secret in the xtrace line, in the log and in the reason", async (ctx) => {
    skipWithoutBash(ctx);
    const result = await runScript(
      "xtrace.sh",
      `set -ex
       false --user "bob:$PASS" --header "Authorization: Basic $(printf 'bob:%s' "$PASS" | base64)"`,
      [PASS]
    );

    const message = result.failure?.message ?? "";
    expect(result.failure?.kind).toBe("exit");
    const traced = "+ false --user bob:{{secret:PASS}} --header 'Authorization: Basic ";
    expect(result.log).toContain(traced);
    expectRedacted(result.log, PASS);
    expect(message).toContain(traced);
    expect(message).toMatch(/\{\{secret:PASS\}\}'$/);
    expectRedacted(message, PASS);
  }, 30_000);
});

/**
 * Past the cut nothing more reaches the log, so nothing is scrubbed there: the
 * scrub takes every spelling of every secret, and running it over a flood the
 * log will never hold is the only thing a large output would spend its time on.
 */
describe("script log redaction - past the cut", () => {
  const API_KEY: FlowScriptSecret = { name: "API_KEY", value: "sk-live-9d3f0a1b7c2e5f40" };
  const FLOOD = `head -c ${50 * 1024 * 1024} /dev/zero | tr '\\0' 'x'
     echo "upload failed for $API_KEY: HTTP 503" >&2
     exit 2`;

  /**
   * The run, and the CPU THIS process spent on it. The scrub is this process's
   * work, and it overlaps the child's own writing, so wall time hides most of
   * it while CPU time does not.
   */
  async function flood(secrets: FlowScriptSecret[]) {
    const before = process.cpuUsage();
    const result = await runScript("flood.sh", FLOOD, secrets);
    const spent = process.cpuUsage(before);
    return { result, cpuMs: (spent.user + spent.system) / 1000 };
  }

  it("drains a 50 MiB flood without scrubbing it, and still ends the reason with the last stderr line", async (ctx) => {
    skipWithoutBash(ctx);
    const unscrubbed = await flood([]);
    // Three secrets, one of them multi-line, for the spellings a step with a
    // few credentials carries: scrubbed, 50 MiB of them is seconds of CPU.
    const { result, cpuMs } = await flood([API_KEY, PEM, PASSWORD]);

    expect(cpuMs - unscrubbed.cpuMs).toBeLessThan(1_000);
    // A stream that stopped draining would end in the step's timeout, not in
    // the script's own exit.
    expect(result.failure?.kind).toBe("exit");
    expect(result.failure?.message).toMatch(/upload failed for \{\{secret:API_KEY\}\}: HTTP 503$/);
    expect(result.logTruncated).toBe(true);
    expect(Buffer.byteLength(result.log)).toBeLessThanOrEqual(SCRIPT_STEP_LOG_LIMIT_BYTES);
    expectNoRun(`${result.log}\n${result.failure?.message ?? ""}`, API_KEY);
  }, 60_000);
});

/**
 * The two callers that report a log, through the one path both share:
 * `{{secret:NAME}}` resolved from the project's own `.argent/secrets.env`,
 * the step run, and the log carried out as `scriptLog` by a flow run and as
 * `log` by `flow-add-script`.
 */
describe("script log redaction - end to end", () => {
  // The secret chain ends at `~/.argent/secrets.env`, so a home of this test's
  // own keeps a developer's file out of it.
  scopeTempHome("argent-log-redaction-home-");

  const KEY = "sk-live-9d3f0a1b7c2e5f40";
  const SECRET: FlowScriptSecret = { name: "API_KEY", value: KEY };
  let root = "";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-log-redaction-"));
    await fs.mkdir(path.join(root, ".argent", "flows"), { recursive: true });
    await write(".argent/secrets.env", `API_KEY=${KEY}\n`);
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function write(relative: string, contents: string): Promise<void> {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents, "utf8");
  }

  async function runFlow(name: string) {
    const registry = {
      invokeTool: vi.fn(async (id: string) =>
        id === "list-devices" ? { devices: [] } : { ok: true }
      ),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
      resolveService: vi.fn(async () => ({
        isConnected: () => true,
        listConnectedBundleIds: () => [],
      })),
    } as unknown as Registry;
    const result = await createRunFlowTool(registry).execute({}, {
      project_root: root,
      name,
    } as never);
    if (!("steps" in result)) throw new Error(`expected a run result, got: ${result.notice}`);
    return result;
  }

  /** The key as its own words, and as the hex dump `od` writes of its bytes. */
  const REPORT_SH =
    `echo "calling the API with key $API_KEY"\n` + `printf '%s' "$API_KEY" | od -An -tx1\n`;

  it("redacts the log a flow run reports as scriptLog", async (ctx) => {
    skipWithoutBash(ctx);
    await write("scripts/report.sh", REPORT_SH);
    await write(
      ".argent/flows/report.yaml",
      "steps:\n" +
        "  - script:\n" +
        "      path: ../../scripts/report.sh\n" +
        '      env: { API_KEY: "{{secret:API_KEY}}" }\n'
    );

    const result = await runFlow("report");

    expect(result.steps[0]).toMatchObject({ kind: "script", status: "pass" });
    const log = result.steps[0]!.scriptLog ?? "";
    expect(log).toContain("calling the API with key {{secret:API_KEY}}\n");
    expectRedacted(log, SECRET);
  }, 30_000);

  it("redacts the log flow-add-script returns as log", async (ctx) => {
    skipWithoutBash(ctx);
    await write("scripts/report.sh", REPORT_SH);
    await flowStartRecordingTool.execute({}, { name: "rec", project_root: root });

    const added = (await flowAddScriptTool.execute(
      {},
      {
        name: "rec",
        project_root: root,
        path: "../../scripts/report.sh",
        env: { API_KEY: "{{secret:API_KEY}}" },
      }
    )) as { status: string; log?: string };
    await flowFinishRecordingTool.execute({}, { name: "rec", project_root: root });

    expect(added.status).toBe("pass");
    const log = added.log ?? "";
    expect(log).toContain("calling the API with key {{secret:API_KEY}}\n");
    expectRedacted(log, SECRET);
  }, 30_000);

  // Only a placeholder's value is a secret. A plaintext value sits beside it in
  // the same environment, and replacing it would hide what the step ran with.
  it("leaves a plaintext env value as the script printed it", async () => {
    await write(
      "scripts/show.mjs",
      "console.log(`region=${process.env.REGION} url=${process.env.API_URL} key=${process.env.API_KEY}`);"
    );
    await write(
      ".argent/flows/show.yaml",
      "env:\n" +
        "  REGION: eu-west-1\n" +
        "  API_URL: https://api.example.com/v1\n" +
        "steps:\n" +
        "  - script:\n" +
        "      path: ../../scripts/show.mjs\n" +
        '      env: { API_KEY: "{{secret:API_KEY}}" }\n'
    );

    const result = await runFlow("show");

    expect(result.steps[0]).toMatchObject({ kind: "script", status: "pass" });
    expect(result.steps[0]!.scriptLog).toBe(
      "region=eu-west-1 url=https://api.example.com/v1 key={{secret:API_KEY}}\n"
    );
  }, 30_000);
});
