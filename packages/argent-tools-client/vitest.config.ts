import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globals: true,
    // Suite-wide guards, one for each direction the environment leaks; each
    // setup file documents why it exists.
    setupFiles: ["test/setup/clear-argent-env.ts", "test/setup/assert-home-restored.ts"],
  },
});
