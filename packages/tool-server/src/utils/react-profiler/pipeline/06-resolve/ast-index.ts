import { promises as fs } from "fs";
import { join } from "path";

// Tree-sitter requires native bindings loaded via require (CJS context)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const _require = require;

export interface TreeSitterNode {
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  text: string;
  type: string;
  children: TreeSitterNode[];
  childCount: number;
  namedChildren: TreeSitterNode[];
  parent: TreeSitterNode | null;
}

interface ParserInstance {
  setLanguage(lang: unknown): void;
  parse(src: string): { rootNode: TreeSitterNode };
}

type ParserCtor = new () => ParserInstance;

export interface ComponentIndexEntry {
  file: string;
  line: number; // 1-based
  col: number; // 0-based
  isMemoized: boolean;
  hasUseCallback: boolean;
  hasUseMemo: boolean;
}

export type ComponentIndex = Map<string, ComponentIndexEntry>;

export interface AstIndexResult {
  index: ComponentIndex;
  treeSitterAvailable: boolean;
  indexedFiles: number;
}

// ---------------------------------------------------------------------------
// Load tree-sitter lazily (graceful fallback if not compiled)
// ---------------------------------------------------------------------------

let _ParserClass: ParserCtor | null = null;
let _tsLanguage: unknown = null;
let _tsxLanguage: unknown = null;
let _treeSitterLoaded = false;

function loadTreeSitter(): {
  ParserClass: ParserCtor;
  ts: unknown;
  tsx: unknown;
} | null {
  if (_treeSitterLoaded) {
    if (!_ParserClass || !_tsLanguage || !_tsxLanguage) return null;
    return { ParserClass: _ParserClass, ts: _tsLanguage, tsx: _tsxLanguage };
  }
  _treeSitterLoaded = true;

  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const TSModule = _require("tree-sitter");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    _ParserClass = (TSModule.default ?? TSModule) as ParserCtor;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const TSLang = _require("tree-sitter-typescript");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    _tsLanguage = TSLang.typescript ?? TSLang.default?.typescript;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    _tsxLanguage = TSLang.tsx ?? TSLang.default?.tsx;
  } catch {
    // tree-sitter not available
    return null;
  }

  if (!_ParserClass || !_tsLanguage || !_tsxLanguage) return null;
  return { ParserClass: _ParserClass, ts: _tsLanguage, tsx: _tsxLanguage };
}

// ---------------------------------------------------------------------------

const EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  "android",
  "ios",
  "dist",
  "build",
  ".expo",
]);

async function findSourceFiles(dir: string): Promise<string[]> {
  const result: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!EXCLUDE_DIRS.has(entry.name)) {
          await walk(join(current, entry.name));
        }
      } else if (entry.isFile()) {
        const name = entry.name;
        if (
          name.endsWith(".ts") ||
          name.endsWith(".tsx") ||
          name.endsWith(".js") ||
          name.endsWith(".jsx")
        ) {
          result.push(join(current, name));
        }
      }
    }
  }

  await walk(dir);
  return result;
}

function isCapitalized(name: string): boolean {
  if (name.length === 0) return false;
  const first = name[0];
  return (
    first !== undefined &&
    first === first.toUpperCase() &&
    first !== first.toLowerCase()
  );
}

function nodeContainsCall(node: TreeSitterNode, callName: string): boolean {
  if (node.type === "call_expression") {
    const funcChild = node.children[0];
    if (funcChild) {
      if (funcChild.text === callName) return true;
      if (
        funcChild.type === "member_expression" &&
        funcChild.children[2]?.text === callName
      ) {
        return true;
      }
    }
  }
  for (const child of node.children) {
    if (nodeContainsCall(child, callName)) return true;
  }
  return false;
}

function isWrappedInMemo(source: string, componentName: string): boolean {
  const memoPattern = /\b(React\.memo|memo)\s*\(\s*(\w+)/g;
  let match;
  while ((match = memoPattern.exec(source)) !== null) {
    if (match[2] === componentName) return true;
  }
  return false;
}

/**
 * Build an in-memory index of all React components in the project.
 * Returns the index plus diagnostics (treeSitterAvailable, indexedFiles).
 * Returns empty index with treeSitterAvailable=false if tree-sitter is not available.
 */
export async function buildAstIndexWithDiagnostics(
  projectRoot: string,
): Promise<AstIndexResult> {
  const index: ComponentIndex = new Map();

  const ts = loadTreeSitter();
  if (!ts) return { index, treeSitterAvailable: false, indexedFiles: 0 };

  const { ParserClass, ts: tsLang, tsx: tsxLang } = ts;

  const files = await findSourceFiles(projectRoot);

  for (const file of files) {
    let source: string;
    try {
      source = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }

    const isTsxFile = file.endsWith(".tsx") || file.endsWith(".jsx");
    const language = isTsxFile ? tsxLang : tsLang;

    let tree: { rootNode: TreeSitterNode };
    try {
      const parser = new ParserClass();
      parser.setLanguage(language);
      tree = parser.parse(source);
    } catch {
      continue;
    }

    function findComponents(node: TreeSitterNode): void {
      if (node.type === "function_declaration") {
        const nameNode = node.children.find((c) => c.type === "identifier");
        if (nameNode && isCapitalized(nameNode.text)) {
          const componentName = nameNode.text;
          if (!index.has(componentName)) {
            index.set(componentName, {
              file,
              line: nameNode.startPosition.row + 1,
              col: nameNode.startPosition.column,
              isMemoized: isWrappedInMemo(source, componentName),
              hasUseCallback: nodeContainsCall(node, "useCallback"),
              hasUseMemo: nodeContainsCall(node, "useMemo"),
            });
          }
        }
      } else if (node.type === "variable_declarator") {
        const nameNode = node.children[0];
        const valueNode = node.children[node.children.length - 1];
        if (
          nameNode &&
          nameNode.type === "identifier" &&
          isCapitalized(nameNode.text) &&
          valueNode &&
          (valueNode.type === "arrow_function" ||
            valueNode.type === "function_expression")
        ) {
          const componentName = nameNode.text;
          if (!index.has(componentName)) {
            index.set(componentName, {
              file,
              line: nameNode.startPosition.row + 1,
              col: nameNode.startPosition.column,
              isMemoized: isWrappedInMemo(source, componentName),
              hasUseCallback: nodeContainsCall(node, "useCallback"),
              hasUseMemo: nodeContainsCall(node, "useMemo"),
            });
          }
        }
      }

      for (const child of node.children) {
        findComponents(child);
      }
    }

    try {
      findComponents(tree.rootNode);
    } catch {
      // ignore parse errors for individual files
    }
  }

  return { index, treeSitterAvailable: true, indexedFiles: files.length };
}
