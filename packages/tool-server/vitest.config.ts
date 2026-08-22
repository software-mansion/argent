import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globals: true,
    // Suite-wide guards; each setup file documents why it exists.
    setupFiles: ["test/setup/clear-argent-env.ts", "test/setup/stub-status-bar.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
