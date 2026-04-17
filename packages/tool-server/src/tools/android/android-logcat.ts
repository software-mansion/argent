import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { adbShell, runAdb } from "../../utils/adb";
import { detectPlatform } from "../../utils/platform-detect";

const zodSchema = z.object({
  udid: z.string().describe("Android adb serial (e.g. `emulator-5554`)."),
  bundleId: z
    .string()
    .optional()
    .describe(
      "If provided, only include log lines emitted by this package's process. Resolved via `pidof <pkg>` first."
    ),
  priority: z
    .enum(["V", "D", "I", "W", "E", "F"])
    .optional()
    .describe("Minimum log priority. V=verbose D=debug I=info W=warn E=error F=fatal. Default: I."),
  lines: z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .optional()
    .describe("Max number of most-recent lines to return (default 500)."),
  tag: z.string().optional().describe("Filter to a single logcat tag."),
});

export const androidLogcatTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { lines: string[]; count: number }
> = {
  id: "android-logcat",
  description:
    "Read recent logcat output from the device. Uses `adb logcat -d` (dump) so it returns immediately without streaming. " +
    "Filters by package (via PID), priority, and optional tag. Returns { lines, count }. " +
    "Use for crash traces, React Native red-box details, or general runtime diagnostics.",
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    if (detectPlatform(params.udid) !== "android") {
      throw new Error("android-logcat is Android-only.");
    }
    let pid: string | null = null;
    if (params.bundleId) {
      // `pidof <package>` returns one or more whitespace-separated PIDs (the app may
      // have child processes). Pass the first; if empty, the app isn't running.
      const raw = (
        await adbShell(params.udid, `pidof ${params.bundleId}`, {
          timeoutMs: 5_000,
        }).catch(() => "")
      ).trim();
      pid = raw.split(/\s+/)[0] ?? null;
      if (!pid) {
        return { lines: [], count: 0 };
      }
    }

    const args = ["-s", params.udid, "logcat", "-d", "-v", "threadtime"];
    if (pid) args.push("--pid", pid);
    if (params.tag) {
      // Filter to one tag at the requested priority, silence the rest.
      args.push(`${params.tag}:${params.priority ?? "V"}`, "*:S");
    } else if (params.priority) {
      args.push(`*:${params.priority}`);
    }

    const { stdout } = await runAdb(args, { timeoutMs: 20_000 });
    const all = stdout.split("\n").filter((l) => l.length > 0);
    const maxLines = params.lines ?? 500;
    const tail = all.slice(-maxLines);
    return { lines: tail, count: tail.length };
  },
};
