#!/usr/bin/env node
// @ts-check
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ANSI colours
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const prompt = process.argv[2];
if (!prompt) {
  console.error("Usage: benchmark.cjs <task prompt>");
  process.exit(1);
}

/** @param {number} n */
function fmtNum(n) {
  return n.toLocaleString("en-US");
}

/** @param {number} n @param {number} width */
function padLeft(n, width) {
  return fmtNum(n).padStart(width);
}

/** @param {string} s @param {number} width */
function padLeftStr(s, width) {
  return s.padStart(width);
}

/** @param {string[]} extraArgs @returns {any} */
function runClaude(extraArgs) {
  const result = spawnSync(
    "claude",
    ["-p", prompt, "--output-format", "json", ...extraArgs],
    {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5 * 60 * 1000,
    }
  );
  if (result.status !== 0) {
    const errMsg = result.stderr || result.error?.message || "unknown error";
    throw new Error(`claude exited with status ${result.status}:\n${errMsg}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Failed to parse claude output:\n${result.stdout}`);
  }
}

function writeTempEmptyMcp() {
  const tmp = path.join(
    os.tmpdir(),
    `radon-bench-empty-mcp-${Date.now()}.json`
  );
  fs.writeFileSync(tmp, JSON.stringify({ mcpServers: {} }));
  return tmp;
}

/**
 * @param {string} prompt
 * @param {any} withMcp
 * @param {any} withoutMcp
 */
function printReport(prompt, withMcp, withoutMcp) {
  const w = withMcp.usage ?? {};
  const wo = withoutMcp.usage ?? {};

  const wIn = w.input_tokens ?? 0;
  const woIn = wo.input_tokens ?? 0;
  const wOut = w.output_tokens ?? 0;
  const woOut = wo.output_tokens ?? 0;
  const wCache = w.cache_read_input_tokens ?? 0;
  const woCache = wo.cache_read_input_tokens ?? 0;
  const wCost = withMcp.cost_usd ?? 0;
  const woCost = withoutMcp.cost_usd ?? 0;

  const dIn = wIn - woIn;
  const dOut = wOut - woOut;
  const dCache = wCache - woCache;
  const dCost = wCost - woCost;

  const BAR = "━".repeat(51);
  const LINE = "─".repeat(51);
  const COL = 14; // column width for numbers

  /** @param {number} n @param {boolean} [isCost] */
  function delta(n, isCost = false) {
    const sign = n > 0 ? "+" : n < 0 ? "" : " ";
    const str = isCost
      ? `${sign}$${Math.abs(n).toFixed(4)}`
      : `${sign}${fmtNum(n)}`;
    if (n > 0) return YELLOW + str + RESET;
    if (n < 0) return GREEN + str + RESET;
    return DIM + str + RESET;
  }

  console.log();
  console.log(BOLD + CYAN + BAR + RESET);
  console.log(BOLD + "  MCP Cost Benchmark" + RESET);
  console.log(`  Task: ${DIM}"${prompt}"${RESET}`);
  console.log(BOLD + CYAN + BAR + RESET);
  console.log();

  const header = `${"".padStart(22)}${padLeftStr("WITH MCP", COL)}${padLeftStr("WITHOUT MCP", COL)}${padLeftStr("DELTA", COL)}`;
  console.log(DIM + header + RESET);

  console.log(
    `  ${"Input tokens".padEnd(20)}${padLeft(wIn, COL)}${padLeft(woIn, COL)}${padLeftStr(delta(dIn), COL + (dIn !== 0 ? 9 : 9))}`
  );
  console.log(
    `  ${"Output tokens".padEnd(20)}${padLeft(wOut, COL)}${padLeft(woOut, COL)}${padLeftStr(delta(dOut), COL + (dOut !== 0 ? 9 : 9))}`
  );
  console.log(
    `  ${"Cache read tokens".padEnd(20)}${padLeft(wCache, COL)}${padLeft(woCache, COL)}${padLeftStr(delta(dCache), COL + (dCache !== 0 ? 9 : 9))}`
  );

  console.log("  " + LINE);

  const wCostStr = `$${wCost.toFixed(4)}`;
  const woCostStr = `$${woCost.toFixed(4)}`;
  console.log(
    `  ${"Cost (USD)".padEnd(20)}${padLeftStr(wCostStr, COL)}${padLeftStr(woCostStr, COL)}${padLeftStr(delta(dCost, true), COL + 9)}`
  );

  console.log();

  const overheadIn = dIn >= 0 ? `+${fmtNum(dIn)}` : fmtNum(dIn);
  const overheadCost = dCost >= 0 ? `+$${dCost.toFixed(4)}` : `-$${Math.abs(dCost).toFixed(4)}`;
  console.log(
    BOLD +
      `  MCP overhead: ${YELLOW}${overheadIn} input tokens${RESET}${BOLD} / ${YELLOW}${overheadCost}${RESET}${BOLD} per task run` +
      RESET
  );
  console.log();
}

/**
 * @param {string} prompt
 * @param {any} withMcp
 * @param {any} withoutMcp
 */
function saveReport(prompt, withMcp, withoutMcp) {
  const dir = path.join(os.homedir(), ".radon-lite");
  fs.mkdirSync(dir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(dir, `benchmark-${ts}.json`);

  const report = {
    timestamp: new Date().toISOString(),
    prompt,
    withMcp,
    withoutMcp,
    delta: {
      input_tokens:
        (withMcp.usage?.input_tokens ?? 0) -
        (withoutMcp.usage?.input_tokens ?? 0),
      output_tokens:
        (withMcp.usage?.output_tokens ?? 0) -
        (withoutMcp.usage?.output_tokens ?? 0),
      cache_read_input_tokens:
        (withMcp.usage?.cache_read_input_tokens ?? 0) -
        (withoutMcp.usage?.cache_read_input_tokens ?? 0),
      cost_usd: (withMcp.cost_usd ?? 0) - (withoutMcp.cost_usd ?? 0),
    },
  };

  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\n${CYAN}Running WITH MCP...${RESET}`);
let withMcp;
try {
  withMcp = runClaude(["--allowedTools", "mcp__radon-lite__*"]);
} catch (err) {
  console.error(`${"\x1b[31m"}WITH MCP run failed:${RESET}`, err.message);
  process.exit(1);
}

const tmpMcp = writeTempEmptyMcp();
console.log(`${CYAN}Running WITHOUT MCP...${RESET}`);
let withoutMcp;
try {
  withoutMcp = runClaude(["--strict-mcp-config", "--mcp-config", tmpMcp]);
} catch (err) {
  fs.unlinkSync(tmpMcp);
  console.error(`${"\x1b[31m"}WITHOUT MCP run failed:${RESET}`, err.message);
  process.exit(1);
}
fs.unlinkSync(tmpMcp);

printReport(prompt, withMcp, withoutMcp);

const savedFile = saveReport(prompt, withMcp, withoutMcp);

console.log(BOLD + CYAN + "━".repeat(51) + RESET);
console.log(`  Report saved: ${DIM}${savedFile}${RESET}`);
console.log(BOLD + CYAN + "━".repeat(51) + RESET);
console.log();
