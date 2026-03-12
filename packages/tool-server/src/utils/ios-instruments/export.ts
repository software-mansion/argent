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

export function exportIosTraceData(
  traceFile: string,
): Record<string, string | null> {
  const exportedFiles: Record<string, string | null> = {};
  const dir = path.dirname(traceFile);
  const baseName = path.basename(traceFile, ".trace");

  for (const [key, config] of Object.entries(EXPORTS)) {
    const outPath = path.join(dir, `${baseName}${config.suffix}`);
    try {
      const cmd = `xctrace export --input "${traceFile}" --output "${outPath}" --xpath '${config.xpath}'`;
      execSync(cmd, { stdio: "pipe" });
      exportedFiles[key] = outPath;
    } catch {
      exportedFiles[key] = null;
    }
  }
  return exportedFiles;
}
