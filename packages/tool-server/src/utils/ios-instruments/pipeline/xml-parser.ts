import { promises as fs } from "fs";
import type { CpuSample, RawHang, RawLeak, StackFrame } from "../types";
import { SYSTEM_LIBRARY_PATH_PREFIXES } from "../config";

// ---------------------------------------------------------------------------
// Shared XML helpers
// ---------------------------------------------------------------------------

function decodeXml(str: string): string {
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function attr(element: string, name: string): string | null {
  const re = new RegExp(`${name}="([^"]*)"`, "i");
  const m = element.match(re);
  return m ? decodeXml(m[1]) : null;
}

/** Extract all <row>...</row> blocks from the full XML content. */
function extractRows(xml: string): string[] {
  const rows: string[] = [];
  const re = /<row[\s>](.*?)<\/row>/gs;
  let m;
  while ((m = re.exec(xml)) !== null) {
    rows.push(m[0]);
  }
  return rows;
}

function isSystemLibraryPath(path: string): boolean {
  return SYSTEM_LIBRARY_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// CPU XML parsing
// ---------------------------------------------------------------------------

/**
 * Resolve frames from a backtrace element, handling id/ref deduplication.
 *
 * The xctrace export uses an id/ref system:
 * - `<frame id="N" name="funcName">` defines a frame and registers it
 * - `<frame ref="N"/>` references a previously-defined frame
 * - `<backtrace id="N">...</backtrace>` defines a backtrace and registers it
 * - `<backtrace ref="N"/>` references a previously-defined backtrace
 * - `<binary id="N" name="..." path="...">` defines a binary
 * - `<binary ref="N"/>` references a previously-defined binary
 */
export function parseCpuXml(xml: string): CpuSample[] {
  const frameRegistry = new Map<string, StackFrame>();
  const backtraceRegistry = new Map<string, StackFrame[]>();
  const binaryRegistry = new Map<string, { name: string; path: string }>();
  const samples: CpuSample[] = [];

  // Pre-register all binaries (they can appear before frames that reference them)
  const binaryRe =
    /<binary\s+id="(\d+)"\s+[^>]*?name="([^"]*)"[^>]*?path="([^"]*)"[^>]*?\/?>/g;
  let bm;
  while ((bm = binaryRe.exec(xml)) !== null) {
    binaryRegistry.set(bm[1], { name: bm[2], path: bm[3] });
  }

  const rows = extractRows(xml);

  for (const row of rows) {
    // Extract sample-time (nanoseconds)
    const sampleTimeMatch = row.match(/<sample-time[^>]*>(\d+)<\/sample-time>/);
    const sampleTimeRef = row.match(/<sample-time\s+ref="(\d+)"\s*\/>/);
    let timestampNs = 0;
    if (sampleTimeMatch) {
      timestampNs = parseInt(sampleTimeMatch[1], 10);
    } else if (sampleTimeRef) {
      // sample-time ref — rare, but handle it
      // We'd need a registry, but sample times are unique per row; skip
      continue;
    }

    // Extract thread fmt
    const threadMatch = row.match(/<thread[^>]*\sfmt="([^"]*)"[^>]*>/);
    const threadRefMatch = row.match(/<thread\s+ref="(\d+)"\s*\/>/);
    let threadFmt = "Unknown Thread";
    if (threadMatch) {
      threadFmt = decodeXml(threadMatch[1]);
    } else if (threadRefMatch) {
      // For thread refs, we need to look back — but the fmt is on the original.
      // We'll store them in a registry built during processing.
      threadFmt = `Thread ref:${threadRefMatch[1]}`;
    }

    // Extract weight (nanoseconds)
    const weightMatch = row.match(/<weight[^>]*>(\d+)<\/weight>/);
    const weightRefMatch = row.match(/<weight\s+ref="(\d+)"\s*\/>/);
    let weightNs = 1000000; // default 1ms
    if (weightMatch) {
      weightNs = parseInt(weightMatch[1], 10);
    } else if (weightRefMatch) {
      // weight ref — look up from previous. Default to 1ms.
    }

    // Extract backtrace
    const stack = resolveBacktrace(
      row,
      frameRegistry,
      backtraceRegistry,
      binaryRegistry,
    );

    samples.push({ timestampNs, threadFmt, weightNs, stack });
  }

  // Resolve thread refs by building a thread registry from all rows
  const threadRegistry = new Map<string, string>();
  const threadDefRe = /<thread\s+id="(\d+)"\s+fmt="([^"]*)"[^>]*>/g;
  let tm;
  while ((tm = threadDefRe.exec(xml)) !== null) {
    threadRegistry.set(tm[1], decodeXml(tm[2]));
  }

  // Also build weight registry
  const weightRegistry = new Map<string, number>();
  const weightDefRe = /<weight\s+id="(\d+)"[^>]*>(\d+)<\/weight>/g;
  let wm;
  while ((wm = weightDefRe.exec(xml)) !== null) {
    weightRegistry.set(wm[1], parseInt(wm[2], 10));
  }

  // Second pass: resolve refs
  let sampleIdx = 0;
  for (const row of rows) {
    if (sampleIdx >= samples.length) break;

    // Skip rows that were skipped in the first pass
    const sampleTimeRef = row.match(/<sample-time\s+ref="(\d+)"\s*\/>/);
    if (sampleTimeRef) continue;

    const sample = samples[sampleIdx]!;

    // Resolve thread ref
    if (sample.threadFmt.startsWith("Thread ref:")) {
      const refId = sample.threadFmt.slice("Thread ref:".length);
      sample.threadFmt = threadRegistry.get(refId) ?? "Unknown Thread";
    }

    // Resolve weight ref
    const weightRefMatch = row.match(/<weight\s+ref="(\d+)"\s*\/>/);
    if (weightRefMatch) {
      sample.weightNs = weightRegistry.get(weightRefMatch[1]) ?? 1000000;
    }

    sampleIdx++;
  }

  return samples;
}

