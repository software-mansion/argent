import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globals: true,
    // Suite-wide guard against unit tests incidentally shelling out to real
    // `xcrun simctl` / adb (see the setup file's comment).
    setupFiles: ["test/setup/stub-status-bar.ts"],
    // The flow directive tests wait out real-timer budgets (1s assert grace,
    // 7.5s action auto-wait), putting their honest durations near vitest's 5s
    // default — under parallel-run machine load they crossed it and flaked.
    // Passing tests still finish in ms–seconds; this only delays how long a
    // genuinely hung test takes to be reported.
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
