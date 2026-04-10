import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globals: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@argent/registry": path.resolve(__dirname, "../registry/src/index.ts"),
      "@argent/native-devtools-ios": path.resolve(__dirname, "../native-devtools-ios/src/index.ts"),
    },
  },
});
