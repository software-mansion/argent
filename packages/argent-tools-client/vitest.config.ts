import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globals: true,
    // Strips the developer's ARGENT_* overrides, which the launcher would otherwise pass
    // through to a real spawned tool-server child.
    setupFiles: ["test/setup/clear-argent-env.ts"],
  },
});
