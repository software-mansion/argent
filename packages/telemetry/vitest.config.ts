import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globals: true,
    // The suite must not inherit the developer's telemetry configuration; the
    // setup file documents which variables and why.
    setupFiles: ["test/setup/clear-telemetry-env.ts"],
  },
});
