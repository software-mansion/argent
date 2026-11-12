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

const LAUNCH_SIGNPOST_SUBSYSTEM = "com.apple.app_launch_measurement";
const FIRST_FRAME_SIGNPOST = "ApplicationFirstFramePresentation";

interface RowCell {
  tag: string;
  value: string;
}

/**
 * Every cell of every row of an xctrace export, refs resolved. A cell's value is
 * its text, else its `fmt`. Cells nested in a cell (a process's pid) come out as
 * cells of their own, which is harmless for lookups by tag.
 */
function resolvedRows(xml: string): RowCell[][] {
  const registry = new Map<string, string>();
  const openTag = /<([\w-]+)\s+(?:id="(\d+)"([^>]*?)\/?>([^<]*)|ref="(\d+)")/g;
  const rows: RowCell[][] = [];
  for (const [row] of xml.matchAll(/<row>.*?<\/row>/gs)) {
    const cells: RowCell[] = [];
    for (const match of row.matchAll(openTag)) {
      const [, tag, id, attrs, text, ref] = match;
      let value: string | null;
      if (ref !== undefined) {
        value = registry.get(ref) ?? null;
      } else {
        const fmt = attrs!.match(/\bfmt="([^"]*)"/)?.[1];
        value = decodeXml(text!.trim() || fmt || "");
        registry.set(id!, value);
      }
      if (value !== null) cells.push({ tag: tag!, value });
    }
    rows.push(cells);
  }
  return rows;
}

/**
 * Time of the first `ApplicationFirstFramePresentation` End signpost the system
 * emits for the launched process, in trace-relative ns (the clock of CPU sample
 * times). It exists on simulators too, where the lifecycle table stays empty.
 * `processName` keeps signposts of other apps out by matching the process
 * column, formatted "<name> (<pid>)"; rows with no process cell pass.
 */
export function parseFirstFrameSignpostNs(xml: string, processName?: string): number | null {
  const processPattern = processName
    ? new RegExp(`^${processName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(`)
    : null;
  let earliest: number | null = null;
  for (const cells of resolvedRows(xml)) {
    const values = cells.map((cell) => cell.value);
    if (
      !values.includes(LAUNCH_SIGNPOST_SUBSYSTEM) ||
      !values.includes(FIRST_FRAME_SIGNPOST) ||
      !cells.some((cell) => /event-type/.test(cell.tag) && cell.value === "End")
    ) {
      continue;
    }
    const process = cells.find((cell) => cell.tag === "process");
    if (processPattern && process && !processPattern.test(process.value)) continue;
    const time = Number(cells.find((cell) => /time$/.test(cell.tag))?.value);
    if (Number.isFinite(time) && (earliest === null || time < earliest)) earliest = time;
  }
  return earliest;
}

/** Earliest `start-time` among `dyld-activity-interval` rows, trace-relative ns. */
export function earliestDyldStartNs(xml: string): number | null {
  const registry = valueRegistry(xml, ["start-time"]);
  let earliest: number | null = null;
  for (const [row] of xml.matchAll(/<row>.*?<\/row>/gs)) {
    const start = Number(rowValue(row, "start-time", registry));
    if (rowValue(row, "start-time", registry) !== null && Number.isFinite(start)) {
      earliest = earliest === null ? start : Math.min(earliest, start);
    }
  }
  return earliest;
}

/**
 * A row the CPU parser counts as a sample. It skips a row whose `<sample-time>`
 * is a ref (a second sample at the same instant), so these counts match the
 * session that profiler-load reports.
 */
function isParsedSample(row: string): boolean {
  return !/<sample-time\s+ref="\d+"\s*\/>/.test(row);
}

/**
 * Keeps `time-profile` rows up to the last sample inside the launch. Refs only
 * point back to earlier rows, so cutting the tail keeps every remaining ref
 * resolvable. Cutting after the LAST in-window row, not before the first
 * out-of-window one, drops no launch sample even if rows are out of time order;
 * `laterRows` counts post-launch samples kept before the cut in that case.
 * Pass `Infinity` to keep every row and only count the samples.
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
    const counted = isParsedSample(match[0]) ? 1 : 0;
    const time = rowValue(match[0], "sample-time", registry);
    if (time !== null && Number(time) > endNs) {
      laterSinceLastKept += counted;
      continue;
    }
    keptRows += counted;
    laterRows += laterSinceLastKept;
    laterSinceLastKept = 0;
    cutAt = match.index! + match[0].length;
  }
  if (cutAt === null || xml.indexOf("<row>", cutAt) === -1) return { xml, keptRows, laterRows };
  const tail = xml.slice(xml.lastIndexOf("</row>") + "</row>".length);
  return { xml: xml.slice(0, cutAt) + tail, keptRows, laterRows };
}

/**
 * Every element in `text` that defines an id, with its full text. A nested
 * definition (a frame in a backtrace) is listed as well as its parent.
 */
function definitions(text: string): Map<string, string> {
  const found = new Map<string, string>();
  const open = /<([\w-]+)\s[^>]*?\bid="(\d+)"[^>]*?(\/?)>/g;
  for (const match of text.matchAll(open)) {
    const [element, tag, id, selfClosing] = match;
    if (selfClosing) {
      found.set(id!, element);
      continue;
    }
    // Same-tag nesting is counted so the matching close tag is found.
    const tags = new RegExp(`<${tag}[\\s>/]|</${tag}>`, "g");
    tags.lastIndex = match.index! + element.length;
    let depth = 1;
    for (let next = tags.exec(text); next; next = tags.exec(text)) {
      if (next[0].startsWith("</")) depth--;
      else if (!/\/>/.test(text.slice(next.index, text.indexOf(">", next.index) + 1))) depth++;
      if (depth === 0) {
        found.set(id!, text.slice(match.index, next.index + next[0].length));
        break;
      }
    }
  }
  return found;
}

/**
 * Keeps only the `time-profile` rows of running threads. The App Launch
 * template on a simulator records only a table with waiting threads, whose
 * Blocked and Runnable rows carry the time a thread waited as weight, so the
 * profiler tools would rank idle waits as CPU work. A later ref to an element a
 * dropped row defined gets that definition in its place, so every ref stays
 * resolvable. Rows without a thread state are kept. Also removes the
 * thread-state cells, which the CPU parser could read as a thread name.
 */
export function keepRunningRows(xml: string): { xml: string; droppedRows: number } {
  const states = valueRegistry(xml, ["thread-state"]);
  const pending = new Map<string, string>();
  const rehome = (text: string): string =>
    pending.size === 0
      ? text
      : text.replace(/<[\w-]+\s+ref="(\d+)"\s*\/>/g, (ref, id: string) => {
          const definition = pending.get(id);
          if (definition === undefined) return ref;
          for (const nested of definitions(definition).keys()) pending.delete(nested);
          return rehome(definition);
        });
  let droppedRows = 0;
  const kept = xml.replace(/<row>.*?<\/row>/gs, (row) => {
    const state = rowValue(row, "thread-state", states);
    if (state === null || state === "Running") return rehome(row);
    droppedRows++;
    for (const [id, definition] of definitions(rehome(row))) {
      if (!pending.has(id)) pending.set(id, definition);
    }
    return "";
  });
  return {
    xml: kept.replace(/<thread-state\b[^>]*\/>|<thread-state\b[^>]*>[^<]*<\/thread-state>/g, ""),
    droppedRows,
  };
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
