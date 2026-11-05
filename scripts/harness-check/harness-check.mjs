#!/usr/bin/env node
/**
 * Harness check: runs real coding-agent CLIs against the Argent MCP server of a built
 * checkout, records the request each one sends to its model, and reports which facts of
 * Argent's tool schemas the model can read, which are lost, and which it reads twice.
 *
 * Usage and how to read the results: scripts/harness-check/README.md
 *   npm run harness-check
 *   npm run harness-check -- --with claude,kiro
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { analyzeRun, compareRun, verdict } from "./analyze.mjs";
import { ACCOUNT_HARNESSES, DEFAULT_HARNESSES, killRunning, planRuns, run } from "./harnesses.mjs";
import { startModelStub, startRecordingProxy } from "./model-stub.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const HELP = `Usage: npm run harness-check -- [options]

  --with claude,kiro    also run Claude Code and/or Kiro CLI (installed and signed in)
  --only codex,gemini   run only these (codex, opencode, gemini, claude, kiro)
  --claude-all-tools    also run Claude Code with every Argent tool loaded (about $0.50)
  --compare <dir>       compare with the results folder of an earlier check
  --repo <dir>          the built checkout whose server to run (default: this one)
  --out <dir>           where to write results (default: a new folder in the temp dir)
  --cache <dir>         where pinned CLIs are installed (default: node_modules/.cache)
  --help

See scripts/harness-check/README.md.`;

const { values: opts } = parseArgs({
  options: {
    "with": { type: "string", default: "" },
    "only": { type: "string", default: "" },
    "claude-all-tools": { type: "boolean", default: false },
    "compare": { type: "string" },
    "repo": { type: "string" },
    "out": { type: "string" },
    "cache": { type: "string" },
    "help": { type: "boolean", default: false },
  },
});
if (opts.help) {
  console.log(HELP);
  process.exit(0);
}

const list = (s) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
const known = [...DEFAULT_HARNESSES, ...ACCOUNT_HARNESSES];
let ids = opts.only ? list(opts.only) : [...DEFAULT_HARNESSES, ...list(opts.with)];
if (opts["claude-all-tools"] && !ids.includes("claude")) ids.push("claude");
const unknown = ids.filter((id) => !known.includes(id));
if (unknown.length) fail(`Unknown harness: ${unknown.join(", ")}. Known: ${known.join(", ")}.`);
ids = known.filter((id) => ids.includes(id));

const scriptRepo = resolve(here, "..", "..");
const repo = resolve(opts.repo ?? scriptRepo);
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = resolve(opts.out ?? join(tmpdir(), "argent-harness-check", stamp));
const cacheDir = resolve(
  opts.cache ?? join(scriptRepo, "node_modules", ".cache", "argent-harness-check")
);
const log = (line = "") => console.log(line);

// Without this, Ctrl-C would leave the running harness and its Argent server behind.
for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"])) {
  process.on(signal, () => {
    killRunning();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

/** @returns {never} */
function fail(message) {
  console.error(`harness-check: ${message}`);
  process.exit(1);
}

for (const file of [
  "packages/argent-mcp/dist/mcp-server.js",
  "packages/tool-server/dist/http.js",
]) {
  if (!existsSync(join(repo, file)))
    fail(`${join(repo, file)} is missing. Run \`npm run build\` in ${repo} first.`);
}
// Read the earlier check now, so a wrong path fails before any harness spends a request.
let earlier = null;
if (opts.compare) {
  const earlierFile = join(resolve(opts.compare), "results.json");
  if (!existsSync(earlierFile)) fail(`${earlierFile} not found.`);
  earlier = JSON.parse(readFileSync(earlierFile, "utf8"));
}
mkdirSync(out, { recursive: true });

async function git(...args) {
  const r = await run("git", ["-C", repo, ...args], { timeoutMs: 10_000 });
  return r.code === 0 ? r.stdout.trim() : "";
}
const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
const commit = await git("rev-parse", "--short", "HEAD");
const dirty = (await git("status", "--porcelain", "--untracked-files=no")) !== "";
const source = `${repo} (${branch || "?"} @ ${commit || "?"}${dirty ? ", with uncommitted changes" : ""})`;

