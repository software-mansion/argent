// Leaks + Allocations via the simulator's own in-process engine
// (`simctl spawn <udid> leaks|heap <pid>`) — the same heap scanner the
// `remoteleaks`/`objectalloc` Instruments services wrap, and which works on
// macOS 26 (corpse-based). Emits the Leaks-detail XML Argent's parseLeaksXml
// consumes. Port of the Python emit_leaks.py.
import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toBytes(s: string): number {
  const m = /([\d.]+)\s*([KMG]?)/.exec(s.trim());
  if (!m) return 0;
  const mult: Record<string, number> = { K: 1024, M: 1048576, G: 1073741824 };
  return Math.round(parseFloat(m[1]) * (mult[m[2]] ?? 1));
}

export interface LeakSummary {
  leaks: number;
  bytes: number;
}

/**
 * Run the in-sim leaks engine for `pid` and write the Leaks-detail XML to `out`.
 * Returns the reported leak/byte totals.
 */
export async function emitLeaks(udid: string, pid: number, out: string): Promise<LeakSummary> {
  let txt: string;
  try {
    const { stdout, stderr } = await execFileAsync(
      "xcrun",
      ["simctl", "spawn", udid, "leaks", String(pid)],
      {
        maxBuffer: 32 * 1024 * 1024,
        timeout: 90_000,
      }
    );
    txt = stdout + stderr;
  } catch (e: unknown) {
    // `leaks` exits non-zero when it finds leaks; capture its stdout anyway
    const err = e as { stdout?: string; stderr?: string };
    txt = (err.stdout ?? "") + (err.stderr ?? "");
  }

  const rows: string[] = [];
  // e.g. "  9 (1.25K) ROOT LEAK: <NSMutableDictionary 0x..> [32]  item count: 3"
  const ROOT = /^\s*(\d+)\s+\(([^)]+)\)\s+ROOT LEAK:\s+<([A-Za-z_][\w]*)[^>]*>\s+\[(\d+)\]/;
  for (const line of txt.split("\n")) {
    const m = ROOT.exec(line);
    if (!m) continue;
    const count = parseInt(m[1], 10);
    const total = toBytes(m[2]);
    const typ = m[3];
    const objsz = parseInt(m[4], 10);
    rows.push(
      `<row leaked-object="${xmlEscape(typ)}" size="${total || objsz}" count="${count}" ` +
        `responsible-frame="${xmlEscape(typ)}" responsible-library=""/>`
    );
  }
  const xml =
    `<?xml version="1.0"?>\n<trace-toc><run number="1"><tracks>` +
    `<track name="Leaks"><details><detail name="Leaks">${rows.join("")}</detail></details></track>` +
    `</tracks></run></trace-toc>\n`;
  fs.writeFileSync(out, xml);

  const m = /(\d+)\s+leaks for\s+(\d+)\s+total leaked bytes/.exec(txt);
  return { leaks: m ? parseInt(m[1], 10) : rows.length, bytes: m ? parseInt(m[2], 10) : 0 };
}

export interface AllocationProfile {
  totalNodes: number;
  /** raw `heap` summary text (size histogram + class counts). */
  summary: string;
  objcClasses: number;
  swiftClasses: number;
}

/** Run the in-sim heap engine for `pid` → live-object allocation profile. */
export async function captureAllocations(udid: string, pid: number): Promise<AllocationProfile> {
  let txt: string;
  try {
    const { stdout } = await execFileAsync(
      "xcrun",
      ["simctl", "spawn", udid, "heap", String(pid)],
      {
        maxBuffer: 48 * 1024 * 1024,
        timeout: 90_000,
      }
    );
    txt = stdout;
  } catch (e: unknown) {
    txt = (e as { stdout?: string }).stdout ?? "";
  }
  const summary = txt.slice(txt.indexOf("All zones:"));
  const nodes = /All zones:\s+(\d+)\s+nodes/.exec(txt);
  const objc = /(\d+)\s+ObjC classes/.exec(txt);
  const swift = /(\d+)\s+Swift classes/.exec(txt);
  return {
    totalNodes: nodes ? parseInt(nodes[1], 10) : 0,
    summary,
    objcClasses: objc ? parseInt(objc[1], 10) : 0,
    swiftClasses: swift ? parseInt(swift[1], 10) : 0,
  };
}
