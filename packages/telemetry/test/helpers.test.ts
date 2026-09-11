import * as fs from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { scopeHome } from "./helpers.js";

describe("scopeHome", () => {
  const ambientHome = process.env.HOME;
  let homeAfterUnwind: string | undefined;
  let outerTmp: string | undefined;

  describe("outer", () => {
    const outer = scopeHome();

    describe("inner", () => {
      const inner = scopeHome();

      it("gives the inner scope its own temp home", () => {
        expect(inner.tmp()).not.toBe(outer.tmp());
        expect(process.env.HOME).toBe(inner.tmp());
      });
    });

    afterAll(() => {
      outerTmp = outer.tmp();
      homeAfterUnwind = process.env.HOME;
    });
  });

  it("restores the ambient HOME once nested scopes unwind", () => {
    expect(homeAfterUnwind).toBe(ambientHome);
    expect(fs.existsSync(outerTmp as string)).toBe(false);
  });
});
