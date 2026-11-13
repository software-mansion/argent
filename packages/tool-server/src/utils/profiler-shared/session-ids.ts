import { promises as fs } from "fs";

/** A file of a saved session: `native-profiler-<id>...` or `react-profiler-<id>_...`. */
const SESSION_ENTRY = /^(native|react)-profiler-(\d{8}-?\d{6})(?=[._-])/;

/** The files of each saved session in the profiler folder, by id. Null when there is no folder. */
export async function scanProfilerSessions(
  dir: string
): Promise<{ react: Map<string, string[]>; native: Map<string, string[]> } | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }
  const react = new Map<string, string[]>();
  const native = new Map<string, string[]>();
  for (const entry of entries) {
    const m = SESSION_ENTRY.exec(entry);
    if (!m) continue;
    const byId = m[1] === "react" ? react : native;
    byId.set(m[2]!, [...(byId.get(m[2]!) ?? []), entry]);
  }
  return { react, native };
}
