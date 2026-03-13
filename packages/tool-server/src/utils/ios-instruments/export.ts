import { execSync } from "child_process";
import * as path from "path";

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
    xpath:
      '/trace-toc/run[@number="1"]/tracks/track[@name="Leaks"]/details/detail[@name="Leaks"]',
  },
};

/**
 * Detect xctrace version to determine supported export options.
 * xctrace 15+ supports --hal for human-accessible leaks.
 */
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

export function exportIosTraceData(
  traceFile: string,
): Record<string, string | null> {
  const exportedFiles: Record<string, string | null> = {};
  const dir = path.dirname(traceFile);
  const baseName = path.basename(traceFile, ".trace");

  for (const [key, config] of Object.entries(EXPORTS)) {
    const outPath = path.join(dir, `${baseName}${config.suffix}`);
    try {
      // xctrace XML export can truncate deep backtraces.
      // We request HAL (human-accessible leaks) format when available
      // to get fuller stacks. The --hal flag is available in Xcode 15+.
      let cmd: string;
      if (key === "leaks") {
        const xcVersion = getXctraceVersion();
        if (xcVersion >= 15) {
          cmd = `xctrace export --input "${traceFile}" --output "${outPath}" --xpath '${config.xpath}' --hal`;
        } else {
          cmd = `xctrace export --input "${traceFile}" --output "${outPath}" --xpath '${config.xpath}'`;
        }
      } else {
        cmd = `xctrace export --input "${traceFile}" --output "${outPath}" --xpath '${config.xpath}'`;
      }
      execSync(cmd, { stdio: "pipe" });
      exportedFiles[key] = outPath;
    } catch (err) {
      // If --hal fails, fall back to standard export
      if (key === "leaks") {
        try {
          const fallbackCmd = `xctrace export --input "${traceFile}" --output "${outPath}" --xpath '${config.xpath}'`;
          execSync(fallbackCmd, { stdio: "pipe" });
          exportedFiles[key] = outPath;
          continue;
        } catch {
          // fall through to null
        }
      }
      exportedFiles[key] = null;
    }
  }
  return exportedFiles;
}
