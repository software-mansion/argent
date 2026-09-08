import { afterEach, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { redirectHomeTo } from "./helpers/home-redirect.js";

// The suites that call this delete their temp home in the same hook that
// restores, so a weakened restorer leaves them pointing at a path that is gone —
// which nothing observes under the shipped `isolate: true`. Pinned here instead.
const AMBIENT = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

afterEach(() => {
  for (const [name, value] of Object.entries(AMBIENT)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("redirectHomeTo", () => {
  it("keeps assert-env-restored.ts registered as a setup file", async () => {
    // That file is what fails a suite leaving the redirect in place. Without the
    // registration the helper's contract is all that is pinned, and stripping
    // restoreHome() from every call site leaves the package green.
    const config = await import("../vitest.config.js");

    expect(config.default.test?.setupFiles).toContain("test/setup/assert-env-restored.ts");
  });

  it("points both home variables at the directory and puts them back", () => {
    process.env.HOME = "/ambient/home";
    process.env.USERPROFILE = "/ambient/profile";

    const restore = redirectHomeTo("/tmp/sandbox");
    expect(process.env.HOME).toBe("/tmp/sandbox");
    expect(process.env.USERPROFILE).toBe("/tmp/sandbox");
    // The point of pinning both: whichever name homedir() consults on this
    // platform, it has to land in the sandbox, or the callers that build
    // ~/.argent paths from it still write into the real home.
    expect(homedir()).toBe("/tmp/sandbox");

    restore();
    expect(process.env.HOME).toBe("/ambient/home");
    expect(process.env.USERPROFILE).toBe("/ambient/profile");
  });

  it("removes a variable that was unset rather than storing the string 'undefined'", () => {
    delete process.env.HOME;
    delete process.env.USERPROFILE;

    redirectHomeTo("/tmp/sandbox")();

    // `in`, not a truthiness check: `process.env.HOME = undefined` leaves the key
    // present holding "undefined", which homedir() resolves as a relative path.
    expect("HOME" in process.env).toBe(false);
    expect("USERPROFILE" in process.env).toBe(false);
  });
});
