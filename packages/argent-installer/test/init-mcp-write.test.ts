import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { writeMcpConfigs } from "../src/init-mcp-write.js";
import { getAdapterByName } from "../src/mcp-configs.js";

// `init --global` in a repo with a committed local-mode setup must not
// clobber the team's project-scope entries: the same run keeps
// .argent/install.json and reports the project stays in local mode.

let tmpDir: string;
const claude = getAdapterByName("Claude Code")!;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-mcp-write-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("writeMcpConfigs — global mode over a committed local entry", () => {
  it("keeps the committed local-mode entry instead of rewriting it to bare argent", () => {
    const mcpJson = path.join(tmpDir, ".mcp.json");
    fs.writeFileSync(
      mcpJson,
      JSON.stringify({
        mcpServers: {
          argent: {
            type: "stdio",
            command: "node",
            args: ["node_modules/@swmansion/argent/dist/cli.js", "mcp"],
          },
        },
      })
    );
    const before = fs.readFileSync(mcpJson, "utf8");

    const { lines } = writeMcpConfigs({
      selectedAdapters: [claude],
      installMode: "global",
      scope: "local",
      effectiveRoot: tmpDir,
      projectRoot: tmpDir,
    });

    expect(fs.readFileSync(mcpJson, "utf8")).toBe(before);
    expect(lines.join("\n")).toContain("kept the committed local-mode entry");
  });

  it("still refreshes a stock global-shape entry in global mode", () => {
    const mcpJson = path.join(tmpDir, ".mcp.json");
    fs.writeFileSync(
      mcpJson,
      JSON.stringify({
        mcpServers: { argent: { type: "stdio", command: "argent", args: ["mcp"] } },
      })
    );

    const { lines } = writeMcpConfigs({
      selectedAdapters: [claude],
      installMode: "global",
      scope: "local",
      effectiveRoot: tmpDir,
      projectRoot: tmpDir,
    });

    const entry = (
      JSON.parse(fs.readFileSync(mcpJson, "utf8")) as {
        mcpServers: Record<string, { command: string }>;
      }
    ).mcpServers.argent;
    expect(entry.command).toBe("argent");
    expect(lines.join("\n")).not.toContain("kept the committed");
  });
});