function resolveBacktrace(
  rowXml: string,
  frameRegistry: Map<string, StackFrame>,
  backtraceRegistry: Map<string, StackFrame[]>,
  binaryRegistry: Map<string, { name: string; path: string }>,
): StackFrame[] {
  // Check for backtrace ref first
  const btRefMatch = rowXml.match(/<backtrace\s+ref="(\d+)"\s*\/>/);
  if (btRefMatch) {
    return backtraceRegistry.get(btRefMatch[1]) ?? [];
  }

  // Extract backtrace with frames
  const btMatch = rowXml.match(/<backtrace\s+id="(\d+)">(.*?)<\/backtrace>/s);
  if (!btMatch) {
    // Try backtrace without id
    const btNoId = rowXml.match(/<backtrace>(.*?)<\/backtrace>/s);
    if (!btNoId) return [];
    return resolveFrames(btNoId[1], frameRegistry, binaryRegistry);
  }

  const btId = btMatch[1];
  const frames = resolveFrames(btMatch[2], frameRegistry, binaryRegistry);
  backtraceRegistry.set(btId, frames);
  return frames;
}

function resolveFrames(
  backtraceContent: string,
  frameRegistry: Map<string, StackFrame>,
  binaryRegistry: Map<string, { name: string; path: string }>,
): StackFrame[] {
  const frames: StackFrame[] = [];
  // Match both <frame id="N" name="..." .../> and <frame ref="N"/>
  const frameRe = /<frame\s+((?:id|ref)="[^"]*"[^>]*?)\/?>/g;
  let fm;
  while ((fm = frameRe.exec(backtraceContent)) !== null) {
    const attrs = fm[1];
    const refMatch = attrs.match(/ref="(\d+)"/);
    if (refMatch) {
      const existing = frameRegistry.get(refMatch[1]);
      if (existing) frames.push(existing);
      continue;
    }

    const idMatch = attrs.match(/id="(\d+)"/);
    const nameMatch = attrs.match(/name="([^"]*)"/);
    const frameName = nameMatch ? decodeXml(nameMatch[1]) : "???";

    let isSystem = false;
    // Look for <binary> child element after this frame's opening tag.
    // Simulator paths can exceed 300 chars, so use a generous window.
    const frameFullMatch = backtraceContent.substring(
      fm.index!,
      fm.index! + fm[0].length + 2000,
    );
    const binaryIdMatch = frameFullMatch.match(
      /<binary\s+id="(\d+)"[^>]*path="([^"]*)"[^>]*\/?>/,
    );
    const binaryRefMatch = frameFullMatch.match(/<binary\s+ref="(\d+)"\s*\/>/);

    if (binaryIdMatch) {
      isSystem = isSystemLibraryPath(binaryIdMatch[2]);
      binaryRegistry.set(binaryIdMatch[1], {
        name: attr(binaryIdMatch[0], "name") ?? "",
        path: binaryIdMatch[2],
      });
    } else if (binaryRefMatch) {
      const bin = binaryRegistry.get(binaryRefMatch[1]);
      if (bin) isSystem = isSystemLibraryPath(bin.path);
    }

    const frame: StackFrame = { name: frameName, isSystemLibrary: isSystem };
    if (idMatch) frameRegistry.set(idMatch[1], frame);
    frames.push(frame);
  }

  return frames;
}

// ---------------------------------------------------------------------------
// Hangs XML parsing
// ---------------------------------------------------------------------------

