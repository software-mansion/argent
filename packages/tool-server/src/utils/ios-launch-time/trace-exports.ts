/** Parsing and cutting of App Launch exports; ranking is left to the profiler query tools. */

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
 * Cells of every row, refs resolved; a value is the text, else `fmt`. Nested
 * cells (a process's pid) come out as their own cells, harmless for lookups by tag.
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
 * Whether a row belongs to `processName`, matched against the process column,
 * formatted "<name> (<pid>)". Rows with no process cell, and every row when
 * `processName` is undefined, pass.
 */
function processFilter(processName?: string): (cells: RowCell[]) => boolean {
  if (!processName) return () => true;
  const pattern = new RegExp(`^${processName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(`);
  return (cells) => {
    const process = cells.find((cell) => cell.tag === "process");
    return !process || pattern.test(process.value);
  };
}

/** Earliest `ApplicationFirstFramePresentation` End signpost of `processName`, trace-relative ns. */
export function parseFirstFrameSignpostNs(xml: string, processName?: string): number | null {
  const ofProcess = processFilter(processName);
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
    if (!ofProcess(cells)) continue;
    const time = Number(cells.find((cell) => /time$/.test(cell.tag))?.value);
    if (Number.isFinite(time) && (earliest === null || time < earliest)) earliest = time;
  }
  return earliest;
}

/** The launched process's name in the TOC, as the signpost process column spells it. */
export function launchedProcessName(tocXml: string): string | null {
  const tag = tocXml.match(/<process\s[^>]*type="launched"[^>]*>/)?.[0];
  const name = tag?.match(/\sname="([^"]*)"/)?.[1];
  return name ? decodeXml(name) : null;
}

/** Earliest `start-time` among `processName`'s `dyld-activity-interval` rows, trace-relative ns. */
export function earliestDyldStartNs(xml: string, processName?: string): number | null {
  const ofProcess = processFilter(processName);
  let earliest: number | null = null;
  for (const cells of resolvedRows(xml)) {
    if (!ofProcess(cells)) continue;
    const start = cells.find((cell) => cell.tag === "start-time");
    const ns = Number(start?.value);
    if (start && start.value !== "" && Number.isFinite(ns)) {
      earliest = earliest === null ? ns : Math.min(earliest, ns);
    }
  }
  return earliest;
}

/**
 * Like the CPU parser, skips a row whose `<sample-time>` is a ref, so these
 * counts match what profiler-load reports.
 */
function isParsedSample(row: string): boolean {
  return !/<sample-time\s+ref="\d+"\s*\/>/.test(row);
}

/** Keep only launch samples, including out-of-order ones and their referenced definitions. */
export function truncateCpuXml(xml: string, endNs: number): { xml: string; keptRows: number } {
  const times = valueRegistry(xml, ["sample-time"]);
  let keptRows = 0;
  const cut = filterCpuRows(xml, (row) => {
    const time = rowValue(row, "sample-time", times);
    if (time !== null && Number(time) > endNs) return false;
    if (isParsedSample(row)) keptRows++;
    return true;
  });
  return { xml: cut, keptRows };
}

/**
 * The interval xctrace sampled the CPU at, from the sample times. The App Launch
 * template asks for 1 ms and 5 ms, xctrace uses one of them, which one changes
 * from run to run, and every row keeps the same weight either way. A thread
 * that keeps running gets one sample per tick, so the most common gap between
 * a thread's consecutive samples is the interval. Null when too few gaps agree.
 */
function inferredSamplePeriodNs(xml: string): number | null {
  const registry = valueRegistry(xml, ["sample-time"]);
  const times = new Map<string, number[]>();
  for (const [row] of xml.matchAll(/<row>.*?<\/row>/gs)) {
    const thread = row.match(/<thread\s+(?:id|ref)="(\d+)"/)?.[1];
    const value = rowValue(row, "sample-time", registry);
    if (thread === undefined || value === null) continue;
    const time = Number(value);
    if (!Number.isFinite(time)) continue;
    const series = times.get(thread);
    if (series) series.push(time);
    else times.set(thread, [time]);
  }
  let oneMs = 0;
  let fiveMs = 0;
  let hasShorterGap = false;
  let gaps = 0;
  for (const series of times.values()) {
    series.sort((a, b) => a - b);
    for (let i = 1; i < series.length; i++) {
      const gap = Math.round((series[i]! - series[i - 1]!) / 100_000) * 100_000;
      if (gap <= 0) continue;
      if (gap === 1_000_000) oneMs++;
      if (gap === 5_000_000) fiveMs++;
      // Allow timestamp jitter, but a clearly shorter same-thread gap rules out 5 ms.
      if (gap < 4_500_000) hasShorterGap = true;
      gaps++;
    }
  }
  if (gaps < 20) return null;
  if (oneMs * 2 >= gaps) return 1_000_000;
  return !hasShorterGap && fiveMs * 2 >= gaps ? 5_000_000 : null;
}

/**
 * Gives every sample the weight of the interval xctrace sampled at. Leaves the
 * XML as it is when the interval is unclear, or when the weights differ between
 * samples and so do not stand for one tick each.
 */
