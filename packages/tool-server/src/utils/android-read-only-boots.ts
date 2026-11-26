import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Read-only Android emulators argent booted, by serial. One launched without
 * `-port` shows no port in its command line, so only the pid ties it to its
 * serial; the pid also tells it from another emulator that later takes the
 * same console port.
 *
 * The emulators are detached and outlive the tool-server (an MCP restart,
 * `argent update`, a crash). Without the record a read-only boot after a
 * restart no longer finds the emulator it started, and since read-only
 * instances run side by side, it starts another one each time. So the records
 * are mirrored to a file, read back by later tool-servers. A record from the
 * file is trusted only where the process table shows its pid still running the
 * AVD read-only (see `avdInstances` in boot-device), so a stale entry is
 * dropped rather than believed.
 */
export interface ReadOnlyBootRecord {
  avdName: string;
  pid: number;
  /** Launched with `-port`: it belongs to the calls that name that port. */
  pinned: boolean;
}

export interface ReadOnlyBootEntry extends ReadOnlyBootRecord {
  serial: string;
  /** Recorded by this tool-server, rather than read back from the file. */
  ownProcess: boolean;
}

const ownRecords = new Map<string, ReadOnlyBootRecord>();

function recordsFilePath(): string {
  return (
    process.env.ARGENT_ANDROID_READ_ONLY_BOOTS_FILE ??
    path.join(os.homedir(), ".argent", "android-read-only-boots.json")
  );
}

function isRecord(value: unknown): value is ReadOnlyBootRecord {
  const v = value as Partial<ReadOnlyBootRecord> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.avdName === "string" &&
    typeof v.pid === "number" &&
    typeof v.pinned === "boolean"
  );
}

function loadPersisted(): Map<string, ReadOnlyBootRecord> {
  try {
    const raw = JSON.parse(fs.readFileSync(recordsFilePath(), "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) return new Map();
    return new Map(
      Object.entries(raw).filter((e): e is [string, ReadOnlyBootRecord] => isRecord(e[1]))
    );
  } catch {
    return new Map();
  }
}

function persist(mutate: (records: Map<string, ReadOnlyBootRecord>) => void): void {
  // Best effort: the in-memory record still serves this tool-server.
  try {
    const file = recordsFilePath();
    const records = loadPersisted();
    mutate(records);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(records)));
  } catch {
    // ignore
  }
}

export function rememberReadOnlyBoot(serial: string, record: ReadOnlyBootRecord): void {
  ownRecords.set(serial, record);
  persist((records) => records.set(serial, record));
}

/**
 * Forget the record of `serial`. With `pid`, only a record of that pid goes,
 * so a newer boot's record on the same serial, from another tool-server, stays.
 */
export function forgetReadOnlyBoot(serial: string, pid?: number): void {
  if (pid === undefined || ownRecords.get(serial)?.pid === pid) ownRecords.delete(serial);
  // A writable boot forgets its serial too; leave the file alone, or absent,
  // when it holds nothing to drop.
  if (!loadPersisted().has(serial)) return;
  persist((records) => {
    if (pid === undefined || records.get(serial)?.pid === pid) records.delete(serial);
  });
}

/** Every record: this tool-server's, then those other tool-servers left in the file. */
export function readOnlyBootEntries(): ReadOnlyBootEntry[] {
  const entries: ReadOnlyBootEntry[] = [...ownRecords].map(([serial, r]) => ({
    serial,
    ...r,
    ownProcess: true,
  }));
  for (const [serial, r] of loadPersisted()) {
    if (!ownRecords.has(serial)) entries.push({ serial, ...r, ownProcess: false });
  }
  return entries;
}

/** Drops this tool-server's records and keeps the file, as a restart does. */
export function __restartReadOnlyBootsForTesting(): void {
  ownRecords.clear();
}

/** Clears the records, and the file only when a test pointed the path elsewhere. */
export function __clearReadOnlyBootsForTesting(): void {
  ownRecords.clear();
  const file = process.env.ARGENT_ANDROID_READ_ONLY_BOOTS_FILE;
  if (file !== undefined) fs.rmSync(file, { force: true });
}
