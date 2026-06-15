import { z } from "zod";
import { promises as fs } from "fs";
import * as path from "path";
import type { ServiceRef, ToolDefinition } from "@argent/registry";
import {
  cacheProfilerPaths,
  type ProfilerSessionPaths,
} from "../../../blueprints/react-profiler-session";
import {
  nativeProfilerSessionRef,
  type NativeProfilerSessionApi,
} from "../../../blueprints/native-profiler-session";
import { resolveDevice } from "../../../utils/device-info";
import { RN_ONLY_TOOL_CAPABILITY } from "../../debugger/debugger-service-ref";
import { readCommitTree } from "../../../utils/react-profiler/debug/dump";
import { runIosProfilerPipeline } from "../../../utils/ios-profiler/pipeline/index";
import { getDebugDir } from "../../../utils/react-profiler/debug/dump";
import { readAndroidNativeProfilerMetadata } from "../../../utils/android-profiler/session-metadata";

// session_id is interpolated into on-disk file paths
// (`react-profiler-${id}_cpu.json`, `native-profiler-${id}_raw_cpu.xml`, …).
// Restrict it to a safe token so it can't traverse out of the debug dir.
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function assertSafeSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(
      `Invalid session_id "${sessionId}". Allowed: letters, digits, '_' and '-' ` +
        `(no path separators, no "..").`
    );
  }
}

