import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globals: true,
    // Suite-wide guard against unit tests incidentally shelling out to real
    // `xcrun simctl` / adb (see the setup file's comment).
    setupFiles: ["test/setup/stub-status-bar.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
