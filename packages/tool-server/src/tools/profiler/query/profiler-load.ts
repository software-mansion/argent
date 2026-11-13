import { z } from "zod";
import { promises as fs } from "fs";
import * as path from "path";
import {
  FAILURE_CODES,
  FailureError,
  type ServiceRef,
  type ToolDefinition,
} from "@argent/registry";
import {
  cacheProfilerPaths,
  type ProfilerSessionPaths,
} from "../../../blueprints/react-profiler-session";
import {
  nativeProfilerSessionRef,
  type NativeProfilerSessionApi,
} from "../../../blueprints/native-profiler-session";
import { resolveDevice } from "../../../utils/device-info";
import { REACT_PROFILER_TOOL_CAPABILITY } from "../../debugger/debugger-service-ref";
import { readCommitTree } from "../../../utils/react-profiler/debug/dump";
import { runIosProfilerPipeline } from "../../../utils/ios-profiler/pipeline/index";
import { leaksWereRecorded } from "../native-profiler/platforms/ios";
import { getDebugDir } from "../../../utils/react-profiler/debug/dump";
import { readAndroidNativeProfilerMetadata } from "../../../utils/android-profiler/session-metadata";
import { readXctraceSessionMetadata } from "../../../utils/ios-profiler/session-metadata";
import {
  nativeRecording,
  pairProfilerSessions,
  reactRecording,
  sameRunSessions,
  type NativeTrace,
} from "../../../utils/profiler-shared/session-pairs";
import { scanProfilerSessions } from "../../../utils/profiler-shared/session-ids";
import { markProfilerSessionUsed } from "../../../utils/profiler-shared/session-retention";
import {
  isCaptureInFlight,
  inFlightGuardMessage,
} from "../../../utils/profiler-shared/capture-guard";
import { metroPort, metroPortField } from "../../../utils/debugger/metro-port";
import { metroDeviceIdParam } from "../../../utils/debugger/device-id-param";
import {
  parseRenderSummary,
  formatRenderTime,
  type RenderSummary,
} from "../../../utils/react-profiler/render-summary";

// session_id is interpolated into on-disk file paths, so restrict it to a token
// that cannot traverse out of the debug dir.
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function assertSafeSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    // The zod schema already rejects this with the same regex, so a value reaching
    // here means a caller bypassed the schema: a programmer error, not a
    // user-reachable failure that should carry a telemetry code.
    throw new Error(
      `Invalid session_id "${sessionId}". Allowed: letters, digits, '_' and '-' ` +
        `(no path separators, no "..").`
    );
  }
}

