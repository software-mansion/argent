import * as path from "path";
import { DEFAULT_EXEC_TIMEOUT_MS, execFileAsyncWithTimeout } from "./run-with-timeout";

/** Which of these a trace actually contains depends on its `.tracetemplate`. */
const CPU_SCHEMA_CANDIDATES = ["time-profile", "cpu-profile", "time-sample"];

const EXPORTS = {
  cpu: {
    suffix: "_raw_cpu.xml",
    xpath: '/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]',
  },
  hangs: {
    suffix: "_raw_hangs.xml",
    xpath: '/trace-toc/run[@number="1"]/data/table[@schema="potential-hangs"]',
  },
  leaks: {
    suffix: "_raw_leaks.xml",
    xpath: '/trace-toc/run[@number="1"]/tracks/track[@name="Leaks"]/details/detail[@name="Leaks"]',
  },
} satisfies Record<string, { suffix: string; xpath: string }>;

/**
 * The fixed set of per-schema exports an iOS stop produces. Result types are
 * keyed by this union (not `string`) so a consumer that must classify every
 * export — e.g. artifact-kind tagging in native-profiler-stop — is forced by
 * the compiler to handle a key added here.
 */
export type IosExportKey = keyof typeof EXPORTS;

export interface ExportDiagnostics {
  tocSchemas: string[];
  cpuSchemaUsed: string | null;
  errors: Record<string, string>;
  /** Why the stop exported no table, when it skipped them all. */
  skipped?: string;
  /** The trace's `<start-date>` in ms since 1970: trace time 0 on the wall clock. */
  traceStartMs?: number;
  /** The trace's `<duration>` in ms. */
  traceDurationMs?: number;
}

/** execFile killed the command when its timeout ran out. */
function timedOut(err: unknown): boolean {
  return (err as { killed?: boolean } | null)?.killed === true;
}

async function discoverTraceSchemas(
  traceFile: string,
  diagnostics?: ExportDiagnostics
): Promise<string[] | "timed-out"> {
  try {
    const { stdout: toc } = await execFileAsyncWithTimeout("xctrace", [
      "export",
      "--input",
      traceFile,
      "--toc",
    ]);
    const schemas: string[] = [];
    const schemaRe = /schema="([^"]+)"/g;
    let m;
    while ((m = schemaRe.exec(toc)) !== null) {
      schemas.push(m[1]);
    }
    const startMs = Date.parse(/<start-date>([^<]+)<\/start-date>/.exec(toc)?.[1] ?? "");
    if (diagnostics && Number.isFinite(startMs)) diagnostics.traceStartMs = startMs;
    const durationS = Number(/<duration>([^<]+)<\/duration>/.exec(toc)?.[1]);
    if (diagnostics && durationS > 0) diagnostics.traceDurationMs = durationS * 1000;
    return schemas;
  } catch (err) {
    // Recorded rather than swallowed: an empty schema list otherwise surfaces
    // downstream as a misleading "schema not found" message.
    if (diagnostics) {
      diagnostics.errors.toc = err instanceof Error ? err.message : String(err);
    }
    return timedOut(err) ? "timed-out" : [];
  }
}

async function resolveCpuXpath(
  traceFile: string,
  diagnostics: ExportDiagnostics,
  appEnded: boolean
): Promise<string | null | "toc-timed-out"> {
  const discovered = await discoverTraceSchemas(traceFile, diagnostics);
  if (discovered === "timed-out" && appEnded) return "toc-timed-out";
  // Otherwise a slow table of contents is no sign of slow tables: go on without it.
  const tocSchemas = discovered === "timed-out" ? [] : discovered;
  diagnostics.tocSchemas = tocSchemas;

  if (tocSchemas.length > 0) {
    for (const candidate of CPU_SCHEMA_CANDIDATES) {
      if (tocSchemas.includes(candidate)) {
        diagnostics.cpuSchemaUsed = candidate;
        return `/trace-toc/run[@number="1"]/data/table[@schema="${candidate}"]`;
      }
    }
    diagnostics.errors.cpu =
      `No CPU schema found in trace TOC. Available schemas: [${tocSchemas.join(", ")}]. ` +
      `Expected one of: [${CPU_SCHEMA_CANDIDATES.join(", ")}].`;
    return null;
  }

  return null;
}

