import { z } from "zod";
import { promises as fs } from "fs";
import * as path from "path";
import type { ToolDefinition } from "@argent/registry";
import {
  cacheProfilerPaths,
  type ProfilerSessionPaths,
} from "../../../blueprints/react-profiler-session";
import {
  IOS_PROFILER_SESSION_NAMESPACE,
  type IosProfilerSessionApi,
} from "../../../blueprints/ios-profiler-session";
import { readCommitTree } from "../../../utils/react-profiler/debug/dump";
import { runIosProfilerPipeline } from "../../../utils/ios-profiler/pipeline/index";
import { getDebugDir } from "../../../utils/react-profiler/debug/dump";

const zodSchema = z.object({
  mode: z
    .enum(["list", "load_react", "load_instruments"])
    .describe(
      "list: show available sessions on disk. " +
        "load_react: load a React profiler session into memory for query tools. " +
        "load_instruments: re-parse iOS Instruments XML files into memory for query tools."
    ),
  session_id: z
    .string()
    .optional()
    .describe(
      "Timestamp-based session identifier (e.g. '20250313-143022') from the list output. " +
        "Required for load_react and load_instruments modes."
    ),
  port: z.coerce
    .number()
    .default(8081)
    .describe(
      "Metro port — the loaded React data is cached under this port for query tools (default 8081)"
    ),
  device_id: z
    .string()
    .describe(
      "iOS Simulator UDID (logicalDeviceId). Used to cache the loaded React session under the correct port+device key, and required to resolve the iOS session for load_instruments."
    ),
});

async function listSessions(debugDir: string): Promise<string> {
  let entries: string[];
  try {
    entries = await fs.readdir(debugDir);
  } catch {
    return "_No debug directory found. Profile the app first to generate trace data._";
  }

  const reactSessions = new Map<string, string[]>();
  const instrumentsSessions = new Map<string, string[]>();

  for (const entry of entries) {
    const reactMatch = entry.match(/^react-profiler-(\d{8}-\d{6})_/);
    if (reactMatch) {
      const sid = reactMatch[1];
      if (!reactSessions.has(sid)) reactSessions.set(sid, []);
      reactSessions.get(sid)!.push(entry);
      continue;
    }

    const instrMatch = entry.match(/^ios-profiler-(\d{8}-?\d{6})/);
    if (instrMatch) {
      const sid = instrMatch[1];
      if (!instrumentsSessions.has(sid)) instrumentsSessions.set(sid, []);
      instrumentsSessions.get(sid)!.push(entry);
    }
  }

  if (reactSessions.size === 0 && instrumentsSessions.size === 0) {
    return "_No profiling sessions found in the debug directory._";
  }

  const lines: string[] = ["## Available Profiling Sessions", ""];

  if (reactSessions.size > 0) {
    lines.push("### React Profiler Sessions", "");
    lines.push("| Session ID | Runtime | Device | Metro bundle |");
    lines.push("|---|---|---|---|");
    for (const [sid, files] of [...reactSessions.entries()].sort().reverse()) {
      let appName: string | null = null;
      let deviceName: string | null = null;
      let projectRoot: string | null = null;
      const commitsFile = files.find((f) => f.includes("_commits.json"));
      if (commitsFile) {
        try {
          const onDisk = await readCommitTree(path.join(debugDir, commitsFile));
          if (onDisk.meta) {
            appName = onDisk.meta.appName ?? null;
            deviceName = onDisk.meta.deviceName ?? null;
            projectRoot = onDisk.meta.projectRoot ?? null;
          }
        } catch {
          // older session or corrupted file — fall through to "—" placeholders
        }
      }
      const project = projectRoot ? path.basename(projectRoot) : null;
      lines.push(`| \`${sid}\` | ${appName ?? "—"} | ${deviceName ?? "—"} | ${project ?? "—"} |`);
    }
    lines.push("");
  }

  if (instrumentsSessions.size > 0) {
    lines.push("### iOS Instruments Sessions", "");
    lines.push("| Session ID | Files |");
    lines.push("|---|---|");
    for (const [sid, files] of [...instrumentsSessions.entries()].sort().reverse()) {
      const hasCpu = files.some((f) => f.includes("_raw_cpu.xml"));
      const hasHangs = files.some((f) => f.includes("_raw_hangs.xml"));
      const hasLeaks = files.some((f) => f.includes("_raw_leaks.xml"));
      const hasReport = files.some((f) => f.includes("-report.md"));
      const parts: string[] = [];
      if (hasCpu) parts.push("CPU");
      if (hasHangs) parts.push("hangs");
      if (hasLeaks) parts.push("leaks");
      if (hasReport) parts.push("report");
      lines.push(`| \`${sid}\` | ${parts.join(", ")} |`);
    }
    lines.push("");
  }

  lines.push(
    "_Use `load_react` or `load_instruments` with the session_id to load data for query tools._"
  );

  return lines.join("\n");
}

