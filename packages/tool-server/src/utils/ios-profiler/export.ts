import * as path from "path";
import { execFileAsyncWithTimeout } from "./run-with-timeout";

/** Which of these a trace actually contains depends on its `.tracetemplate`. */
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

async function discoverTraceSchemas(
  traceFile: string,
  diagnostics?: ExportDiagnostics
): Promise<string[]> {
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
    return schemas;
  } catch (err) {
    // Recorded rather than swallowed: an empty schema list otherwise surfaces
    // downstream as a misleading "schema not found" message.
    if (diagnostics) {
      diagnostics.errors.toc = err instanceof Error ? err.message : String(err);
    }
    return [];
  }
}

async function resolveCpuXpath(
  traceFile: string,
  diagnostics: ExportDiagnostics
): Promise<string | null> {
  const tocSchemas = await discoverTraceSchemas(traceFile, diagnostics);
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

export async function exportIosTraceData(traceFile: string): Promise<{
  files: Record<string, string | null>;
  diagnostics: ExportDiagnostics;
}> {
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
      const resolvedXpath = await resolveCpuXpath(traceFile, diagnostics);

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