async function tryCpuExportFallback(
  traceFile: string,
  outPath: string,
  diagnostics: ExportDiagnostics
): Promise<boolean> {
  const triedSchemas: string[] = [];
  for (const candidate of CPU_SCHEMA_CANDIDATES) {
    const xpath = `/trace-toc/run[@number="1"]/data/table[@schema="${candidate}"]`;
    try {
      await execFileAsyncWithTimeout("xctrace", [
        "export",
        "--input",
        traceFile,
        "--output",
        outPath,
        "--xpath",
        xpath,
      ]);
      diagnostics.cpuSchemaUsed = candidate;
      return true;
    } catch {
      triedSchemas.push(candidate);
    }
  }
  diagnostics.errors.cpu =
    (diagnostics.errors.cpu ? diagnostics.errors.cpu + " " : "") +
    `Brute-force export also failed for schemas: [${triedSchemas.join(", ")}].`;
  return false;
}

function skipAll(diagnostics: ExportDiagnostics, reason: string): void {
  diagnostics.skipped = reason;
  for (const key of Object.keys(EXPORTS) as IosExportKey[]) {
    diagnostics.errors[key] = `Not exported: ${reason}`;
  }
}

/** The result of a stop that exports no table, with `reason` for each one. */
export function skippedTraceExport(reason: string): {
  files: Record<IosExportKey, string | null>;
  diagnostics: ExportDiagnostics;
} {
  const diagnostics: ExportDiagnostics = { tocSchemas: [], cpuSchemaUsed: null, errors: {} };
  skipAll(diagnostics, reason);
  return { files: { cpu: null, hangs: null, leaks: null }, diagnostics };
}

/**
 * `appEnded`: the Mac app ended during the recording, so the trace can hold next
 * to no data. Then a table of contents that runs out of time ends the export.
 */
export async function exportIosTraceData(
  traceFile: string,
  appEnded = false
): Promise<{
  files: Record<IosExportKey, string | null>;
  diagnostics: ExportDiagnostics;
}> {
  const exportedFiles: Record<IosExportKey, string | null> = {
    cpu: null,
    hangs: null,
    leaks: null,
  };
  const diagnostics: ExportDiagnostics = {
    tocSchemas: [],
    cpuSchemaUsed: null,
    errors: {},
  };
  const dir = path.dirname(traceFile);
  const baseName = path.basename(traceFile, ".trace");

  for (const key of Object.keys(EXPORTS) as IosExportKey[]) {
    const config = EXPORTS[key];
    const outPath = path.join(dir, `${baseName}${config.suffix}`);

    if (key === "cpu") {
      const resolvedXpath = await resolveCpuXpath(traceFile, diagnostics, appEnded);
      if (resolvedXpath === "toc-timed-out") {
        // Listing the tables is the lightest export. A trace that holds next to
        // no data (the app crashed or quit early) takes minutes for each one, so
        // the CPU fallbacks, hangs and leaks would wait 60 s each for nothing.
        skipAll(
          diagnostics,
          `xctrace could not list the trace's tables within ${DEFAULT_EXEC_TIMEOUT_MS / 1000} s, ` +
            `for example because the trace holds next to no data.`
        );
        return { files: exportedFiles, diagnostics };
      }

      if (resolvedXpath) {
        try {
          await execFileAsyncWithTimeout("xctrace", [
            "export",
            "--input",
            traceFile,
            "--output",
            outPath,
            "--xpath",
            resolvedXpath,
          ]);
          exportedFiles[key] = outPath;
          continue;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          diagnostics.errors.cpu = `TOC-resolved xpath failed (schema="${diagnostics.cpuSchemaUsed}"): ${msg}`;
          diagnostics.cpuSchemaUsed = null;
        }
      }

      if (await tryCpuExportFallback(traceFile, outPath, diagnostics)) {
        exportedFiles[key] = outPath;
      } else {
        exportedFiles[key] = null;
      }
      continue;
    }

    try {
      await execFileAsyncWithTimeout("xctrace", [
        "export",
        "--input",
        traceFile,
        "--output",
        outPath,
        "--xpath",
        config.xpath,
      ]);
      exportedFiles[key] = outPath;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      diagnostics.errors[key] = msg;
      exportedFiles[key] = null;
    }
  }

  return { files: exportedFiles, diagnostics };
}
