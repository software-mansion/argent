#!/usr/bin/env node
// @ts-check
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");

const LOG_FILE = process.env.RADON_MCP_LOG ?? path.join(os.homedir(), ".argent", "mcp-calls.log");

// Ensure log file exists
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
if (!fs.existsSync(LOG_FILE)) {
  fs.writeFileSync(LOG_FILE, "");
}

// ANSI colours
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

function formatTime(ts) {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 8);
}

function pad(str, len) {
  return String(str).padEnd(len);
}

function formatEntry(entry) {
  const time = formatTime(entry.ts);
  if (entry.event === "list_tools") {
    return `${DIM}${time}${RESET} ${YELLOW}·${RESET}  list_tools                 ${entry.count} tools`;
  }
  if (entry.event === "tool_called") {
    const args = entry.args ? JSON.stringify(entry.args) : "";
    return `${DIM}${time}${RESET} ${CYAN}→${RESET}  tool_called   ${pad(entry.name, 12)} ${DIM}${args}${RESET}`;
  }
  if (entry.event === "tool_result") {
    let status;
    if (entry.isError) {
      status = `${RED}✗${RESET}  ${DIM}${entry.error ?? ""}${RESET}`;
    } else {
      let resultStr = "";
      if (entry.result !== undefined) {
        const raw = typeof entry.result === "string"
          ? entry.result
          : JSON.stringify(entry.result);
        resultStr = "  " + DIM + (raw.length > 120 ? raw.slice(0, 117) + "…" : raw) + RESET;
      }
      status = `${GREEN}✓${RESET}${resultStr}`;
    }
    return `${DIM}${time}${RESET} ${entry.isError ? RED : GREEN}←${RESET}  tool_result   ${pad(entry.name, 12)} ${entry.durationMs}ms ${status}`;
  }
  return `${DIM}${time}${RESET} ${JSON.stringify(entry)}`;
}

// Seek to end of file — only tail new lines
let filePos = fs.statSync(LOG_FILE).size;

console.log(`Waiting for calls at ${LOG_FILE} ...\n`);

let buffer = "";

function readNewLines() {
  const stat = fs.statSync(LOG_FILE);
  if (stat.size < filePos) {
    // File was truncated/rotated — reset
    filePos = 0;
    buffer = "";
  }
  if (stat.size === filePos) return;

  const fd = fs.openSync(LOG_FILE, "r");
  const len = stat.size - filePos;
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, filePos);
  fs.closeSync(fd);
  filePos = stat.size;

  buffer += buf.toString("utf8");
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? ""; // keep incomplete last line

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      console.log(formatEntry(entry));
    } catch {
      console.log(trimmed);
    }
  }
}

fs.watch(LOG_FILE, () => {
  readNewLines();
});