export function weighSamplesByPeriod(
  xml: string,
  recordLog: string
): { xml: string; periodNs: number | null } {
  // Some Xcode versions report the actual period when the two time-sample tables
  // request different rates. Even a sparse trace can then be weighed correctly.
  const configured = new Set(
    Array.from(
      recordLog.matchAll(
        /binding 'time-sample' table: requested sampling period \(\d+ns\) differs from configured \((\d+)ns\)/gi
      ),
      (match) => Number(match[1])
    )
  );
  if (configured.size > 1) return { xml, periodNs: null };
  const [reported] = configured;
  const periodNs = reported ?? inferredSamplePeriodNs(xml);
  if (periodNs !== 1_000_000 && periodNs !== 5_000_000) return { xml, periodNs: null };
  const weight = /<weight\s+id="(\d+)"[^>]*>(\d+)<\/weight>/g;
  const weights = new Set([...xml.matchAll(weight)].map((match) => Number(match[2])));
  if (weights.size !== 1) return { xml, periodNs: null };
  if (weights.has(periodNs)) return { xml, periodNs };
  // Only the fixed 1 ms export weight needs correcting on a 5 ms recording.
  if (periodNs !== 5_000_000 || !weights.has(1_000_000)) return { xml, periodNs: null };
  const fmt = `${(periodNs / 1_000_000).toFixed(2)} ms`;
  return {
    xml: xml.replace(
      weight,
      (_, id: string) => `<weight id="${id}" fmt="${fmt}">${periodNs}</weight>`
    ),
    periodNs,
  };
}

/**
 * Save each definition from a discarded row. In a saved parent, a nested
 * definition becomes a ref so it can be emitted exactly once, even when a
 * later row uses the child before it uses the parent.
 */
function rememberDefinitions(row: string, pending: Map<string, string>): void {
  const stack: Array<{ id?: string; parts: string[] }> = [];
  for (const [token] of row.matchAll(/<[^>]+>|[^<]+/g)) {
    if (token.startsWith("</")) {
      const element = stack.pop()!;
      element.parts.push(token);
      const xml = element.parts.join("");
      if (element.id) pending.set(element.id, xml);
      else stack.at(-1)?.parts.push(xml);
      continue;
    }
    const parent = stack.at(-1);
    if (!token.startsWith("<")) {
      parent?.parts.push(token);
      continue;
    }
    const definition = token.match(/^<([\w-]+)\s+id="(\d+)"/);
    const id = definition?.[2];
    if (definition) parent?.parts.push(`<${definition[1]} ref="${id}"/>`);
    if (!token.endsWith("/>")) stack.push({ id, parts: [token] });
    else if (id) pending.set(id, token);
    else parent?.parts.push(token);
  }
}

/** Keep refs readable when their defining row is removed. Ignore definitions in a discarded tail. */
function filterCpuRows(xml: string, keep: (row: string) => boolean): string {
  const pending = new Map<string, string>();
  const rehome = (text: string): string =>
    text.replace(/<[\w-]+\s+ref="(\d+)"\s*\/>/g, (ref, id: string) => {
      const definition = pending.get(id);
      if (definition === undefined) return ref;
      pending.delete(id);
      return rehome(definition);
    });

  const discarded: string[] = [];
  return xml.replace(/<row>.*?<\/row>/gs, (row) => {
    if (!keep(row)) {
      discarded.push(row);
      return "";
    }
    for (const skipped of discarded) rememberDefinitions(skipped, pending);
    discarded.length = 0;
    return pending.size ? rehome(row) : row;
  });
}

/**
 * Keeps only `time-profile` rows of running threads: on a simulator the only
 * table includes waiting threads, whose Blocked and Runnable rows weigh the wait,
 * so idle waits would rank as CPU work. A ref to a dropped row's definition gets
 * that definition inlined. Also removes thread-state cells, which the CPU parser
 * could read as a thread name.
 */
export function keepRunningRows(xml: string): { xml: string; droppedRows: number } {
  const states = valueRegistry(xml, ["thread-state"]);
  let droppedRows = 0;
  const kept = filterCpuRows(xml, (row) => {
    const state = rowValue(row, "thread-state", states);
    if (state === null || state === "Running") return true;
    droppedRows++;
    return false;
  });
  return {
    xml: kept.replace(/<thread-state\b[^>]*\/>|<thread-state\b[^>]*>[^<]*<\/thread-state>/g, ""),
    droppedRows,
  };
}

/**
 * The App Launch template can write two time-profile tables with the same
 * running samples, the second adding waiting threads; exporting both would
 * double count.
 */
export function cpuTableXpath(tocXml: string): string | null {
  const tables = [...tocXml.matchAll(/<table\s[^>]*schema="time-profile"[^>]*>/g)].map((m) => m[0]);
  if (tables.length === 0) return null;
  const base = '/trace-toc/run[@number="1"]/data/table';
  return tables.some((table) => /record-waiting-threads="0"/.test(table))
    ? `${base}[@schema="time-profile" and @record-waiting-threads="0"]`
    : `${base}[@schema="time-profile"][1]`;
}