export function parseHangsXml(xml: string): RawHang[] {
  const hangs: RawHang[] = [];
  const rows = extractRows(xml);

  // Build registries for ref resolution
  const registry = new Map<string, string>();
  const defRe = /id="(\d+)"\s+fmt="([^"]*)"/g;
  let dm;
  while ((dm = defRe.exec(xml)) !== null) {
    registry.set(dm[1], decodeXml(dm[2]));
  }

  const valueRegistry = new Map<string, string>();
  // Capture elements with id that have inner text (for start-time, duration, hang-type values)
  const valRe =
    /<(start-time|duration|hang-type)\s+id="(\d+)"[^>]*>([^<]+)<\//g;
  let vm;
  while ((vm = valRe.exec(xml)) !== null) {
    valueRegistry.set(vm[2], vm[3]);
  }

  for (const row of rows) {
    // start-time
    let startNs = 0;
    const startMatch = row.match(/<start-time[^>]*>(\d+)<\/start-time>/);
    const startRefMatch = row.match(/<start-time\s+ref="(\d+)"\s*\/>/);
    if (startMatch) {
      startNs = parseInt(startMatch[1], 10);
    } else if (startRefMatch) {
      startNs = parseInt(valueRegistry.get(startRefMatch[1]) ?? "0", 10);
    }

    // duration
    let durationNs = 0;
    const durMatch = row.match(/<duration[^>]*>(\d+)<\/duration>/);
    const durRefMatch = row.match(/<duration\s+ref="(\d+)"\s*\/>/);
    if (durMatch) {
      durationNs = parseInt(durMatch[1], 10);
    } else if (durRefMatch) {
      durationNs = parseInt(valueRegistry.get(durRefMatch[1]) ?? "0", 10);
    }

    // hang-type
    let hangType = "Unknown";
    const htMatch = row.match(/<hang-type[^>]*>([^<]+)<\/hang-type>/);
    const htRefMatch = row.match(/<hang-type\s+ref="(\d+)"\s*\/>/);
    if (htMatch) {
      hangType = decodeXml(htMatch[1]);
    } else if (htRefMatch) {
      hangType = valueRegistry.get(htRefMatch[1]) ?? "Unknown";
    }

    // thread fmt
    let threadFmt = "Main Thread";
    const threadMatch = row.match(/<thread[^>]*\sfmt="([^"]*)"[^>]*>/);
    const threadRefMatch = row.match(/<thread\s+ref="(\d+)"\s*\/>/);
    if (threadMatch) {
      threadFmt = decodeXml(threadMatch[1]);
    } else if (threadRefMatch) {
      threadFmt = registry.get(threadRefMatch[1]) ?? "Main Thread";
    }

    if (startNs > 0 || durationNs > 0) {
      hangs.push({ startNs, durationNs, hangType, threadFmt });
    }
  }

  return hangs;
}

// ---------------------------------------------------------------------------
// Leaks XML parsing
// ---------------------------------------------------------------------------

export function parseLeaksXml(xml: string): RawLeak[] {
  const leaks: RawLeak[] = [];
  // Leaks use self-closing <row .../> with attributes
  const rowRe = /<row\s+([^>]*?)\/>/g;
  let rm;
  while ((rm = rowRe.exec(xml)) !== null) {
    const rowAttrs = rm[1];
    const objectType = attr(rm[0], "leaked-object") ?? "Unknown";
    const sizeStr = attr(rm[0], "size");
    const sizeBytes = sizeStr ? parseInt(sizeStr, 10) : 0;
    const responsibleFrame = attr(rm[0], "responsible-frame") ?? "Unknown";
    const responsibleLibrary = attr(rm[0], "responsible-library") ?? "";
    const countStr = attr(rm[0], "count");
    const count = countStr ? parseInt(countStr, 10) : 1;

    leaks.push({
      objectType,
      sizeBytes,
      responsibleFrame,
      responsibleLibrary,
      count,
    });
  }

  return leaks;
}

// ---------------------------------------------------------------------------
// File-level entry points
// ---------------------------------------------------------------------------

export async function parseCpuFile(
  filePath: string | null,
): Promise<CpuSample[]> {
  if (!filePath) return [];
  try {
    const xml = await fs.readFile(filePath, "utf8");
    return parseCpuXml(xml);
  } catch {
    return [];
  }
}

export async function parseHangsFile(
  filePath: string | null,
): Promise<RawHang[]> {
  if (!filePath) return [];
  try {
    const xml = await fs.readFile(filePath, "utf8");
    return parseHangsXml(xml);
  } catch {
    return [];
  }
}

export async function parseLeaksFile(
  filePath: string | null,
): Promise<RawLeak[]> {
  if (!filePath) return [];
  try {
    const xml = await fs.readFile(filePath, "utf8");
    return parseLeaksXml(xml);
  } catch {
    return [];
  }
}
