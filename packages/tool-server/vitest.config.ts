import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globals: true,
    // Suite-wide guards, each explained in its own file: keep unit tests from
    // shelling out to real `xcrun simctl` / adb, and from reading the
    // developer's `ARGENT_*` overrides instead of the defaults they assert.
    setupFiles: ["test/setup/stub-status-bar.ts", "test/setup/clear-ambient-argent-env.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
