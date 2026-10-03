/**
 * Mechanical helpers over App Launch template exports. They flatten and cut the
 * data; ranking and interpretation are left to the agent and the profiler query tools.
 */

interface LifecyclePhase {
  startNs: number;
  durationNs: number;
  period: string;
}

const FIRST_FRAME_PERIOD = "Launching - Initial Frame Rendering";
const FOREGROUND_ACTIVE_PERIOD = "Foreground - Active";

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Resolves the first `<tag>` in a row, inline (`id=`) or by `ref=`. The column
 * value precedes the row's narrative, which repeats some tags as refs.
 */
function rowValue(row: string, tag: string, registry: Map<string, string>): string | null {
  const match = row.match(new RegExp(`<${tag}\\s+(?:id="(\\d+)"[^>]*>([^<]*)<|ref="(\\d+)")`));
  if (!match) return null;
  return match[3] !== undefined ? (registry.get(match[3]) ?? null) : decodeXml(match[2]!);
}

function valueRegistry(xml: string, tags: string[]): Map<string, string> {
  const registry = new Map<string, string>();
  const re = new RegExp(`<(?:${tags.join("|")})\\s+id="(\\d+)"[^>]*>([^<]*)<`, "g");
  for (const match of xml.matchAll(re)) registry.set(match[1]!, decodeXml(match[2]!));
  return registry;
}

/** `life-cycle-period` rows, sorted by start. Times are trace-relative, like CPU sample times. */
export function parseLifecyclePhases(xml: string): LifecyclePhase[] {
  const tags = ["start-time", "duration", "app-period"];
  const registry = valueRegistry(xml, tags);
  const phases: LifecyclePhase[] = [];
  for (const [row] of xml.matchAll(/<row>.*?<\/row>/gs)) {
    const start = rowValue(row, "start-time", registry);
    const duration = rowValue(row, "duration", registry);
    const period = rowValue(row, "app-period", registry);
    if (start === null || duration === null || period === null) continue;
    phases.push({ startNs: Number(start), durationNs: Number(duration), period });
  }
  return phases.sort((a, b) => a.startNs - b.startNs);
}

/**
 * End of launch as Apple defines it: the end of initial frame rendering. Falls
 * back to the first Foreground - Active start on templates without that phase.
 */
export function launchEndNs(phases: LifecyclePhase[]): number | null {
  const firstFrame = phases.find((phase) => phase.period === FIRST_FRAME_PERIOD);
  if (firstFrame) return firstFrame.startNs + firstFrame.durationNs;
  return phases.find((phase) => phase.period === FOREGROUND_ACTIVE_PERIOD)?.startNs ?? null;
}

/**
 * Keeps `time-profile` rows up to the last sample inside the launch. Refs only
 * point back to earlier rows, so cutting the tail keeps every remaining ref
 * resolvable. Cutting after the LAST in-window row, not before the first
 * out-of-window one, drops no launch sample even if rows are out of time order;
 * `laterRows` counts post-launch rows kept before the cut in that case.
 */
export function truncateCpuXml(
  xml: string,
  endNs: number
): { xml: string; keptRows: number; laterRows: number } {
  const registry = valueRegistry(xml, ["sample-time"]);
  let keptRows = 0;
  let laterRows = 0;
  let laterSinceLastKept = 0;
  let cutAt: number | null = null;
  for (const match of xml.matchAll(/<row>.*?<\/row>/gs)) {
    cutAt ??= match.index!;
    const time = rowValue(match[0], "sample-time", registry);
    if (time !== null && Number(time) > endNs) {
      laterSinceLastKept++;
      continue;
    }
    keptRows++;
    laterRows += laterSinceLastKept;
    laterSinceLastKept = 0;
    cutAt = match.index! + match[0].length;
  }
  if (cutAt === null || laterSinceLastKept === 0) return { xml, keptRows, laterRows };
  const tail = xml.slice(xml.lastIndexOf("</row>") + "</row>".length);
  return { xml: xml.slice(0, cutAt) + tail, keptRows, laterRows };
}

/**
 * XPath for the CPU samples. The App Launch template writes two time-profile
 * tables with the same running samples, the second adding waiting threads, so
 * exporting both would double count. Picks the running-only table when the TOC
 * marks it, else the first time-profile table.
 */
export function cpuTableXpath(tocXml: string): string | null {
  const tables = [...tocXml.matchAll(/<table\s[^>]*schema="time-profile"[^>]*>/g)].map((m) => m[0]);
  if (tables.length === 0) return null;
  const base = '/trace-toc/run[@number="1"]/data/table';
  return tables.some((table) => /record-waiting-threads="0"/.test(table))
    ? `${base}[@schema="time-profile" and @record-waiting-threads="0"]`
    : `${base}[@schema="time-profile"][1]`;
}
