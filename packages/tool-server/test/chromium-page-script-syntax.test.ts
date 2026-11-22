import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { DeviceInfo, Registry } from "@argent/registry";
import type { ChromiumCdpApi } from "../src/blueprints/chromium-cdp";
import { describeChromium } from "../src/tools/describe/platforms/chromium";
import { buildChromiumFillScript } from "../src/tools/fill/chromium";
import { queryChromiumTree } from "../src/tools/flows/flow-chromium-tree";

/**
 * The describe walker and the fill script run in the target's own renderer, which can
 * be an old Chromium or Electron, so they keep to ES2019 syntax.
 */

// The first syntax newer than ES2019 in a script, else null: the first line TypeScript
// rewrites for an ES2019 target, or a node of a kind it leaves as it is.
function newerThanEs2019(script: string): string | null {
  const emit = (target: ts.ScriptTarget) =>
    ts.transpileModule(script, { compilerOptions: { target } }).outputText.split("\n");
  const es2019 = new Set(emit(ts.ScriptTarget.ES2019));
  const lowered = emit(ts.ScriptTarget.ESNext).find((line) => !es2019.has(line));
  if (lowered !== undefined) return lowered.trim();
  const source = ts.createSourceFile("page.js", script, ts.ScriptTarget.ESNext);
  let found: string | null = null;
  const visit = (node: ts.Node): void => {
    if (found !== null) return;
    if (
      ts.isBigIntLiteral(node) ||
      ts.isMetaProperty(node) ||
      (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) ||
      (ts.isRegularExpressionLiteral(node) &&
        /[^gimsuy]/.test(node.text.slice(node.text.lastIndexOf("/") + 1)))
    ) {
      found = node.getText(source);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// The walker expressions a describe call sends to the page.
async function sentWalkers(call: (api: ChromiumCdpApi) => Promise<unknown>): Promise<string[]> {
  const sent: string[] = [];
  const tree = { role: "html", frame: { x: 0, y: 0, width: 1, height: 1 }, children: [] };
  const api = {
    refreshViewport: async () => ({ width: 1000, height: 1000 }),
    cdp: {
      send: async (_method: string, params: { expression: string }) => {
        sent.push(params.expression);
        return { result: { value: JSON.stringify({ tree }) } };
      },
    },
  } as unknown as ChromiumCdpApi;
  await call(api);
  return sent;
}

describe("Chromium page scripts", () => {
  it("flags each kind of syntax newer than ES2019", () => {
    for (const code of [
      "a?.b;",
      "a ?? b;",
      "a ??= b;",
      "a &&= b;",
      "x = 1_000;",
      "x = 1n;",
      "x = /a/d;",
      "x = /a/v;",
      "class A { #x = 1; }",
      "class A { static {} }",
      "import.meta;",
      'import("x");',
    ]) {
      expect(newerThanEs2019(code), code).not.toBeNull();
    }
    expect(newerThanEs2019("try {} catch { x = /\\p{L}/gimsuy; }")).toBeNull();
  });

  it("parse as ES2019: the describe walker at describe's and flows' limits", async () => {
    const walkers = [
      ...(await sentWalkers((api) => describeChromium(api))),
      ...(await sentWalkers((api) =>
        queryChromiumTree(
          { resolveService: async () => api } as unknown as Registry,
          {
            id: "chromium-test",
            platform: "chromium",
            kind: "app",
          } as DeviceInfo
        )
      )),
    ];
    expect(walkers).toHaveLength(2);
    expect(walkers[0]).not.toBe(walkers[1]);
    for (const walker of walkers) expect(newerThanEs2019(walker)).toBeNull();
  });

  it("parse as ES2019: the fill script", () => {
    expect(newerThanEs2019(buildChromiumFillScript("abc"))).toBeNull();
  });
});
