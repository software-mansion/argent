import * as fs from "node:fs";
import type { LogFileWriter } from "../../src/utils/debugger/log-file-writer";

interface LogFileLine {
  id: number;
  timestamp: string;
  /** As written, e.g. "WARNING" - agents grep the file for it. */
  level: string;
  source: string;
  message: string;
}

// [L:<id>] <timestamp> <LEVEL> <source> | <message>
const LINE_RE = /^\[L:(\d+)\] (\S+) (\S+)\s+(\S+) \| (.*)$/;

/** Parses a writer's log file, throwing on a line that does not match the format. */
export function readLogFile(writer: LogFileWriter): LogFileLine[] {
  return fs
    .readFileSync(writer.getFilePath(), "utf-8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = LINE_RE.exec(line);
      if (!match) throw new Error(`malformed log line: ${JSON.stringify(line)}`);
      const [, id, timestamp, level, source, message] = match;
      return { id: Number(id), timestamp, level, source, message };
    });
}
