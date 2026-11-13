import { describe, it, expect } from "vitest";
import { runShellCommand } from "../src/shell.js";

describe("runShellCommand output", () => {
  it("includes stdout when a failed command writes its explanation there", async () => {
    const command =
      process.platform === "win32"
        ? { bin: "cmd.exe", args: ["/d", "/c", "echo ERR_PNPM_NO_GLOBAL_BIN_DIR & exit /b 1"] }
        : { bin: "sh", args: ["-c", "echo ERR_PNPM_NO_GLOBAL_BIN_DIR; exit 1"] };

    await expect(runShellCommand(command)).rejects.toThrow("ERR_PNPM_NO_GLOBAL_BIN_DIR");
  });
});
