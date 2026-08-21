import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globals: true,
    // Documented in the file itself: strip the developer's ARGENT_* overrides,
    // which this package's launcher otherwise passes to a real spawned child.
    setupFiles: ["test/setup/clear-argent-env.ts"],
  },
});
