// Symbolicate kperf callstacks (via `atos -p`) and emit the xctrace-export-format
// XML (`time-profile` + `potential-hangs`) that Argent's runIosProfilerPipeline
// consumes. Port of the Python emit_trace.py.
import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ParsedKdebug, Callstack } from "./kdebug";

const execFileAsync = promisify(execFile);

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Resolve a target (pid or process name) against the parsed threadmap. */
export function resolveTarget(
  parsed: ParsedKdebug,
  target: string | number
): { pid: number; name: string } | null {
  if (typeof target === "number" || /^\d+$/.test(String(target))) {
    const pid = Number(target);
    return { pid, name: parsed.pidsNames.get(pid) ?? String(pid) };
  }
  const t = String(target).toLowerCase();
  for (const [pid, name] of parsed.pidsNames) {
    if (name.toLowerCase().includes(t)) return { pid, name };
  }
  return null;
}

/** Batched `atos -p <pid>` symbolication: hex address → "func (in Binary) + off". */
async function symbolicate(pid: number, addrs: bigint[]): Promise<Map<string, string>> {
  const sym = new Map<string, string>();
  const hexes = addrs.map((a) => "0x" + a.toString(16));
  for (let i = 0; i < hexes.length; i += 400) {
    const chunk = hexes.slice(i, i + 400);
    try {
      const { stdout } = await execFileAsync("atos", ["-p", String(pid), ...chunk], {
        maxBuffer: 32 * 1024 * 1024,
      });
      const lines = stdout.split("\n");
      chunk.forEach((h, j) => sym.set(h, (lines[j] ?? "").trim()));
    } catch {
      /* leave unsymbolicated */
    }
  }
  return sym;
}

const FRAME_RE = /^(.*?)\s+\(in (.+?)\)(?:\s+\+\s+\d+)?(?:\s+\([^)]*\))?$/;

function splitSym(
  line: string | undefined,
  addr: bigint,
  appName: string
): { func: string; binary: string; path: string } {
  if (!line || line.startsWith("0x"))
    return { func: "0x" + addr.toString(16), binary: appName, path: `/var/sim/${appName}` };
  const m = FRAME_RE.exec(line);
  if (!m) return { func: line, binary: appName, path: `/var/sim/${appName}` };
  const func = m[1];
  const binary = m[2];
  // app's own binary → non-system path; everything else → a CoreSimulator path so
  // Argent's isSystemLibraryPath() classifies it as a (deprioritized) system frame.
  const path =
    binary === appName
      ? `/var/containers/Bundle/Application/${appName}.app/${appName}`
      : `/Library/Developer/CoreSimulator/Volumes/iOS/RuntimeRoot/System/Library/${binary}`;
  return { func, binary, path };
}

function medianGap(timestamps: number[]): number {
  if (timestamps.length < 2) return 1000000;
  const sorted = [...timestamps].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i] - sorted[i - 1]);
  gaps.sort((a, b) => a - b);
  return Math.max(1, gaps[Math.floor(gaps.length / 2)]);
}

export interface EmitResult {
  cpu: string;
  hangs: string;
  pid: number;
  name: string;
  cpuSamples: number;
  hangs_count: number;
}

