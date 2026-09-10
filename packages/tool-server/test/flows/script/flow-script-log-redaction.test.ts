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
    const started = Date.now();
    // Three secrets, one of them multi-line, for the spellings a step with a
    // few credentials carries: scrubbed, 50 MiB of them is seconds of CPU.
    const { result, cpuMs } = await flood([API_KEY, PEM, PASSWORD]);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(15_000);
    expect(cpuMs - unscrubbed.cpuMs).toBeLessThan(1_000);
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
