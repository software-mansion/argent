/**
 * The MCP adapter aborts a tool call at FETCH_TIMEOUT_MS (30 s) unless the tool
 * declares `longRunning`, then replays the same POST up to MAX_RETRIES times
 * (packages/argent-mcp/src/mcp-server.ts). The tool-server never cancels the
 * work an aborted request started, so every profiler tool that can re-parse a
 * whole native trace must opt out of that abort - otherwise each replay
 * re-parses from scratch and the report is never returned.
 */
import { describe, expect, it } from "vitest";
import { nativeProfilerAnalyzeTool } from "../src/tools/profiler/native-profiler/native-profiler-analyze";
import { profilerLoadTool } from "../src/tools/profiler/query/profiler-load";
import { profilerStackQueryTool } from "../src/tools/profiler/query/profiler-stack-query";
import { profilerCombinedReportTool } from "../src/tools/profiler/combined/profiler-combined-report";

const traceParsingTools: { id: string; longRunning?: boolean }[] = [
  nativeProfilerAnalyzeTool,
  profilerLoadTool,
  profilerStackQueryTool,
  profilerCombinedReportTool,
];

describe("profiler tools that re-parse a native trace", () => {
  it.each(traceParsingTools)(
    "$id is declared longRunning so the MCP fetch timeout cannot abort and replay the parse",
    (tool) => {
      expect(tool.longRunning).toBe(true);
    }
  );
});
