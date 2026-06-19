import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildAstIndexWithDiagnostics } from "../../src/utils/react-profiler/pipeline/06-resolve/ast-index";

/**
 * react-profiler-component-source returned found:false for every component in a
 * standard TS/TSX Expo project because @swmansion/argent never declared (or
 * shipped) tree-sitter / tree-sitter-typescript, so the parser require() threw,
 * was swallowed, and the index was always empty. These tests guard the matcher
 * for the idiomatic declaration forms (plain/default/arrow AND memo/forwardRef
 * wrappers) and, via treeSitterAvailable, fail loudly if the parser dependency
 * goes missing again.
 */
describe("buildAstIndexWithDiagnostics", () => {
  it("indexes export-default-function, plain-function, and arrow TSX components", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ast-index-"));
    mkdirSync(join(dir, "components"), { recursive: true });
    writeFileSync(
      join(dir, "components", "foo.tsx"),
      [
        `import React from "react";`,
        `type P = { x: number };`,
        `export default function Foo({ x }: P) { return <View>{x}</View>; }`,
        `function Bar({ y }: { y: number }) { return <View>{y}</View>; }`,
        `const Baz = ({ z }: { z: number }) => <View>{z}</View>;`,
        ``,
      ].join("\n")
    );

    const res = await buildAstIndexWithDiagnostics(dir);

    expect(res.treeSitterAvailable).toBe(true);
    expect(res.index.get("Foo")?.line).toBe(3);
    expect(res.index.get("Bar")?.line).toBe(4);
    expect(res.index.get("Baz")?.line).toBe(5);
  });

  it("indexes memo()/forwardRef()/React.memo()/nested-wrapped components", async () => {
    // Regression: wrapped components are declared `const X = memo(...)`, whose
    // value node is a call_expression (not arrow/function), so they were missed
    // entirely and returned found:false — and profiler findings are
    // disproportionately memo-wrapped. memo => isMemoized true; forwardRef alone
    // => false.
    const dir = mkdtempSync(join(tmpdir(), "ast-index-wrap-"));
    mkdirSync(join(dir, "components"), { recursive: true });
    writeFileSync(
      join(dir, "components", "wrapped.tsx"),
      [
        `import React, { memo, forwardRef } from "react";`,
        `export const MemoFn = memo(function MemoFn() { return <View />; });`,
        `export const MemoArrow = memo(({ a }: { a: number }) => <View>{a}</View>);`,
        `export const Fwd = forwardRef(function FwdImpl(p, ref) { return <View />; });`,
        `export const Dotted = React.memo(function Dotted() { return <View />; });`,
        `export const Nested = memo(forwardRef(function NestedImpl(p, ref) { return <View />; }));`,
        ``,
      ].join("\n")
    );

    const res = await buildAstIndexWithDiagnostics(dir);

    expect(res.treeSitterAvailable).toBe(true);
    expect(res.index.get("MemoFn")).toMatchObject({ line: 2, isMemoized: true });
    expect(res.index.get("MemoArrow")).toMatchObject({ line: 3, isMemoized: true });
    expect(res.index.get("Fwd")).toMatchObject({ line: 4, isMemoized: false });
    expect(res.index.get("Dotted")).toMatchObject({ line: 5, isMemoized: true });
    expect(res.index.get("Nested")).toMatchObject({ line: 6, isMemoized: true });
  });

  it("detects cross-referenced memo() via AST and ignores memo() in comments/strings", async () => {
    // `function Card(){}; export default memo(Card)` is the cross-reference form
    // (not an inline `const X = memo(...)`). The decoy `memo(Ghost)` lives only
    // in a comment and a string literal — tree-sitter never emits a call node
    // there, so Ghost stays unmemoized. The old raw-source regex flagged it.
    const dir = mkdtempSync(join(tmpdir(), "ast-index-memo-ref-"));
    mkdirSync(join(dir, "components"), { recursive: true });
    writeFileSync(
      join(dir, "components", "ref.tsx"),
      [
        `import React, { memo } from "react";`,
        `function Card() { return <View />; }`,
        `export default memo(Card);`,
        `function Ghost() { return <View />; }`,
        `// not memoized: memo(Ghost) appears only in this comment`,
        `const note = "memo(Ghost)";`,
        ``,
      ].join("\n")
    );

    const res = await buildAstIndexWithDiagnostics(dir);

    expect(res.index.get("Card")).toMatchObject({ isMemoized: true });
    expect(res.index.get("Ghost")).toMatchObject({ isMemoized: false });
  });
});