async function listSessions(debugDir: string): Promise<string> {
  const sessions = await scanProfilerSessions(debugDir);
  if (!sessions) {
    return "_No debug directory found. Profile the app first to generate trace data._";
  }
  const { react: reactSessions, native: nativeSessions } = sessions;

  // Classify by artifact: a `.pftrace` (or its sidecar) is Android, an xctrace
  // `.trace` bundle or `_raw_*.xml` is iOS. iOS and Android captured in the same
  // second share one session id, so such a session is listed under BOTH headings
  // with its own files instead of one platform hiding the other. A lone
  // `-report.md` with no platform artifacts defaults to iOS.
  const iosSessions = new Map<string, string[]>();
  const androidSessions = new Map<string, string[]>();
  for (const [sid, files] of nativeSessions) {
    const androidFiles = files.filter(
      (f) => f.endsWith(".pftrace") || f.endsWith(".pftrace.metadata.json")
    );
    const iosFiles = files.filter((f) => f.endsWith(".trace") || f.includes("_raw_"));
    const sharedFiles = files.filter((f) => f.includes("-report.md"));
    if (androidFiles.length > 0) androidSessions.set(sid, [...androidFiles, ...sharedFiles]);
    if (iosFiles.length > 0) iosSessions.set(sid, [...iosFiles, ...sharedFiles]);
    if (androidFiles.length === 0 && iosFiles.length === 0) iosSessions.set(sid, files);
  }

  if (reactSessions.size === 0 && nativeSessions.size === 0) {
    return "_No profiling sessions found in the debug directory._";
  }

  // One read of each commits file: the table's columns and the recording's times.
  const reactMeta = new Map<string, Awaited<ReturnType<typeof readCommitTree>>["meta"]>();
  for (const [sid, files] of reactSessions) {
    const commitsFile = files.find((f) => f.includes("_commits.json"));
    if (!commitsFile) continue;
    try {
      reactMeta.set(sid, (await readCommitTree(path.join(debugDir, commitsFile))).meta);
    } catch {
      // older or corrupted file: leave the "—" placeholders
    }
  }
  const reactRuns = new Map(
    [...reactSessions.keys()].map((sid) => [sid, reactRecording(sid, reactMeta.get(sid))])
  );
  // An id can hold an xctrace and an Android session: each pairs on its own device.
  const pairsOf = async (trace: NativeTrace) =>
    pairProfilerSessions(
      reactRuns,
      new Map(
        await Promise.all(
          [...nativeSessions.keys()].map(
            async (sid) => [sid, await nativeRecording(debugDir, sid, trace)] as const
          )
        )
      )
    );
  const iosPairs = await pairsOf("xctrace");
  const androidPairs = await pairsOf("android");
  // The iOS and the Android session of one id are on two devices: a React session
  // pairs with one of them at most.
  const nativeOfReact = (sid: string) => [
    ...(iosPairs.reactToNative.get(sid) ?? []),
    ...(androidPairs.reactToNative.get(sid) ?? []),
  ];
  const sameRunCell = (ids: string[] | undefined) =>
    ids && ids.length > 0 ? ids.map((id) => `\`${id}\``).join(", ") : "—";

  const lines: string[] = ["## Available Profiling Sessions", ""];

  if (reactSessions.size > 0) {
    lines.push("### React Profiler Sessions", "");
    lines.push("| Session ID | Runtime | Device | Metro bundle | Native session (same run) |");
    lines.push("|---|---|---|---|---|");
    for (const sid of [...reactSessions.keys()].sort().reverse()) {
      const meta = reactMeta.get(sid);
      const project = meta?.projectRoot ? path.basename(meta.projectRoot) : null;
      lines.push(
        `| \`${sid}\` | ${meta?.appName ?? "—"} | ${meta?.deviceName ?? "—"} | ${project ?? "—"} | ` +
          `${sameRunCell(nativeOfReact(sid))} |`
      );
    }
    lines.push("");
  }

  if (iosSessions.size > 0) {
    lines.push("### Native Profiler Sessions (iOS)", "");
    lines.push("| Session ID | Files | React session (same run) |");
    lines.push("|---|---|---|");
    for (const [sid, files] of [...iosSessions.entries()].sort().reverse()) {
      const hasCpu = files.some((f) => f.includes("_raw_cpu.xml"));
      const hasHangs = files.some((f) => f.includes("_raw_hangs.xml"));
      const hasLeaks = files.some((f) => f.includes("_raw_leaks.xml"));
      const hasReport = files.some((f) => f.includes("-report.md"));
      const parts: string[] = [];
      if (hasCpu) parts.push("CPU");
      if (hasHangs) parts.push("hangs");
      if (hasLeaks) parts.push("leaks");
      if (hasReport) parts.push("report");
      lines.push(
        `| \`${sid}\` | ${parts.join(", ")} | ${sameRunCell(iosPairs.nativeToReact.get(sid))} |`
      );
    }
    lines.push("");
  }

  if (androidSessions.size > 0) {
    lines.push("### Native Profiler Sessions (Android)", "");
    lines.push("| Session ID | Files | React session (same run) |");
    lines.push("|---|---|---|");
    for (const [sid, files] of [...androidSessions.entries()].sort().reverse()) {
      const parts: string[] = [];
      if (files.some((f) => f.endsWith(".pftrace"))) parts.push("pftrace");
      if (files.some((f) => f.includes("-report.md"))) parts.push("report");
      lines.push(
        `| \`${sid}\` | ${parts.join(", ")} | ${sameRunCell(androidPairs.nativeToReact.get(sid))} |`
      );
    }
    lines.push("");
  }

  lines.push(
    "_Use `load_react` or `load_native` with the session_id to load data for query tools. " +
      "Either mode also takes the id of the run's other session._"
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
    throw new FailureError(
      `No data found for React session "${sessionId}". ` +
        `Expected files at:\n  ${cpuPath}\n  ${commitsPath}`,
      {
        error_code: FAILURE_CODES.PROFILER_DATA_NOT_LOADED,
        failure_stage: "profiler_load_react_session",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }

  // So the cleanup of old sessions keeps it while it is in use.
  await markProfilerSessionUsed([cpuPath, commitsPath, cpuIndexPath]);

  let detectedArchitecture: "bridge" | "bridgeless" | null = null;
  let anyCompilerOptimized: boolean | null = null;
  let hotCommitIndices: number[] | null = null;
  let totalReactCommits: number | null = null;
  let appName: string | null = null;
  let deviceName: string | null = null;
  let projectRoot: string | null = null;
  let commitCount = 0;
  let renderSummary: RenderSummary | null = null;
  let sampleInfo = "not available";

  if (hasCommits) {
    try {
      const onDisk = await readCommitTree(commitsPath);
      // The file holds one entry per fiber, not per commit.
      commitCount = new Set(onDisk.commits.map((c) => c.commitIndex)).size;
      if (onDisk.meta) {
        detectedArchitecture = onDisk.meta.detectedArchitecture ?? null;
        anyCompilerOptimized = onDisk.meta.anyCompilerOptimized ?? null;
        hotCommitIndices = onDisk.meta.hotCommitIndices ?? null;
        totalReactCommits = onDisk.meta.totalReactCommits ?? null;
        appName = onDisk.meta.appName ?? null;
        deviceName = onDisk.meta.deviceName ?? null;
        projectRoot = onDisk.meta.projectRoot ?? null;
        renderSummary = parseRenderSummary(onDisk.meta.renderSummary);
      }
    } catch {
      // non-fatal — file may be corrupted
    }
  }

  if (hasCpu) {
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
    loadedFromDisk: true,
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
    // Older sessions lack the summary; say so here, before render_counts does.
    renderSummary
      ? `- React render time (all commits): ${formatRenderTime(renderSummary)}`
      : `- Render counts over all commits: not available for this session`,
    `- Architecture: ${detectedArchitecture ?? "unknown"}`,
    "",
    "Query tools (`profiler-cpu-query`, `profiler-commit-query`) are now ready to use against this data.",
  ];

  return lines.join("\n");
}

/**
 * Loading overwrites the session's capture state (traceFile, exportedFiles,
 * parsedData, …), which strands a live or unrecovered capture: stop's export
 * needs traceFile, and only the raw_*.xml that export writes can be loaded back
 * (the .trace bundle cannot). A load checks before it reads and again before it
 * writes: a native-profiler-start can begin while it reads.
 */
function assertNoCaptureInFlight(api: NativeProfilerSessionApi): void {
  if (isCaptureInFlight(api)) {
    throw new FailureError(inFlightGuardMessage(api, "retry profiler-load"), {
      error_code: FAILURE_CODES.NATIVE_PROFILER_SESSION_ALREADY_RUNNING,
      failure_stage: "profiler_load_native_session",
      failure_area: "tool_server",
      error_kind: "validation",
    });
  }
}

async function loadNativeSession(
  debugDir: string,
  sessionId: string,
  api: NativeProfilerSessionApi,
  appProcessOverride: string | undefined,
  reactSessionId: string | null
): Promise<string> {
  assertSafeSessionId(sessionId);
  // When the load took the run's native session for a React id, a failure names both.
  const ofRun = reactSessionId
    ? `, the native session of the run of React session "${reactSessionId}"`
    : "";
  assertNoCaptureInFlight(api);
  if (api.platform === "android") {
    const pftrace = path.join(debugDir, `native-profiler-${sessionId}.pftrace`);
    try {
      await fs.access(pftrace);
    } catch {
      throw new FailureError(
        `No native profiler .pftrace found for session "${sessionId}"${ofRun}. ` +
          `Expected file at ${pftrace}`,
        {
          error_code: FAILURE_CODES.PROFILER_NATIVE_TRACE_MISSING,
          failure_stage: "profiler_load_android_pftrace",
          failure_area: "tool_server",
          error_kind: "not_found",
        }
      );
    }
    const metadata = await readAndroidNativeProfilerMetadata(pftrace);
    const appProcess = metadata?.appProcess ?? appProcessOverride?.trim();
    if (!appProcess) {
      throw new FailureError(
        `Android profiler session "${sessionId}" is missing its metadata sidecar. ` +
          "Retry profiler-load with app_process set to the Android package name used for the recording.",
        {
          error_code: FAILURE_CODES.PROFILER_NATIVE_METADATA_MISSING,
          failure_stage: "profiler_load_android_metadata",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }
    await markProfilerSessionUsed([pftrace]);
    assertNoCaptureInFlight(api);
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
    throw new FailureError(
      `No native profiler XML files found for session "${sessionId}"${ofRun}. ` +
        `Expected files matching native-profiler-${sessionId}_raw_*.xml in ${debugDir}`,
      {
        error_code: FAILURE_CODES.PROFILER_NATIVE_TRACE_MISSING,
        failure_stage: "profiler_load_native_session",
        failure_area: "tool_server",
        // A trace missing on disk is not_found; validation stays for the
        // analyze-before-stop guard (NATIVE_PROFILER_NO_EXPORTED_TRACE).
        error_kind: "not_found",
      }
    );
  }

  await markProfilerSessionUsed([cpuXml, hangsXml, leaksXml]);
  const traceFile = path.join(debugDir, `native-profiler-${sessionId}.trace`);
  // The raw_*.xml carry none of the capture's own fields. The stop saved them next
  // to the trace; a session saved before that has none, and its fields stay empty.
  const metadata = await readXctraceSessionMetadata(traceFile);
  const cpuFilterPid = metadata?.cpuFilterPid ?? null;
  const appSuspensions = metadata?.appSuspensions ?? null;
  const mallocStackLogging = metadata?.mallocStackLogging ?? null;
  const wallClockStartMs = metadata?.wallClockStartMs ?? null;
  const { cpuSamples, uiHangs, cpuHotspots, memoryLeaks } = await runIosProfilerPipeline(files, {
    cpuFilterPid,
    appSuspensions,
  });
  // The rule of the live analyze, so a load reports the leaks as it did.
  const leaksRecorded = await leaksWereRecorded(api.platform, files.leaks, memoryLeaks);

  assertNoCaptureInFlight(api);
  // Without a saved start time the frozen anchor is null, and the combined report
  // reports a missing native anchor rather than mis-anchoring to residue.
  api.parsedData = {
    cpuSamples,
    uiHangs,
    cpuHotspots,
    memoryLeaks,
    leaksRecorded,
    mallocStackLogging,
    wallClockStartMs,
  };
  api.exportedFiles = files;
  // Replace every per-capture field an earlier live capture left behind, or analyze
  // attributes them to the loaded trace: mislabeled capture mode, samples dropped
  // by a stale CPU filter PID, and a stale-trace note. The trace is this session's
  // own, so the report names it. Without the saved start time, analyze writes no
  // report .md: it would replace the live report with one that lacks those fields.
  api.mallocStackLogging = mallocStackLogging;
  api.cpuFilterPid = cpuFilterPid;
  api.appEndedDuringCapture = metadata?.appEndedDuringCapture ?? false;
  api.exportSkipReason = null;
  api.recordedMs = metadata?.recordedMs ?? null;
  api.appSuspensions = appSuspensions;
  api.wallClockStartMs = wallClockStartMs;
  api.traceFile = traceFile;

  const lines: string[] = [
    `Loaded native profiler session \`${sessionId}\`.`,
    "",
    `- CPU samples: ${cpuSamples.length}`,
    `- UI hangs: ${uiHangs.length}`,
    `- CPU hotspots: ${cpuHotspots.length}`,
    `- Memory leaks: ${leaksRecorded ? memoryLeaks.length : "not recorded"}`,
    "",
    "Query tools (`profiler-stack-query`) are now ready to use against this data.",
  ];

  return lines.join("\n");
}

/**
 * The session of `kind` that `sessionId` names: that session, or else the one
 * session of `kind` of the same run as the other kind's session with this id.
 * `note` says when it is the second. Refuses when the run has more than one.
 */
async function sessionToLoad(
  debugDir: string,
  kind: "react" | "native",
  sessionId: string,
  deviceId: string,
  trace?: NativeTrace
): Promise<{ sessionId: string; note: string }> {
  const { partners, ownElsewhere } = await sameRunSessions(
    debugDir,
    kind,
    sessionId,
    deviceId,
    trace
  );
  const [own, other] = kind === "react" ? ["React", "native"] : ["native", "React"];
  // The same word at the start of a sentence.
  const Own = own[0]!.toUpperCase() + own.slice(1);
  if (partners.length > 1) {
    const devices = new Set(partners.map((p) => p.deviceId));
    const which =
      devices.size > 1
        ? `${partners.length} ${own} sessions recorded at the same time as a ${other} session ` +
          `"${sessionId}": ${partners.map((p) => `\`${p.id}\` on ${p.deviceId}`).join(", ")}.`
        : `On ${ownElsewhere ? "this" : "its"} device, ${partners.length} ${own} sessions ` +
          `recorded at the same time as ${other} session "${sessionId}": ` +
          `${partners.map((p) => `\`${p.id}\``).join(", ")}.`;
    const first = ownElsewhere
      ? `${Own} session "${sessionId}" recorded on another device.`
      : `No ${own} session has the id "${sessionId}".`;
    throw new FailureError(`${first} ${which} Pass one of them as session_id.`, {
      error_code: FAILURE_CODES.PROFILER_DATA_NOT_LOADED,
      failure_stage: `profiler_load_${kind}_session`,
      failure_area: "tool_server",
      error_kind: "validation",
    });
  }
  const [partner] = partners;
  if (!partner) return { sessionId, note: "" };
  return {
    sessionId: partner.id,
    note: ownElsewhere
      ? `${Own} session \`${sessionId}\` recorded on another device, so it was not loaded. This ` +
        `is the ${own} session of the run of ${other} session \`${sessionId}\` on this device.\n\n`
      : `\`${sessionId}\` is a ${other} session; this is the ${own} session of its run.\n\n`,
  };
}

/** The session id that a load result names, or else the one that was asked for. */
function loadedSessionId(params: Params, result: string): string {
  return (
    /^Loaded (?:React|native|Android) profiler session `([^`]+)`/m.exec(result)?.[1] ??
    params.session_id!
  );
}

const profilerLoadAction = {
  list: {
    started: () => "Listing saved profiles",
    completed: () => "Listed saved profiles",
    failure: "list",
  },
  load_react: {
    started: (params: Params) => `Loading React profile ${params.session_id}`,
    completed: (params: Params, result: string) =>
      `Loaded React profile ${loadedSessionId(params, result)}`,
    failure: "load",
  },
  load_native: {
    started: (params: Params) => `Loading native profile ${params.session_id}`,
    completed: (params: Params, result: string) =>
      `Loaded native profile ${loadedSessionId(params, result)}`,
    failure: "load",
  },
} satisfies Record<
  Params["mode"],
  {
    started: (params: Params) => string;
    completed: (params: Params, result: string) => string;
    failure: string;
  }
>;

const zodSchema = z.object({
  mode: z
    .enum(["list", "load_react", "load_native"])
    .describe("What to do; see Modes in the tool description."),
  session_id: z
    .string()
    .regex(SESSION_ID_PATTERN, "session_id may only contain letters, digits, '_' and '-'")
    .optional()
    .describe("Timestamp-based session identifier (e.g. '20250313-143022') from the list output."),
  port: metroPortField,
  device_id: metroDeviceIdParam(
    "Target device id from `list-devices`. Used to cache the loaded React session under the correct port+device key, and required to resolve the native profiler session for load_native."
  ),
  app_process: z
    .string()
    .optional()
    .describe(
      "Android package name to pass when restoring an older load_native .pftrace session that has no metadata sidecar."
    ),
});

type Params = z.infer<typeof zodSchema>;

export const profilerLoadTool: ToolDefinition<Params, string> = {
  id: "profiler-load",
  description: `Fetch and restore a profiling session that react-profiler-stop or native-profiler-stop saved to disk, so the query tools (profiler-cpu-query, profiler-commit-query, profiler-stack-query) can read it.
Use when you need to revisit past session data without capturing a new recording.
Modes:
- list: Show all available profiling sessions in the project's debug directory.
- load_react: Load a React profiler session (CPU profile + commit tree) into memory. Requires session_id.
- load_native: Load a native profiler session (xctrace XML on iOS<flag:macos-apps> and Mac apps</flag:macos-apps>, .pftrace on Android). Requires session_id.
Loading replaces the session in memory for this device_id (and Metro port, for React): the one the query tools and react-profiler-analyze read. The replaced session stays on disk; load it again by its session_id.
Returns a summary of the loaded session or a session list for the list mode.
Fails if the session_id is not found or the session's trace files are missing from disk.`,
  zodSchema,
  interaction: {
    startedMsg: ({ params }) => profilerLoadAction[params.mode].started(params),
    completedMsg: ({ params, result }) => profilerLoadAction[params.mode].completed(params, result),
    failedMsg: ({ params, failureSignal }) =>
      `Failed to ${profilerLoadAction[params.mode].failure} saved profiles: ${failureSignal.error_code}`,
  },
  // The Hermes, xctrace and perfetto formats this loads have no Chromium
  // equivalent; the gate fails at the call site, not inside the trace parser.
  capability: REACT_PROFILER_TOOL_CAPABILITY,
  // load_native re-parses the whole export, which can outlast the 30s MCP fetch
  // timeout; an aborted call is replayed, not cancelled.
  longRunning: true,
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
          throw new FailureError(
            "load_react mode requires the session_id parameter. Use list mode first.",
            {
              error_code: FAILURE_CODES.PROFILER_QUERY_REQUIRED_PARAM_MISSING,
              failure_stage: "profiler_load_params",
              failure_area: "tool_server",
              error_kind: "validation",
            }
          );
        }
        const react = await sessionToLoad(debugDir, "react", params.session_id, params.device_id);
        return (
          react.note +
          (await loadReactSession(debugDir, react.sessionId, metroPort(params), params.device_id))
        );
      }

      case "load_native": {
        if (!params.session_id) {
          throw new FailureError(
            "load_native mode requires the session_id parameter. Use list mode first.",
            {
              error_code: FAILURE_CODES.PROFILER_QUERY_REQUIRED_PARAM_MISSING,
              failure_stage: "profiler_load_params",
              failure_area: "tool_server",
              error_kind: "validation",
            }
          );
        }
        const api = services.session as NativeProfilerSessionApi;
        const native = await sessionToLoad(
          debugDir,
          "native",
          params.session_id,
          params.device_id,
          api.platform === "android" ? "android" : "xctrace"
        );
        const pairedFrom = native.sessionId === params.session_id ? null : params.session_id;
        return (
          native.note +
          (await loadNativeSession(debugDir, native.sessionId, api, params.app_process, pairedFrom))
        );
      }

      default:
        throw new FailureError(`Unknown mode: ${params.mode}`, {
          error_code: FAILURE_CODES.PROFILER_QUERY_MODE_INVALID,
          failure_stage: "profiler_load_mode",
          failure_area: "tool_server",
          error_kind: "validation",
        });
    }
  },
};
