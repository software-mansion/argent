import { execSync } from "child_process";
import * as path from "path";

/**
 * Known xctrace schema names that contain CPU time-profile data.
 * The actual name depends on the .tracetemplate — Time Profiler uses "time-profile",
 * CPU Profiler uses "cpu-profile", and some custom templates use "time-sample".
 */
const CPU_SCHEMA_CANDIDATES = ["time-profile", "cpu-profile", "time-sample"];

export const EXPORTS: Record<string, { suffix: string; xpath: string }> = {
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
};

export interface ExportDiagnostics {
  tocSchemas: string[];
  cpuSchemaUsed: string | null;
  errors: Record<string, string>;
}

function getXctraceVersion(): number {
  try {
    const output = execSync("xctrace version 2>&1 || true", {
      encoding: "utf-8",
    });
    const match = output.match(/(\d+)\./);
    return match ? parseInt(match[1]!, 10) : 0;
  } catch {
    return 0;
  }
}

/**
 * Run `xctrace export --toc` to discover what tables/schemas exist in the trace.
 * Returns an array of schema names found in the TOC.
 */
function discoverTraceSchemas(traceFile: string): string[] {
  try {
    const toc = execSync(
      `xctrace export --input "${traceFile}" --toc`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const schemas: string[] = [];
    const schemaRe = /schema="([^"]+)"/g;
    let m;
    while ((m = schemaRe.exec(toc)) !== null) {
      schemas.push(m[1]);
    }
    return schemas;
  } catch {
    return [];
  }
}

/**
 * Find the correct CPU schema xpath by checking the trace TOC.
 * Falls back to trying known schema candidates if TOC parsing fails.
 */
function resolveCpuXpath(
  traceFile: string,
  diagnostics: ExportDiagnostics,
): string | null {
  const tocSchemas = discoverTraceSchemas(traceFile);
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

/**
 * Try exporting CPU data with each known schema name until one succeeds.
 * Used as a fallback when TOC discovery doesn't find a match or fails.
 */
function tryCpuExportFallback(
  traceFile: string,
  outPath: string,
  diagnostics: ExportDiagnostics,
): boolean {
  const triedSchemas: string[] = [];
  for (const candidate of CPU_SCHEMA_CANDIDATES) {
    const xpath = `/trace-toc/run[@number="1"]/data/table[@schema="${candidate}"]`;
    try {
      execSync(
        `xctrace export --input "${traceFile}" --output "${outPath}" --xpath '${xpath}'`,
        { stdio: "pipe" },
      );
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

export function exportIosTraceData(
  traceFile: string,
): { files: Record<string, string | null>; diagnostics: ExportDiagnostics } {
  const exportedFiles: Record<string, string | null> = {};
  const diagnostics: ExportDiagnostics = {
    tocSchemas: [],
    cpuSchemaUsed: null,
    errors: {},
  };
  const dir = path.dirname(traceFile);
  const baseName = path.basename(traceFile, ".trace");

  for (const [key, config] of Object.entries(EXPORTS)) {
    const outPath = path.join(dir, `${baseName}${config.suffix}`);

    if (key === "cpu") {
      // Dynamic CPU schema resolution
      const resolvedXpath = resolveCpuXpath(traceFile, diagnostics);

      if (resolvedXpath) {
        try {
          execSync(
            `xctrace export --input "${traceFile}" --output "${outPath}" --xpath '${resolvedXpath}'`,
            { stdio: "pipe" },
          );
          exportedFiles[key] = outPath;
          continue;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          diagnostics.errors.cpu =
            `TOC-resolved xpath failed (schema="${diagnostics.cpuSchemaUsed}"): ${msg}`;
          diagnostics.cpuSchemaUsed = null;
        }
      }

      // Fallback: brute-force try all known CPU schemas
      if (tryCpuExportFallback(traceFile, outPath, diagnostics)) {
        exportedFiles[key] = outPath;
      } else {
        exportedFiles[key] = null;
      }
      continue;
    }

    if (key === "leaks") {
      const xcVersion = getXctraceVersion();
      const halFlag = xcVersion >= 15 ? " --hal" : "";
      try {
        execSync(
          `xctrace export --input "${traceFile}" --output "${outPath}" --xpath '${config.xpath}'${halFlag}`,
          { stdio: "pipe" },
        );
        exportedFiles[key] = outPath;
      } catch {
        if (halFlag) {
          try {
            execSync(
              `xctrace export --input "${traceFile}" --output "${outPath}" --xpath '${config.xpath}'`,
              { stdio: "pipe" },
            );
            exportedFiles[key] = outPath;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            diagnostics.errors[key] = msg;
            exportedFiles[key] = null;
          }
        } else {
          exportedFiles[key] = null;
        }
      }
      continue;
    }

    // Default export (hangs, etc.)
    try {
      execSync(
        `xctrace export --input "${traceFile}" --output "${outPath}" --xpath '${config.xpath}'`,
        { stdio: "pipe" },
      );
      exportedFiles[key] = outPath;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      diagnostics.errors[key] = msg;
      exportedFiles[key] = null;
    }
  }

  return { files: exportedFiles, diagnostics };
}