const zodSchema = z.object({
  mode: z
    .enum(["list", "load_react", "load_native"])
    .describe(
      "list: show available sessions on disk. " +
        "load_react: load a React profiler session into memory for query tools. " +
        "load_native: re-parse native profiler XML files (xctrace on iOS) into memory for query tools."
    ),
  session_id: z
    .string()
    .regex(SESSION_ID_PATTERN, "session_id may only contain letters, digits, '_' and '-'")
    .optional()
    .describe(
      "Timestamp-based session identifier (e.g. '20250313-143022') from the list output. " +
        "Required for load_react and load_native modes."
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
      "Target device id from `list-devices`. Used to cache the loaded React session under the correct port+device key, and required to resolve the native profiler session for load_native."
    ),
  app_process: z
    .string()
    .optional()
    .describe(
      "Android package name to use when restoring older load_native .pftrace sessions that do not have a metadata sidecar."
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
  const nativeSessions = new Map<string, string[]>();

  for (const entry of entries) {
    const reactMatch = entry.match(/^react-profiler-(\d{8}-\d{6})_/);
    if (reactMatch) {
      const sid = reactMatch[1];
      if (!reactSessions.has(sid)) reactSessions.set(sid, []);
      reactSessions.get(sid)!.push(entry);
      continue;
    }

    const nativeMatch = entry.match(/^native-profiler-(\d{8}-?\d{6})/);
    if (nativeMatch) {
      const sid = nativeMatch[1];
      if (!nativeSessions.has(sid)) nativeSessions.set(sid, []);
      nativeSessions.get(sid)!.push(entry);
    }
  }

  // Android .pftrace sessions live next to the iOS-style XML sessions but with
  // a different extension. The serial may include a port (`emulator-5554`), so
  // the filename pattern doesn't constrain it — anything ending in .pftrace
  // under the canonical timestamp prefix counts.
  const androidSessions = new Map<string, string[]>();
  for (const entry of entries) {
    const m = entry.match(/^native-profiler-(\d{8}-?\d{6})\.pftrace$/);
    if (m) {
      const sid = m[1];
      if (!androidSessions.has(sid)) androidSessions.set(sid, []);
      androidSessions.get(sid)!.push(entry);
    }
  }

  if (reactSessions.size === 0 && nativeSessions.size === 0 && androidSessions.size === 0) {
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

  if (nativeSessions.size > 0) {
    lines.push("### Native Profiler Sessions (iOS)", "");
    lines.push("| Session ID | Files |");
    lines.push("|---|---|");
    for (const [sid, files] of [...nativeSessions.entries()].sort().reverse()) {
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

  if (androidSessions.size > 0) {
    lines.push("### Native Profiler Sessions (Android)", "");
    lines.push("| Session ID | Files |");
    lines.push("|---|---|");
    for (const [sid] of [...androidSessions.entries()].sort().reverse()) {
      lines.push(`| \`${sid}\` | pftrace |`);
    }
    lines.push("");
  }

  lines.push(
    "_Use `load_react` or `load_native` with the session_id to load data for query tools._"
  );

  return lines.join("\n");
}

async function loadReactSession(
  debugDir: string,
  sessionId: string,
  port: number,
  deviceId: string
): Promise<string> {
  assertSafeSessionId(sessionId);
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

async function loadNativeSession(
  debugDir: string,
  sessionId: string,
  api: NativeProfilerSessionApi,
  appProcessOverride?: string
): Promise<string> {
  assertSafeSessionId(sessionId);
  // Android .pftrace first — the platform field on the resolved session API
  // tells us which shape to load. If the platform is android but the .pftrace
  // is missing we fall through to the iOS XML path so the user gets the
  // "no files found" error.
  if (api.platform === "android") {
    const pftrace = path.join(debugDir, `native-profiler-${sessionId}.pftrace`);
    try {
      await fs.access(pftrace);
    } catch {
      throw new Error(
        `No native profiler .pftrace found for session "${sessionId}". ` +
          `Expected file at ${pftrace}`
      );
    }
    const metadata = await readAndroidNativeProfilerMetadata(pftrace);
    const appProcess = metadata?.appProcess ?? appProcessOverride?.trim();
    if (!appProcess) {
      throw new Error(
        `Android profiler session "${sessionId}" is missing its metadata sidecar. ` +
          "Retry profiler-load with app_process set to the Android package name used for the recording."
      );
    }
    api.traceFile = pftrace;
    api.exportedFiles = { pftrace };
    api.appProcess = appProcess;
    api.wallClockStartMs = metadata?.wallClockStartMs ?? null;
    api.parsedData = null;
    return [
      `Loaded Android profiler session \`${sessionId}\`.`,
      "",
      `- Trace file: \`${pftrace}\``,
      `- App package: \`${appProcess}\``,
      "",
      "Query tools (`profiler-stack-query`) will re-query the .pftrace on demand.",
      "Run `native-profiler-analyze` to produce a report from this trace.",
    ].join("\n");
  }

  // iOS XML path
  const cpuXml = path.join(debugDir, `native-profiler-${sessionId}_raw_cpu.xml`);
  const hangsXml = path.join(debugDir, `native-profiler-${sessionId}_raw_hangs.xml`);
  const leaksXml = path.join(debugDir, `native-profiler-${sessionId}_raw_leaks.xml`);

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
      `No native profiler XML files found for session "${sessionId}". ` +
        `Expected files matching native-profiler-${sessionId}_raw_*.xml in ${debugDir}`
    );
  }

  const { cpuSamples, uiHangs, cpuHotspots, memoryLeaks } = await runIosProfilerPipeline(files);

  api.parsedData = { cpuSamples, uiHangs, cpuHotspots, memoryLeaks };
  api.exportedFiles = files;

  const lines: string[] = [
    `Loaded native profiler session \`${sessionId}\`.`,
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
This is the disk-restore counterpart to react-profiler-stop/native-profiler-stop, which write data, and to the query tools (profiler-cpu-query, profiler-commit-query, profiler-stack-query), which read it.
Use when you need to revisit past session data without capturing a new recording.
Modes:
- list: Show all available profiling sessions in the project's debug directory.
- load_react: Load a React profiler session (CPU profile + commit tree) into memory. Requires session_id.
- load_native: Re-parse native profiler XML files into memory. Requires session_id and device_id.
  For Android .pftrace restores, pass app_process for older sessions that do not have a metadata sidecar.
Returns a summary of the loaded session or a session list for the list mode.
Fails if the session_id is not found or required XML files are missing from disk.`,
  zodSchema,
  // Loads Hermes-format React traces or iOS xctrace XML — neither maps onto
  // Chromium yet. The gate keeps the error close to the call site instead of
  // letting it surface from inside the trace parser.
  capability: RN_ONLY_TOOL_CAPABILITY,
  services: (params) => {
    const svcs: Record<string, ServiceRef> = {};
    if (params.mode === "load_native") {
      svcs.session = nativeProfilerSessionRef(resolveDevice(params.device_id));
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

      case "load_native": {
        if (!params.session_id) {
          throw new Error(
            "load_native mode requires the session_id parameter. Use list mode first."
          );
        }
        const api = services.session as NativeProfilerSessionApi;
        return loadNativeSession(debugDir, params.session_id, api, params.app_process);
      }

      default:
        throw new Error(`Unknown mode: ${params.mode}`);
    }
  },
};