log("Argent harness check");
log(`  Server:  ${source}`);
log(`  Results: ${out}`);
log();

// 1. The reference: what the server serves, before any client-specific text.
const serverScript = join(here, "server.mjs");
const ref = await run(
  process.execPath,
  [serverScript, "--repo", repo, "--home", join(out, "server-home"), "--reference"],
  {
    timeoutMs: 120_000,
  }
);
if (ref.code !== 0) fail(`Could not read the server's tool list:\n${ref.stderr}`);
const reference = JSON.parse(ref.stdout.trim().split("\n").pop());
writeFileSync(join(out, "reference.json"), JSON.stringify(reference, null, 1));

// 2. The harnesses.
const stub = await startModelStub();
const proxy = ids.includes("claude") ? await startRecordingProxy() : null;
const runs = await planRuns(ids, {
  repo,
  out,
  cacheDir,
  serverScript,
  stubUrl: stub.url,
  proxyUrl: proxy?.url,
  reference,
  claudeAllTools: opts["claude-all-tools"],
  log,
}).catch((e) => fail(e.message));

const results = [];
for (const [i, r] of runs.entries()) {
  const v = await run(r.bin, r.versionArgs, {
    env: r.versionEnv,
    cwd: r.workspace,
    timeoutMs: 30_000,
  });
  const version = (v.stdout.match(/\d+\.\d+\.\d+[\w.-]*/) ?? [""])[0];
  process.stdout.write(`  [${i + 1}/${runs.length}] ${r.label} ${version} ... `);
  if (r.via === "stub") stub.use(r.requests, r.codexToolSearch);
  if (r.via === "proxy") proxy.use(r.requests);
  const started = Date.now();
  const res = await run(r.bin, r.args, { env: r.env, cwd: r.workspace });
  writeFileSync(
    join(r.dir, "output.txt"),
    `$ ${r.bin} ${r.args.join(" ")}\nexit ${res.code}${res.timedOut ? " (timed out)" : ""}\n\n--- stdout\n${res.stdout}\n--- stderr\n${res.stderr}`
  );
  const serverLog = join(r.dir, "server.log");
  const names = existsSync(serverLog)
    ? [
        ...new Set(
          readFileSync(serverLog, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l).clientInfo?.name)
        ),
      ]
    : [];
  const analysis = analyzeRun(reference, r.requests);
  let failure = "";
  if (!analysis.recorded)
    failure = res.timedOut
      ? "timed out, no request recorded"
      : `no request recorded (exit ${res.code})`;
  else if (!names.length) failure = "the Argent server was never started";
  results.push({
    id: r.id,
    label: r.label,
    version,
    clientNames: names,
    exitCode: res.code,
    timedOut: res.timedOut,
    failure,
    folder: r.dir,
    ...analysis,
  });
  log(`${Math.round((Date.now() - started) / 1000)} s`);
}
stub.close();
proxy?.close();

// 3. The report.
const pad = (s, n) => String(s).padEnd(n);
const columns = [
  "Harness",
  "Version",
  "Sent as",
  "Tools",
  "Facts lost",
  "Repeated by Argent",
  "Instructions",
  "Input tokens",
  "Result",
];
const rows = results.map((r) => [
  r.label,
  r.version || "?",
  r.clientNames.join(", ") || "-",
  r.recorded ? `${r.toolsSeen}/${r.toolsTotal}` : "-",
  r.recorded && r.toolsSeen ? `${r.lost.length} of ${r.factsChecked}` : "-",
  r.recorded && r.toolsSeen ? String(r.repeatedByArgent.length) : "-",
  r.recorded ? r.instructions : "-",
  r.apiInputTokens ?? "-",
  verdict(r),
]);
const widths = columns.map((c, i) =>
  Math.max(c.length, ...rows.map((row) => String(row[i]).length))
);
const LEGEND = [
  [
    "Tools",
    "Argent tools whose schema is in the request. Claude Code loads most tools only when they are needed, so its first request has about a dozen; --claude-all-tools loads them all.",
  ],
  [
    "Facts lost",
    "values that only a schema keyword states (defaults, ranges, length and item limits) and that the model cannot read anywhere in the request.",
  ],
  [
    "Repeated by Argent",
    "facts the model reads twice because Argent added a sentence for a keyword the harness kept. Expected only where the harness's handling depends on the model (opencode with an Anthropic model).",
  ],
  ["Instructions", "whether the Argent server's instructions are in the request."],
  [
    "Input tokens",
    "the whole request, as counted by Anthropic's API (Claude Code only; the other harnesses talk to a stand-in, so nothing counts their tokens).",
  ],
  [
    "Result",
    "OK, LOSES n, REPEATS n, UNEXPECTED TEXT (Argent added text that states no keyword of its param), or FAILED.",
  ],
];

