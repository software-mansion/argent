import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globals: true,
    // Suite-wide guards, each documented in its own file: strip the developer's
    // ARGENT_* overrides so assertions test the shipped defaults, and stop unit
    // tests incidentally shelling out to real `xcrun simctl` / adb.
    setupFiles: ["test/setup/clear-argent-env.ts", "test/setup/stub-status-bar.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
