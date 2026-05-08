import * as fs from "node:fs/promises";
import * as path from "node:path";

// Source extensions we are willing to read into a debug response. Anything
// else (e.g., ~/.zshrc, /etc/passwd, an .env file inside the project) is
// rejected even if the path passes the project-root containment check.
const ALLOWED_SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json"]);

function isInsideProject(absFile: string, projectRoot: string): boolean {
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedFile = path.resolve(absFile);
  const rel = path.relative(resolvedRoot, resolvedFile);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function hasAllowedExtension(filePath: string): boolean {
  return ALLOWED_SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

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
        // location.file ultimately comes from a React fiber's
        // _debugSource.fileName, which is attacker-controllable code running
        // inside the JS runtime. Without these checks, a malicious app (or a
        // cross-origin caller via debugger-evaluate) could read any file the
        // tool-server's user can read — ~/.gitconfig, ~/.aws/credentials,
        // /etc/passwd, and so on. Two gates:
        //   1. Path stays inside projectRoot after resolve (no `..` escape,
        //      no absolute paths to /etc/anything).
        //   2. Extension is in a small allowlist of source-file extensions,
        //      so even an .env file inside the project is not readable here.
        const absPath = path.isAbsolute(location.file)
          ? path.resolve(location.file)
          : path.resolve(projectRoot, location.file);
        if (!isInsideProject(absPath, projectRoot)) return null;
        if (!hasAllowedExtension(absPath)) return null;
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