log();
log(columns.map((c, i) => pad(c, widths[i])).join("  "));
for (const row of rows) log(row.map((c, i) => pad(c, widths[i])).join("  "));
log();
for (const [term, text] of LEGEND) log(`${term}: ${text}`);

const examples = (label, items, n = 3) =>
  items.length
    ? [
        `    ${label} (${items.length}): ${items.slice(0, n).join("; ")}${items.length > n ? "; ..." : ""}`,
      ]
    : [];
const problems = results.filter((r) => verdict(r) !== "OK");
if (problems.length) {
  log();
  log("Details (all of them are in report.md):");
  for (const r of problems) {
    log(`  ${r.label}: ${verdict(r)}`);
    if (r.failure) log(`    see ${join(r.folder, "output.txt")}`);
    else
      for (const line of [
        ...examples("lost", r.lost),
        ...examples("repeated by Argent", r.repeatedByArgent),
        ...examples("unexpected", r.unexpected),
      ])
        log(line);
  }
}

// 4. The comparison with an earlier check.
let comparison = null;
if (earlier) {
  const sentences = (s) => s.split(/(?<=\.)\s+/).filter(Boolean);
  const before = new Set(sentences(earlier.reference.instructions));
  const now = new Set(sentences(reference.instructions));
  comparison = {
    against: earlier.meta,
    instructionsRemoved: [...before].filter((s) => !now.has(s)),
    instructionsAdded: [...now].filter((s) => !before.has(s)),
    runs: results
      .map((r) => ({ r, e: earlier.runs.find((x) => x.id === r.id) }))
      .filter(({ e }) => e)
      .map(({ r, e }) => ({ id: r.id, label: r.label, ...compareRun(e, r) })),
  };
  const count = (items, word) => (items.length ? `${items.length} ${word}` : "same");
  const cmpColumns = [
    "Harness",
    "Param descriptions",
    "Tool descriptions",
    "Keywords and types",
    "Tools",
    "Instructions in request",
    "Input tokens",
  ];
  const cmpRows = comparison.runs.map((c) =>
    c.skipped
      ? [c.label, `not compared: ${c.skipped}`, ...cmpColumns.slice(2).map(() => "-")]
      : [
          c.label,
          c.appended.length || c.otherText.length
            ? [
                c.appended.length && `${c.appended.length} with text added at the end`,
                c.otherText.length && `${c.otherText.length} otherwise changed`,
              ]
                .filter(Boolean)
                .join(", ")
            : "same",
          count(c.toolDescriptions, "changed"),
          count(c.schemas, "tools changed"),
          c.toolsAdded.length || c.toolsRemoved.length
            ? `+${c.toolsAdded.length} / -${c.toolsRemoved.length}`
            : "same",
          c.instructions,
          c.tokensBefore != null && c.tokensAfter != null
            ? `${c.tokensBefore} -> ${c.tokensAfter} (${c.tokensAfter - c.tokensBefore >= 0 ? "+" : ""}${c.tokensAfter - c.tokensBefore})`
            : "-",
        ]
  );
  const cw = cmpColumns.map((c, i) =>
    Math.max(c.length, ...cmpRows.map((row) => String(row[i]).length))
  );
  log();
  log(`Compared with ${resolve(opts.compare)}`);
  log(`  (${earlier.meta.source})`);
  log();
  log(cmpColumns.map((c, i) => pad(c, cw[i])).join("  "));
  for (const row of cmpRows) log(row.map((c, i) => pad(c, cw[i])).join("  "));
  log();
  log(
    `Server instructions: ${comparison.instructionsRemoved.length || comparison.instructionsAdded.length ? "changed" : "same"}`
  );
  for (const s of comparison.instructionsRemoved) log(`  - ${s}`);
  for (const s of comparison.instructionsAdded) log(`  + ${s}`);
}

