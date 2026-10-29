import { afterEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import { home } from "../src/doctor-shared.js";

describe("home", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("shortens only paths inside the home directory", () => {
    const h = path.join(path.sep, "Users", "al");
    vi.stubEnv("HOME", h);
    vi.stubEnv("USERPROFILE", h);
    expect(home(path.join(h, "app"))).toBe(`~${path.sep}app`);
    expect(home(h)).toBe("~");
    const alice = path.join(path.sep, "Users", "alice", "app");
    expect(home(alice)).toBe(alice);
  });

  it("leaves paths alone when the home directory is the root", () => {
    vi.stubEnv("HOME", path.sep);
    vi.stubEnv("USERPROFILE", path.sep);
    const usr = path.join(path.sep, "usr", "bin");
    expect(home(usr)).toBe(usr);
  });
});
