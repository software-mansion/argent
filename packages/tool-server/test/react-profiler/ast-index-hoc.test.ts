import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildAstIndexWithDiagnostics } from "../../src/utils/react-profiler/pipeline/06-resolve/ast-index";

/**
 * Regression test for the `react-profiler-component-source` "found: false"
 * defect: the AST indexer's `variable_declarator` branch only matched a value
 * node that was DIRECTLY an arrow/function expression, so every component
 * declared via an HOC wrapper — `export const X = React.memo(...)` /
 * `forwardRef(...)` — produced a `call_expression` value node and was silently
 * dropped from the index. Those are exactly the components a profiling session
 * surfaces, so `component-source` returned `found: false` for them despite the
 * source existing on disk. See `classifyComponentValue` in ast-index.ts.
 */

const FIXTURES: Record<string, string> = {
  // Baseline shapes that always worked — guard against regressing them.
  "PlainArrow.tsx": `export const PlainArrow = ({ id }: { id: string }) => <Text>{id}</Text>;`,
  "PlainFn.tsx": `export function PlainFn() { return null; }`,

  // The previously-missing HOC-wrapped shapes.
  "MemoArrow.tsx": `export const MemoArrow = React.memo((props: Props) => <View {...props} />);`,
  "BareMemo.tsx": `import { memo } from "react";
export const BareMemo = memo((props: Props) => <View {...props} />);`,
  "ForwardRefGeneric.tsx": `export const ForwardRefGeneric = React.forwardRef<View, Props>(
  ({ onClick, ...props }, ref) => <View ref={ref} {...props} />
);`,
  "BareForwardRef.tsx": `import { forwardRef } from "react";
export const BareForwardRef = forwardRef((props, ref) => <View ref={ref} {...props} />);`,
  "MemoForwardRef.tsx": `export const MemoForwardRef = React.memo(
  React.forwardRef((props, ref) => <View ref={ref} {...props} />)
);`,
  "MemoNamed.tsx": `const Inner = (props: Props) => <View {...props} />;
export const MemoNamed = React.memo(Inner);`,

  // Negative: a non-component call must NOT be indexed as a component.
  "NotAComponent.tsx": `export const StyleSheetThing = StyleSheet.create({ a: {} });`,
};

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "argent-ast-index-hoc-"));
  await Promise.all(
    Object.entries(FIXTURES).map(([name, content]) =>
      fs.writeFile(join(root, name), content, "utf8"),
    ),
  );
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("buildAstIndexWithDiagnostics — HOC-wrapped components", () => {
  it("indexes plain and HOC-wrapped components alike", async () => {
    const { index, treeSitterAvailable } = await buildAstIndexWithDiagnostics(root);
    // The fix is meaningless without tree-sitter; if it isn't compiled in this
    // environment, fail loudly rather than silently passing on an empty index.
    expect(treeSitterAvailable).toBe(true);

    for (const name of [
      "PlainArrow",
      "PlainFn",
      "MemoArrow",
      "BareMemo",
      "ForwardRefGeneric",
      "BareForwardRef",
      "MemoForwardRef",
      "MemoNamed",
    ]) {
      expect(index.has(name), `${name} should be indexed`).toBe(true);
    }
  });

  it("flags memo-wrapped components as memoized", async () => {
    const { index } = await buildAstIndexWithDiagnostics(root);
    expect(index.get("MemoArrow")?.isMemoized).toBe(true);
    expect(index.get("BareMemo")?.isMemoized).toBe(true);
    expect(index.get("MemoForwardRef")?.isMemoized).toBe(true);
    // forwardRef without memo is not memoized.
    expect(index.get("ForwardRefGeneric")?.isMemoized).toBe(false);
    expect(index.get("PlainArrow")?.isMemoized).toBe(false);
  });

  it("points HOC-wrapped components at the `const` line, not the inner arrow", async () => {
    const { index } = await buildAstIndexWithDiagnostics(root);
    // ForwardRefGeneric: `export const` is on line 1 of its fixture.
    expect(index.get("ForwardRefGeneric")?.line).toBe(1);
  });

  it("does not index a non-component call expression", async () => {
    const { index } = await buildAstIndexWithDiagnostics(root);
    expect(index.has("StyleSheetThing")).toBe(false);
  });
});