// 5. Files.
const meta = { date: new Date().toISOString(), source, repo, branch, commit, dirty };
writeFileSync(
  join(out, "results.json"),
  JSON.stringify({ meta, reference, runs: results, comparison }, null, 1)
);

const md = [];
md.push("# Argent harness check", "");
md.push(
  `- Date: ${meta.date}`,
  `- Server: ${source}`,
  `- Catalog: ${reference.tools.length} tools`,
  ""
);
md.push(`| ${columns.join(" | ")} |`, `|${columns.map(() => "---").join("|")}|`);
for (const row of rows) md.push(`| ${row.join(" | ")} |`);
md.push("", ...LEGEND.map(([term, text]) => `- **${term}**: ${text}`), "");
md.push("## Details", "");
for (const r of results) {
  md.push(`### ${r.label} ${r.version}`, "");
  md.push(`- Result: ${verdict(r)}`);
  md.push(`- Client name sent to Argent: ${r.clientNames.join(", ") || "none"}`);
  md.push(
    `- Folder: \`${r.folder}\` (\`output.txt\` is the harness output; \`requests/\` holds the recorded requests)`
  );
  if (r.recorded) {
    md.push(`- Request read: \`${r.requestFile}\` (${r.recorded} recorded)`);
    md.push(`- Argent added text to ${r.paramsWithAddedText} param descriptions`);
    md.push(
      `- Facts checked: ${r.factsChecked}; read twice because Argent's own description already restates the keyword: ${r.repeatedInDescription.length}`
    );
  }
  if (r.exitCode !== 0)
    md.push(`- The harness exited with code ${r.exitCode}${r.timedOut ? " (timed out)" : ""}`);
  const section = (title, items) => {
    if (!items?.length) return;
    md.push("", `${title} (${items.length}):`, "", ...items.map((x) => `- ${x}`));
  };
  section("Lost", r.lost);
  section("Repeated because of Argent's added text", r.repeatedByArgent);
  section("Repeated by text the harness added", r.repeatedByHarness);
  section("Unexpected text", r.unexpected);
  section("Param descriptions the harness changed", r.changedByHarness);
  md.push("");
}
if (comparison) {
  md.push(
    "## Compared with an earlier check",
    "",
    `Earlier: ${comparison.against.source}, ${comparison.against.date}`,
    ""
  );
  for (const c of comparison.runs) {
    if (c.skipped) {
      md.push(`### ${c.label}`, "", `- Not compared: ${c.skipped}`, "");
      continue;
    }
    md.push(`### ${c.label}`, "", `- Instructions in request: ${c.instructions}`);
    const section = (title, items) =>
      items.length && md.push("", `${title} (${items.length}):`, "", ...items.map((x) => `- ${x}`));
    section("Param descriptions with text added at the end", c.appended);
    section("Param descriptions otherwise changed", c.otherText);
    section("Tool descriptions changed", c.toolDescriptions);
    section("Tools whose keywords or types changed", c.schemas);
    section("Tools only in this check", c.toolsAdded);
    section("Tools only in the earlier check", c.toolsRemoved);
    md.push("");
  }
  md.push("Server instructions:", "");
  md.push(
    ...comparison.instructionsRemoved.map((s) => `- removed: ${s}`),
    ...comparison.instructionsAdded.map((s) => `- added: ${s}`)
  );
  if (!comparison.instructionsRemoved.length && !comparison.instructionsAdded.length)
    md.push("- same");
  md.push("");
}
writeFileSync(join(out, "report.md"), md.join("\n"));

log();
log(`Report: ${join(out, "report.md")}`);
log(`Data:   ${join(out, "results.json")}`);
process.exit(0);