async function loadReactSession(
  debugDir: string,
  sessionId: string,
  port: number,
  deviceId: string
): Promise<string> {
  const cpuPath = path.join(debugDir, `react-profiler-${sessionId}_cpu.json`);
  const commitsPath = path.join(debugDir, `react-profiler-${sessionId}_commits.json`);
  const cpuIndexPath = path.join(debugDir, `react-profiler-${sessionId}_cpu-index.json`);

  // Verify files exist without reading full contents
  let hasCpu = false;
  let hasCommits = false;
  let hasCpuIndex = false;
  try {
    await fs.access(cpuPath);
    hasCpu = true;
  } catch {
    /* not present */
  }
  try {
    await fs.access(commitsPath);
    hasCommits = true;
  } catch {
    /* not present */
  }
  try {
    await fs.access(cpuIndexPath);
    hasCpuIndex = true;
  } catch {
    /* not present */
  }

  if (!hasCpu && !hasCommits) {
    throw new Error(
      `No data found for React session "${sessionId}". ` +
        `Expected files at:\n  ${cpuPath}\n  ${commitsPath}`
    );
  }

  // Parse only lightweight meta from commits file header
  let detectedArchitecture: "bridge" | "bridgeless" | null = null;
  let anyCompilerOptimized: boolean | null = null;
  let hotCommitIndices: number[] | null = null;
  let totalReactCommits: number | null = null;
  let appName: string | null = null;
  let deviceName: string | null = null;
  let projectRoot: string | null = null;
  let commitCount = 0;
  let sampleInfo = "not available";

  if (hasCommits) {
    try {
      const onDisk = await readCommitTree(commitsPath);
      commitCount = onDisk.commits.length;
      if (onDisk.meta) {
        detectedArchitecture = onDisk.meta.detectedArchitecture ?? null;
        anyCompilerOptimized = onDisk.meta.anyCompilerOptimized ?? null;
        hotCommitIndices = onDisk.meta.hotCommitIndices ?? null;
        totalReactCommits = onDisk.meta.totalReactCommits ?? null;
        appName = onDisk.meta.appName ?? null;
        deviceName = onDisk.meta.deviceName ?? null;
        projectRoot = onDisk.meta.projectRoot ?? null;
      }
    } catch {
      // non-fatal — file may be corrupted
    }
  }

  if (hasCpu) {
    // Read just enough to get sample count for display
    try {
      const cpuJson = await fs.readFile(cpuPath, "utf8");
      const parsed = JSON.parse(cpuJson) as { samples?: unknown[] };
      sampleInfo = `${parsed.samples?.length ?? "?"} samples`;
    } catch {
      sampleInfo = "available (could not read sample count)";
    }
  }

  const sessionPaths: ProfilerSessionPaths = {
    sessionId,
    debugDir,
    cpuProfilePath: hasCpu ? cpuPath : null,
    commitsPath: hasCommits ? commitsPath : null,
    cpuSampleIndexPath: hasCpuIndex ? cpuIndexPath : null,
    detectedArchitecture,
    anyCompilerOptimized,
    hotCommitIndices,
    totalReactCommits,
  };

  cacheProfilerPaths(port, sessionPaths, deviceId);

  const lines: string[] = [
    `Loaded React profiler session \`${sessionId}\` into port ${port}.`,
    "",
    `- Runtime: ${appName ?? "unknown"}`,
    `- Device: ${deviceName ?? "unknown"}`,
    `- Metro bundle: ${projectRoot ? path.basename(projectRoot) : "unknown"}`,
    `- CPU profile: ${sampleInfo}`,
    `- Commits persisted (hot ±1 margin, ≥16ms): ${commitCount}`,
    `- Total React commits: ${totalReactCommits ?? "unknown"}`,
    `- Architecture: ${detectedArchitecture ?? "unknown"}`,
    "",
    "Query tools (`profiler-cpu-query`, `profiler-commit-query`) are now ready to use against this data.",
  ];

  return lines.join("\n");
}

