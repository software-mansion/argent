import { describe, it, expect } from "vitest";
import { runShellCommand } from "../src/shell.js";

describe("runShellCommand output", () => {
  it("includes stdout when a failed command writes its explanation there", async () => {
    await expect(
      runShellCommand({ bin: "cmd.exe", args: ["/d", "/c", "echo ERR_PNPM_NO_GLOBAL_BIN_DIR & exit /b 1"] })
    ).rejects.toThrow("ERR_PNPM_NO_GLOBAL_BIN_DIR");
  });
});
