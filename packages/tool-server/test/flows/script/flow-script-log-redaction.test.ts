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
 * A script step's LOG, redacted as its failure text is: each secret as written,
 * at any length, and - for a value of six characters or more - percent-encoded
 * (a space as `%20` or as `+`), JSON-escaped or base64-encoded whole, becomes
 * its `{{secret:NAME}}` placeholder - in a value split across pipe chunks, at
 * the per-step limit, and within the step's and the run's log budgets when a
 * placeholder is longer than what it replaced.
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
 * The spellings the scrub replaces: the value at any length, and for a value of
 * six characters or more - every value in this file - the bodies a JSON encoder
 * and both URL encoders write, and base64 of the whole value. Derived by the
 * real encoders rather than taken from the scrubber, so the two cannot agree by
 * construction.
 */
function spellingsOf(value: string): string[] {
  return [
    value,
    JSON.stringify(value).slice(1, -1),
    encodeURIComponent(value),
    new URLSearchParams([["", value]]).toString().slice(1),
    Buffer.from(value, "utf8").toString("base64"),
  ];
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

/** No run of any spelling of the value survives. */
function expectNoRun(text: string, secret: FlowScriptSecret): void {
  expect(leakedRuns(text, secret.value)).toEqual([]);
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

  // A request body logged before it is sent: JSON writes the quote and the tab
  // as escapes.
  it("replaces a value JSON.stringify escaped", async () => {
    const result = await runScript(
      "json.mjs",
      `console.log(JSON.stringify({ k: process.env.PASSWORD }));`,
      [PASSWORD]
    );

    expect(result.log).toBe('{"k":"{{secret:PASSWORD}}"}\n');
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

  // A form body writes the space as `+`.
  it("replaces a value URLSearchParams encoded", async () => {
    const result = await runScript(
      "form.mjs",
      `console.log("POST /login " + new URLSearchParams({ p: process.env.PASSWORD }));`,
      [PASSWORD]
    );

    expect(result.log).toBe("POST /login p={{secret:PASSWORD}}\n");
    expectRedacted(result.log, PASSWORD);
  }, 30_000);

  it("replaces a value printed as base64", async () => {
    const result = await runScript(
      "base64.mjs",
      `console.log("b64 " + Buffer.from(process.env.PASSWORD).toString("base64"));`,
      [PASSWORD]
    );

    expect(result.log).toBe("b64 {{secret:PASSWORD}}\n");
    expectRedacted(result.log, PASSWORD);
  }, 30_000);
});

describe("script log redaction - a spelling split across pipe chunks", () => {
  // Split just past the escape, so the first half is no prefix of the value as
  // written. The live scrub holds back a tail that could still begin a form, so
  // what one stream wrote in two pieces is read as one text.
  it("replaces a spelling one stream wrote in two pieces", async () => {
    const result = await runScript(
      "halves.mjs",
      `const body = JSON.stringify(process.env.PASSWORD).slice(1, -1);
       const wait = (ms) => new Promise((r) => setTimeout(r, ms));
       process.stdout.write('{"password":"' + body.slice(0, 9));
       await wait(120);
       process.stdout.write(body.slice(9) + '"}\\n');`,
      [PASSWORD]
    );

    expect(result.log).toBe('{"password":"{{secret:PASSWORD}}"}\n');
    expectRedacted(result.log, PASSWORD);
  }, 30_000);

  // A value can reach the log in two pieces from the two streams. The whole log
  // is scrubbed again once the streams end, which reads it as one text.
  it("replaces a value the two streams split between them", async () => {
    const PIN: FlowScriptSecret = { name: "PIN", value: "1234" };
    const result = await runScript(
      "streams.mjs",
      `process.stdout.write("12");
       await new Promise((r) => setTimeout(r, 200));
       process.stderr.write("34\\n");`,
      [PIN]
    );

    expect(result.log).toBe("{{secret:PIN}}\n");
  }, 30_000);
});

/**
 * The per-step limit cuts wherever the budget runs out, which can be inside a
 * value or inside the placeholder the live scrub wrote for it. The log keeps
 * neither the front of the value nor a fragment of the marker.
 */
describe("script log redaction - a value the per-step limit cut", () => {
  it("leaves no front of a value it cut", async () => {
    // Padding the parent drains before the value is written, so the limit falls
    // twelve characters into the line that prints it.
    const padding = `${"x".repeat(SCRIPT_STEP_LOG_LIMIT_BYTES - 13)}\n`;
    const result = await runScript(
      "cut-value.mjs",
      `await new Promise((resolve) => process.stdout.write("x".repeat(${padding.length - 1}) + "\\n", resolve));
       await new Promise((resolve) => setTimeout(resolve, 100));
       console.log(process.env.PASSWORD);`,
      [PASSWORD]
    );

    expect(result.logTruncated).toBe(true);
    // Nothing of that line is kept: its placeholder did not fit whole.
    expect(result.log).toBe(padding);
    expectNoRun(result.log, PASSWORD);
  }, 30_000);
});

/**
 * A replacement is not a shortening: `{{secret:PASS}}` is fifteen characters
 * for the eight of the base64 it replaces. The live scrub is charged for the
 * markers it writes, from what the step and the run have left, and the log is
 * cut where that runs out, with every marker whole.
 */
describe("script log redaction - a scrub that grows the log", () => {
  const SHORT: FlowScriptSecret = { name: "PASS", value: "s3cr3t" };
  const basicThenDone = `console.log("Basic " + Buffer.from(process.env.PASS).toString("base64"));
     console.log("done");`;

  // Far under the limit the growth has room: the placeholder is paid from what
  // the step has left, and the lines after it are kept.
  it("keeps every line of a short log the scrub made longer", async () => {
    const result = await runScript("grow-short.mjs", basicThenDone, [SHORT]);

    expect(result.log).toBe("Basic {{secret:PASS}}\ndone\n");
    expect(result.logTruncated).toBe(false);
  }, 30_000);

  // The run's budget pays for the placeholder too, and the log stops where it
  // runs out: the 27 bytes the two lines grow to do not fit the 25 left.
  it("charges the growth to the run's budget, and cuts the log where that runs out", async () => {
    const logBudget = { remainingBytes: 25 };
    const result = await runScript("grow-budget.mjs", basicThenDone, [SHORT], { logBudget });

    expect(result.log).toBe("Basic {{secret:PASS}}\ndon");
    expect(result.logTruncated).toBe(true);
    expect(logBudget.remainingBytes).toBe(0);
  }, 30_000);

  // Under the per-step limit as written, over it once each line's base64 is a
  // placeholder.
  it("keeps a log the scrub grew inside the per-step limit, with every marker whole", async () => {
    const line = "Basic {{secret:PASS}}\n";
    const result = await runScript(
      "grow.mjs",
      `process.stdout.write(("Basic " + Buffer.from(process.env.PASS).toString("base64") + "\\n").repeat(4000));`,
      [SHORT]
    );

    expect(result.logTruncated).toBe(true);
    expect(result.log.startsWith(line.repeat(2000))).toBe(true);
    // Cut where the step's limit runs out, not where the log as written ended.
    expect(Buffer.byteLength(result.log)).toBeLessThanOrEqual(SCRIPT_STEP_LOG_LIMIT_BYTES);
    expect(Buffer.byteLength(result.log)).toBeGreaterThan(
      SCRIPT_STEP_LOG_LIMIT_BYTES - line.length
    );
    expectWholeMarkers(result.log, SHORT.name);
    expectNoRun(result.log, SHORT);
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
       false --user "bob:$PASS" --header "Authorization: Basic $(printf '%s' "$PASS" | base64)"`,
      [PASS]
    );

    const message = result.failure?.message ?? "";
    expect(result.failure?.kind).toBe("exit");
    const traced =
      "+ false --user bob:{{secret:PASS}} --header 'Authorization: Basic {{secret:PASS}}'";
    expect(result.log).toContain(`${traced}\n`);
    expectRedacted(result.log, PASS);
    expect(message.endsWith(traced)).toBe(true);
    expectRedacted(message, PASS);
  }, 30_000);
});

/**
 * Past the cut nothing more reaches the log, so nothing is scrubbed there, and a
 * flood past the limit costs no scrub.
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
    // Three secrets, one of them multi-line, as a step with a few credentials
    // carries.
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

  /** The key as its own words, and as the base64 `base64` writes of it. */
  const REPORT_SH =
    `echo "calling the API with key $API_KEY"\n` + `printf '%s' "$API_KEY" | base64\n`;
  const REPORTED = "calling the API with key {{secret:API_KEY}}\n{{secret:API_KEY}}\n";

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
    expect(log).toBe(REPORTED);
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
    expect(log).toBe(REPORTED);
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