async function loadInstrumentsSession(
  debugDir: string,
  sessionId: string,
  api: IosProfilerSessionApi
): Promise<string> {
  // Find exported XML files for this session
  const cpuXml = path.join(debugDir, `ios-profiler-${sessionId}_raw_cpu.xml`);
  const hangsXml = path.join(debugDir, `ios-profiler-${sessionId}_raw_hangs.xml`);
  const leaksXml = path.join(debugDir, `ios-profiler-${sessionId}_raw_leaks.xml`);

  const files: Record<string, string | null> = {
    cpu: null,
    hangs: null,
    leaks: null,
  };

  try {
    await fs.access(cpuXml);
    files.cpu = cpuXml;
  } catch {
    /* file doesn't exist */
  }

  try {
    await fs.access(hangsXml);
    files.hangs = hangsXml;
  } catch {
    /* file doesn't exist */
  }

  try {
    await fs.access(leaksXml);
    files.leaks = leaksXml;
  } catch {
    /* file doesn't exist */
  }

  if (!files.cpu && !files.hangs && !files.leaks) {
    throw new Error(
      `No iOS Instruments XML files found for session "${sessionId}". ` +
        `Expected files matching ios-profiler-${sessionId}_raw_*.xml in ${debugDir}`
    );
  }

  const { cpuSamples, uiHangs, cpuHotspots, memoryLeaks } = await runIosProfilerPipeline(files);

  api.parsedData = { cpuSamples, uiHangs, cpuHotspots, memoryLeaks };
  api.exportedFiles = files;

  const lines: string[] = [
    `Loaded iOS Instruments session \`${sessionId}\`.`,
    "",
    `- CPU samples: ${cpuSamples.length}`,
    `- UI hangs: ${uiHangs.length}`,
    `- CPU hotspots: ${cpuHotspots.length}`,
    `- Memory leaks: ${memoryLeaks.length}`,
    "",
    "Query tools (`profiler-stack-query`) are now ready to use against this data.",
  ];

  return lines.join("\n");
}

export const profilerLoadTool: ToolDefinition<z.infer<typeof zodSchema>, string> = {
  id: "profiler-load",
  description: `Fetch and restore a previously captured profiling session from disk into memory so query tools can operate on it.
This is the disk-restore counterpart to react-profiler-stop/ios-profiler-stop, which write data, and to the query tools (profiler-cpu-query, profiler-commit-query, profiler-stack-query), which read it.
Use when you need to revisit past session data without capturing a new recording.
Modes:
- list: Show all available profiling sessions in the project's debug directory.
- load_react: Load a React profiler session (CPU profile + commit tree) into memory. Requires session_id.
- load_instruments: Re-parse iOS Instruments XML files into memory. Requires session_id and device_id.
Returns a summary of the loaded session or a session list for the list mode.
Fails if the session_id is not found or required XML files are missing from disk.`,
  zodSchema,
  services: (params) => {
    const svcs: Record<string, string> = {};
    if (params.mode === "load_instruments") {
      svcs.session = `${IOS_PROFILER_SESSION_NAMESPACE}:${params.device_id}`;
    }
    return svcs;
  },
  async execute(services, params) {
    const debugDir = await getDebugDir();

    switch (params.mode) {
      case "list":
        return listSessions(debugDir);

      case "load_react": {
        if (!params.session_id) {
          throw new Error(
            "load_react mode requires the session_id parameter. Use list mode first."
          );
        }
        return loadReactSession(debugDir, params.session_id, params.port, params.device_id);
      }

      case "load_instruments": {
        if (!params.session_id) {
          throw new Error(
            "load_instruments mode requires the session_id parameter. Use list mode first."
          );
        }
        const api = services.session as IosProfilerSessionApi;
        return loadInstrumentsSession(debugDir, params.session_id, api);
      }

      default:
        throw new Error(`Unknown mode: ${params.mode}`);
    }
  },
};
