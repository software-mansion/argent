import { describe, it, expect } from "vitest";
import { resolveSpawnCwd } from "../src/utils/vega-cli";

describe("resolveSpawnCwd", () => {
  it("uses the server cwd when it still exists", () => {
    const cwd = resolveSpawnCwd(
      () => "/live/dir",
      (p) => p === "/live/dir",
      "/tmp"
    );
    expect(cwd).toBe("/live/dir");
  });

  it("falls back when the server cwd was deleted under it (getcwd throws)", () => {
    // Simulates the stale-worktree case: process.cwd() itself throws ENOENT, so
    // the spawned `vega` CLI must not inherit the dead dir or it crashes in
    // config.py find_workspace -> os.getcwd().
    const cwd = resolveSpawnCwd(
      () => {
        throw new Error("ENOENT: getcwd");
      },
      () => false,
      "/tmp"
    );
    expect(cwd).toBe("/tmp");
  });

  it("falls back when the cwd resolves but no longer exists", () => {
    const cwd = resolveSpawnCwd(
      () => "/gone/dir",
      () => false,
      "/tmp"
    );
    expect(cwd).toBe("/tmp");
  });
});
