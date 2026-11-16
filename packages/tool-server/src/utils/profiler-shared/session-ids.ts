import { promises as fs } from "fs";

/** A file of a saved session: `native-profiler-<id>...` or `react-profiler-<id>_...`. */
const SESSION_ENTRY = /^(native|react)-profiler-(\d{8}-?\d{6})(?=[._-])/;

/** The UTC time that a session id names, to the second: its start or its stop time. */
export function sessionIdMs(id: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})-?(\d{2})(\d{2})(\d{2})$/.exec(id);
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : null;
}

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
