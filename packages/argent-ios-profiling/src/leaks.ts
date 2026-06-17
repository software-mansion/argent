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

export interface LeakSummary {
  leaks: number;
  bytes: number;
}

/** One leaked-object group: per-object size (downstream multiplies size×count). */
export interface LeakRow {
  type: string;
  /** PER-OBJECT size in bytes (the `[N]` bracket), not the retained-subgraph total. */
  size: number;
  count: number;
}

/**
 * Parse the ROOT-LEAK lines of `leaks(1)` output into per-object leak rows.
 * Pure (no I/O) so it can be unit-tested. Line shapes:
 *   typed:   "  9 (1.25K) ROOT LEAK: <NSMutableDictionary 0x..> [32]  item count: 3"
 *   untyped: "  1 (1.00K) ROOT LEAK: 0x106657000 [1024]  length: 34  \"reanimated::Foo\""
 *   bare:    "  1 (16 bytes) ROOT LEAK: 0x1202b7d20 [16]"
 * The bracket `[N]` is the PER-OBJECT size; the parenthesised `(…)` is the group
 * total (root + retained subgraph) and must NOT be used as the per-object size.
 */
export function parseLeakLines(txt: string): LeakRow[] {
  const out: LeakRow[] = [];
  const ROOT = /^\s*(\d+)\s+\([^)]+\)\s+ROOT LEAK:\s+(.+)$/;
  for (const line of txt.split("\n")) {
    const m = ROOT.exec(line);
    if (!m) continue;
    const count = parseInt(m[1], 10);
    const body = m[2];
    const szm = /\[(\d+)\]/.exec(body);
    const size = szm ? parseInt(szm[1], 10) : 0;
    // type: the `<Type …>` token (allowing module-qualified `.`/`::`), else the
    // trailing "string" hint for untyped blocks, else a Malloc-size label.
    let type: string;
    const tm = /^<([^\s>]+)/.exec(body);
    if (tm) {
      type = tm[1];
    } else {
      const hint = /"([^"]+)"/.exec(body);
      type = hint ? hint[1].slice(0, 120) : `Malloc ${size} bytes`;
    }
    out.push({ type, size, count });
  }
  return out;
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

  const rows = parseLeakLines(txt).map(
    (r) =>
      `<row leaked-object="${xmlEscape(r.type)}" size="${r.size}" count="${r.count}" ` +
      `responsible-frame="${xmlEscape(r.type)}" responsible-library=""/>`
  );
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
  const zonesIdx = txt.indexOf("All zones:");
  const summary = zonesIdx >= 0 ? txt.slice(zonesIdx) : "";
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