/** Emit `<prefix>_raw_cpu.xml` (time-profile) and `<prefix>_raw_hangs.xml` (potential-hangs). */
export async function emitCpuAndHangs(
  parsed: ParsedKdebug,
  target: string | number,
  outPrefix: string
): Promise<EmitResult> {
  let resolved = resolveTarget(parsed, target);
  if (!resolved) {
    // Target not found in the threadmap at all → fall back to the busiest mappable
    // process. (A resolved-but-idle target keeps 0 CPU samples — that's valid, and
    // leaks/memory still scan the requested process.)
    const counts = new Map<number, number>();
    for (const c of parsed.callstacks) {
      const pid = parsed.threadsPids.get(c.tid);
      if (pid !== undefined) counts.set(pid, (counts.get(pid) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top) resolved = { pid: top[0], name: parsed.pidsNames.get(top[0]) ?? String(top[0]) };
  }
  if (!resolved) resolved = { pid: -1, name: String(target) };
  const { pid, name } = resolved;

  const psamples: Callstack[] = parsed.callstacks.filter(
    (c) => parsed.threadsPids.get(c.tid) === pid
  );

  // symbolicate all unique frame addresses
  const uniq = new Map<string, bigint>();
  for (const s of psamples) for (const f of s.frames) uniq.set("0x" + f.toString(16), f);
  const sym = await symbolicate(pid, [...uniq.values()]);

  // kd_buf timestamps are mach-absolute TICKS; the downstream pipeline expects
  // nanoseconds (sample-time/weight/hang-duration all interpreted as ns). Convert
  // via the header tick_frequency, relative to the first sample so values stay
  // small and exact. tickFrequency=0 (unknown) → assume the stream is already ns.
  const nsPerTick = parsed.tickFrequency > 0 ? 1e9 / parsed.tickFrequency : 1;
  const base = psamples.reduce((m, s) => Math.min(m, s.timestamp), Infinity);
  const toNs = (ticks: number) => Math.round((ticks - base) * nsPerTick);

  // weight = median inter-sample gap per tid (in ns)
  const tsByTid = new Map<number, number[]>();
  for (const s of psamples) {
    const arr = tsByTid.get(s.tid) ?? [];
    arr.push(toNs(s.timestamp));
    tsByTid.set(s.tid, arr);
  }
  const weightByTid = new Map<number, number>();
  for (const [tid, ts] of tsByTid) weightByTid.set(tid, medianGap(ts));

  let gid = 0;
  const nid = () => ++gid;
  const rows: string[] = [];
  for (const s of psamples) {
    if (!s.frames.length) continue;
    const bt: string[] = [];
    for (const f of s.frames) {
      const { func, binary, path } = splitSym(sym.get("0x" + f.toString(16)), f, name);
      bt.push(
        `<frame id="${nid()}" name="${xmlEscape(func)}">` +
          `<binary id="${nid()}" name="${xmlEscape(binary)}" path="${xmlEscape(path)}"/></frame>`
      );
    }
    rows.push(
      `<row><sample-time id="${nid()}" fmt="">${toNs(s.timestamp)}</sample-time>` +
        `<thread id="${nid()}" fmt="${xmlEscape(name)} ${s.tid}"/>` +
        `<weight id="${nid()}" fmt="">${weightByTid.get(s.tid) ?? 1000000}</weight>` +
        `<backtrace id="${nid()}">${bt.join("")}</backtrace></row>`
    );
  }
  const cpuXml =
    `<?xml version="1.0"?>\n<trace-toc><run number="1"><data>` +
    `<table schema="time-profile">${rows.join("")}</table></data></run></trace-toc>\n`;
  fs.writeFileSync(`${outPrefix}_raw_cpu.xml`, cpuXml);

  // Hangs: contiguous on-CPU runs of the busiest (≈main) thread ≥250ms.
  const HANG = 250_000_000;
  const GAP = 60_000_000;
  let mainTid = -1;
  let mainN = -1;
  for (const [tid, ts] of tsByTid) {
    if (ts.length > mainN) {
      mainN = ts.length;
      mainTid = tid;
    }
  }
  const hangRows: string[] = [];
  if (mainTid >= 0) {
    const t = [...(tsByTid.get(mainTid) ?? [])].sort((a, b) => a - b);
    let runStart = t[0] ?? 0;
    let prev = runStart;
    for (let i = 1; i <= t.length; i++) {
      const cur = i < t.length ? t[i] : null;
      if (cur === null || cur - prev > GAP) {
        const dur = prev - runStart;
        if (dur >= HANG) {
          const htype = dur >= 500_000_000 ? "severe-hang" : "hang";
          hangRows.push(
            `<row><start-time id="${nid()}" fmt="">${runStart}</start-time>` +
              `<duration id="${nid()}" fmt="">${dur}</duration>` +
              `<hang-type id="${nid()}" fmt="">${htype}</hang-type>` +
              `<thread id="${nid()}" fmt="${xmlEscape(name)} ${mainTid} (main thread)"/></row>`
          );
        }
        if (cur !== null) runStart = cur;
      }
      if (cur !== null) prev = cur;
    }
  }
  const hangsXml =
    `<?xml version="1.0"?>\n<trace-toc><run number="1"><data>` +
    `<table schema="potential-hangs">${hangRows.join("")}</table></data></run></trace-toc>\n`;
  fs.writeFileSync(`${outPrefix}_raw_hangs.xml`, hangsXml);

  return {
    cpu: `${outPrefix}_raw_cpu.xml`,
    hangs: `${outPrefix}_raw_hangs.xml`,
    pid,
    name,
    cpuSamples: rows.length,
    hangs_count: hangRows.length,
  };
}
