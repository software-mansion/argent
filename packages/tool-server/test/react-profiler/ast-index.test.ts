import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildAstIndexWithDiagnostics } from "../../src/utils/react-profiler/pipeline/06-resolve/ast-index";

/**
 * react-profiler-component-source returned found:false for every component in a
 * standard TS/TSX Expo project because @swmansion/argent never declared (or
 * shipped) tree-sitter / tree-sitter-typescript, so the parser require() threw,
 * was swallowed, and the index was always empty. The grammar/match logic itself
 * is correct — this test guards it for the idiomatic declaration forms and, via
 * treeSitterAvailable, fails loudly if the parser dependency goes missing again.
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
});
