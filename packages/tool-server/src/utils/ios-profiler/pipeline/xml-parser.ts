import { promises as fs } from "fs";
import type { CpuSample, RawHang, RawLeak, StackFrame } from "../types";
import { SYSTEM_LIBRARY_PATH_PREFIXES } from "../config";

function decodeXml(str: string): string {
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function attr(element: string, name: string): string | null {
  const re = new RegExp(`${name}="([^"]*)"`, "i");
  const m = element.match(re);
  return m ? decodeXml(m[1]) : null;
}

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

/**
 * The xctrace export uses an id/ref system: `<frame id="N">`, `<backtrace id="N">` and
 * `<binary id="N">` define and register an element; `<... ref="N"/>` reuses a prior one.
 */
export function parseCpuXml(xml: string, targetPid: number | null = null): CpuSample[] {
  const frameRegistry = new Map<string, StackFrame>();
  const backtraceRegistry = new Map<string, StackFrame[]>();
  const binaryRegistry = new Map<string, { name: string; path: string }>();
  const samples: CpuSample[] = [];

  // Binaries can appear before the frames that reference them.
  const binaryRe = /<binary\s+id="(\d+)"\s+[^>]*?name="([^"]*)"[^>]*?path="([^"]*)"[^>]*?\/?>/g;
  let bm;
  while ((bm = binaryRe.exec(xml)) !== null) {
    binaryRegistry.set(bm[1], { name: bm[2], path: bm[3] });
  }

  // Per-process filtering for the host-wide (--all-processes) capture. `fmt` is
  // "Name (PID)" and names can themselves contain parens ("Code Helper (Plugin) (54394)"),
  // so the PID is the LAST parenthesised group. `pidByIndex` runs parallel to `samples`
  // so non-target rows are dropped only after the two passes, keeping row↔sample
  // alignment intact. A no-op when no filter is set.
  const processPid = new Map<string, number>();
  const pidByIndex: (number | undefined)[] = [];
  if (targetPid != null) {
    const procRe = /<process\s+id="(\d+)"\s+fmt="([^"]*)"/g;
    let pm;
    while ((pm = procRe.exec(xml)) !== null) {
      const parens = [...pm[2].matchAll(/\((\d+)\)/g)];
      if (parens.length > 0) {
        processPid.set(pm[1], parseInt(parens[parens.length - 1][1], 10));
      }
    }
  }

  const rows = extractRows(xml);

  for (const row of rows) {
    const sampleTimeMatch = row.match(/<sample-time[^>]*>(\d+)<\/sample-time>/);
    const sampleTimeRef = row.match(/<sample-time\s+ref="(\d+)"\s*\/>/);
    let timestampNs = 0;
    if (sampleTimeMatch) {
      timestampNs = parseInt(sampleTimeMatch[1], 10);
    } else if (sampleTimeRef) {
      // No sample-time ref registry; the second pass skips these rows too.
      continue;
    }

    const threadMatch = row.match(/<thread[^>]*\sfmt="([^"]*)"[^>]*>/);
    const threadRefMatch = row.match(/<thread\s+ref="(\d+)"\s*\/>/);
    let threadFmt = "Unknown Thread";
    if (threadMatch) {
      threadFmt = decodeXml(threadMatch[1]);
    } else if (threadRefMatch) {
      // Sentinel; the second pass resolves it against threadRegistry.
      threadFmt = `Thread ref:${threadRefMatch[1]}`;
    }

    const weightMatch = row.match(/<weight[^>]*>(\d+)<\/weight>/);
    const weightRefMatch = row.match(/<weight\s+ref="(\d+)"\s*\/>/);
    let weightNs = 1000000; // 1ms
    if (weightMatch) {
      weightNs = parseInt(weightMatch[1], 10);
    } else if (weightRefMatch) {
      /* resolved in the second pass */
    }

    const stack = resolveBacktrace(row, frameRegistry, backtraceRegistry, binaryRegistry);

    if (targetPid != null) {
      pidByIndex.push(rowProcessPid(row, processPid));
    }
    samples.push({ timestampNs, threadFmt, weightNs, stack });
  }

  const threadRegistry = new Map<string, string>();
  const threadDefRe = /<thread\s+id="(\d+)"\s+fmt="([^"]*)"[^>]*>/g;
  let tm;
  while ((tm = threadDefRe.exec(xml)) !== null) {
    threadRegistry.set(tm[1], decodeXml(tm[2]));
  }

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

    if (sample.threadFmt.startsWith("Thread ref:")) {
      const refId = sample.threadFmt.slice("Thread ref:".length);
      sample.threadFmt = threadRegistry.get(refId) ?? "Unknown Thread";
    }

    const weightRefMatch = row.match(/<weight\s+ref="(\d+)"\s*\/>/);
    if (weightRefMatch) {
      sample.weightNs = weightRegistry.get(weightRefMatch[1]) ?? 1000000;
    }

    sampleIdx++;
  }

  if (targetPid != null) {
    return samples.filter((_sample, i) => pidByIndex[i] === targetPid);
  }
  return samples;
}

