import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { scopeTempHome } from "./helpers/temp-home";

// os.homedir() reads USERPROFILE on Windows and HOME elsewhere, so a helper that
// pins only one of them is inert on the other platform and the suites relying on
// it write into the developer's real home there. Nothing else asserts this: with
// the USERPROFILE line deleted the twelve files that call scopeTempHome stay
// green, which is what these tests exist to stop.
describe("scopeTempHome", () => {
  const seen: string[] = [];
  scopeTempHome("argent-scope-probe-");

  it("pins both names os.homedir() consults, at the same directory", () => {
    expect(process.env.HOME).toBeDefined();
    expect(process.env.USERPROFILE).toBe(process.env.HOME);
    expect(homedir()).toBe(process.env.HOME);
    seen.push(process.env.HOME!);
  });

  it("hands each test its own directory rather than one shared path", () => {
    expect(process.env.USERPROFILE).toBe(process.env.HOME);
    seen.push(process.env.HOME!);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen[0]).toContain("argent-scope-probe-");
  });
});
