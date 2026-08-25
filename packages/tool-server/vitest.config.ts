import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globals: true,
    // Suite-wide guards; each setup file documents why it exists. The device
    // provider guard sets an ARGENT_* variable of its own, so it has to follow
    // the sweep that clears them.
    setupFiles: [
      "test/setup/clear-argent-env.ts",
      "test/setup/stub-status-bar.ts",
      "test/setup/ignore-device-providers.ts",
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
