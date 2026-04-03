import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

export interface SourceResolver {
  resolveDebugStack(debugStack: string): Promise<SourceLocation | null>;
  symbolicate(
    bundleUrl: string,
    line: number,
    col: number,
    methodName?: string
  ): Promise<SourceLocation | null>;
  readSourceFragment(location: SourceLocation, contextLines?: number): Promise<string | null>;
}

interface StackFrame {
  fn: string;
  file: string;
  line: number;
  col: number;
}

/**
 * Parse _debugStack into individual frames.
 * Frame[0] is React internal, frame[1] is the JSX call-site in parent.
 */
export function parseDebugStack(stack: string): StackFrame[] {
  const lines = stack.split("\n").filter((l) => l.trim().startsWith("at "));

  return lines.map((line) => {
    const match = line.trim().match(/at (?:([^\s(]+) \()?([^)]+):(\d+):(\d+)\)?/);
    if (!match) return { fn: "unknown", file: "", line: 0, col: 0 };
    return {
      fn: match[1] || "anonymous",
      file: match[2]!,
      line: parseInt(match[3]!, 10),
      col: parseInt(match[4]!, 10),
    };
  });
}

/**
 * Normalize bundle URL for symbolication:
 * - iOS: //& → ?
 * - Android: rewrite host to localhost with correct port
 */
export function normalizeBundleUrl(rawUrl: string, port: number): string {
  let url = rawUrl.replace(/\/\/&/, "?");

  try {
    const parsed = new URL(url);
    parsed.hostname = "localhost";
    parsed.port = port.toString();
    url = parsed.toString();
  } catch {
    // not a valid URL, return as-is
  }

  return url;
}

export function createSourceResolver(port: number, projectRoot: string): SourceResolver {
  async function symbolicateFrame(
    bundleUrl: string,
    lineNumber: number,
    column: number,
    methodName = "unknown"
  ): Promise<SourceLocation | null> {
    const file = normalizeBundleUrl(bundleUrl, port);
    try {
      const res = await fetch(`http://localhost:${port}/symbolicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stack: [{ file, lineNumber, column, methodName }],
        }),
      });
      const data = (await res.json()) as {
        stack?: Array<{
          file?: string;
          lineNumber?: number;
          column?: number;
        }>;
      };
      const frame = data.stack?.[0];
      if (!frame?.file) return null;

      if (frame.file.includes("node_modules")) return null;

      const relFile = frame.file.replace(projectRoot + "/", "").replace(/^\/+/, "");

      return {
        file: relFile,
        line: frame.lineNumber ?? 0,
        column: frame.column ?? 0,
      };
    } catch {
      return null;
    }
  }

  return {
    async resolveDebugStack(debugStack: string): Promise<SourceLocation | null> {
      const frames = parseDebugStack(debugStack);
      const target = frames[1] ?? frames[0];
      if (!target?.file) return null;
      return symbolicateFrame(target.file, target.line, target.col, target.fn);
    },

    symbolicate: symbolicateFrame,

    async readSourceFragment(location: SourceLocation, contextLines = 3): Promise<string | null> {
      try {
        const absPath = path.isAbsolute(location.file)
          ? location.file
          : path.join(projectRoot, location.file);
        const content = await fs.readFile(absPath, "utf-8");
        const lines = content.split("\n");
        const start = Math.max(0, location.line - 1 - contextLines);
        const end = Math.min(lines.length, location.line + contextLines);
        return lines
          .slice(start, end)
          .map((l, i) => {
            const lineNum = start + i + 1;
            const marker = lineNum === location.line ? ">" : " ";
            return `${marker} ${lineNum.toString().padStart(4)} | ${l}`;
          })
          .join("\n");
      } catch {
        return null;
      }
    },
  };
}
