import { defineConfig } from "vitest/config";
import path from "path";
import { availableParallelism } from "node:os";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globals: true,
    // test/flows drives the flow engine through its real settle and action
    // timeouts, so those 54 files hold a worker while sleeping rather than
    // while computing — they run at ~7% CPU. One worker per core leaves the
    // rest of the machine idle for that stretch, so floor the pool above the
    // core count and let the sleeping files overlap; a waiting worker costs
    // memory and nothing else. Hosts with more cores than the floor keep using
    // all of them. Every server these tests start binds port 0, so the added
    // overlap cannot collide on a fixed port.
    maxWorkers: Math.max(8, availableParallelism()),
    // Suite-wide guards; each setup file documents why it exists. The device
    // provider guard sets an ARGENT_* variable of its own, so it has to follow
    // the sweep that clears them.
    setupFiles: [
      "test/setup/clear-argent-env.ts",
      "test/setup/stub-status-bar.ts",
      "test/setup/ignore-device-providers.ts",
      "test/setup/assert-env-restored.ts",
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