/** A row either defines its process inline or references one; both give a pre-registered id. */
function rowProcessPid(rowXml: string, processPid: Map<string, number>): number | undefined {
  const def = rowXml.match(/<process\s+id="(\d+)"/);
  const ref = rowXml.match(/<process\s+ref="(\d+)"\s*\/>/);
  const id = def?.[1] ?? ref?.[1];
  return id != null ? processPid.get(id) : undefined;
}

function resolveBacktrace(
  rowXml: string,
  frameRegistry: Map<string, StackFrame>,
  backtraceRegistry: Map<string, StackFrame[]>,
  binaryRegistry: Map<string, { name: string; path: string }>
): StackFrame[] {
  const btRefMatch = rowXml.match(/<backtrace\s+ref="(\d+)"\s*\/>/);
  if (btRefMatch) {
    return backtraceRegistry.get(btRefMatch[1]) ?? [];
  }

  const btMatch = rowXml.match(/<backtrace\s+id="(\d+)">(.*?)<\/backtrace>/s);
  if (!btMatch) {
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
  binaryRegistry: Map<string, { name: string; path: string }>
): StackFrame[] {
  const frames: StackFrame[] = [];
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
    // Window for the frame's <binary> child: simulator paths can exceed 300 chars.
    const frameFullMatch = backtraceContent.substring(fm.index!, fm.index! + fm[0].length + 2000);
    const binaryIdMatch = frameFullMatch.match(/<binary\s+id="(\d+)"[^>]*path="([^"]*)"[^>]*\/?>/);
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

function parseHangsXml(xml: string): RawHang[] {
  const hangs: RawHang[] = [];
  const rows = extractRows(xml);

  const registry = new Map<string, string>();
  const defRe = /id="(\d+)"\s+fmt="([^"]*)"/g;
  let dm;
  while ((dm = defRe.exec(xml)) !== null) {
    registry.set(dm[1], decodeXml(dm[2]));
  }

  const valueRegistry = new Map<string, string>();
  const valRe = /<(start-time|duration|hang-type)\s+id="(\d+)"[^>]*>([^<]+)<\//g;
  let vm;
  while ((vm = valRe.exec(xml)) !== null) {
    valueRegistry.set(vm[2], vm[3]);
  }

  for (const row of rows) {
    let startNs = 0;
    const startMatch = row.match(/<start-time[^>]*>(\d+)<\/start-time>/);
    const startRefMatch = row.match(/<start-time\s+ref="(\d+)"\s*\/>/);
    if (startMatch) {
      startNs = parseInt(startMatch[1], 10);
    } else if (startRefMatch) {
      startNs = parseInt(valueRegistry.get(startRefMatch[1]) ?? "0", 10);
    }

    let durationNs = 0;
    const durMatch = row.match(/<duration[^>]*>(\d+)<\/duration>/);
    const durRefMatch = row.match(/<duration\s+ref="(\d+)"\s*\/>/);
    if (durMatch) {
      durationNs = parseInt(durMatch[1], 10);
    } else if (durRefMatch) {
      durationNs = parseInt(valueRegistry.get(durRefMatch[1]) ?? "0", 10);
    }

    let hangType = "Unknown";
    const htMatch = row.match(/<hang-type[^>]*>([^<]+)<\/hang-type>/);
    const htRefMatch = row.match(/<hang-type\s+ref="(\d+)"\s*\/>/);
    if (htMatch) {
      hangType = decodeXml(htMatch[1]);
    } else if (htRefMatch) {
      hangType = valueRegistry.get(htRefMatch[1]) ?? "Unknown";
    }

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

export function parseLeaksXml(xml: string): RawLeak[] {
  const leaks: RawLeak[] = [];
  // Leaks rows are self-closing, which extractRows() does not match.
  const rowRe = /<row\s+([^>]*?)\/>/g;
  let rm;
  while ((rm = rowRe.exec(xml)) !== null) {
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

export async function parseCpuFile(
  filePath: string | null,
  targetPid: number | null = null
): Promise<CpuSample[]> {
  if (!filePath) return [];
  try {
    const xml = await fs.readFile(filePath, "utf8");
    return parseCpuXml(xml, targetPid);
  } catch {
    return [];
  }
}

export async function parseHangsFile(filePath: string | null): Promise<RawHang[]> {
  if (!filePath) return [];
  try {
    const xml = await fs.readFile(filePath, "utf8");
    return parseHangsXml(xml);
  } catch {
    return [];
  }
}

export async function parseLeaksFile(filePath: string | null): Promise<RawLeak[]> {
  if (!filePath) return [];
  try {
    const xml = await fs.readFile(filePath, "utf8");
    return parseLeaksXml(xml);
  } catch {
    return [];
  }
}
