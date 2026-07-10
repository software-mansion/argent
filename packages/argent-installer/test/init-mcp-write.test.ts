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

function writeCommittedLocalEntry(): { mcpJson: string; before: string } {
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
  return { mcpJson, before: fs.readFileSync(mcpJson, "utf8") };
}

describe("writeMcpConfigs — global mode over a committed local entry", () => {
  it("keeps the committed local-mode entry when the project is STILL local (record present)", () => {
    // Coexistence: the project keeps its local devDependency (marked by the
    // committed .argent/install.json) and a teammate adds a personal global
    // install — the committed node-path entry must survive.
    fs.mkdirSync(path.join(tmpDir, ".argent"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".argent", "install.json"),
      JSON.stringify({ mode: "local", package: "@swmansion/argent" })
    );
    const { mcpJson, before } = writeCommittedLocalEntry();

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

  it("keeps the committed local-mode entry when the project STILL declares the dep", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "proj", devDependencies: { "@swmansion/argent": "^1.0.0" } })
    );
    const { mcpJson, before } = writeCommittedLocalEntry();

    writeMcpConfigs({
      selectedAdapters: [claude],
      installMode: "global",
      scope: "local",
      effectiveRoot: tmpDir,
      projectRoot: tmpDir,
    });

    expect(fs.readFileSync(mcpJson, "utf8")).toBe(before);
  });

  it("rewrites the dead local entry when the project ABANDONED local mode", () => {
    // No committed record and no manifest declaration: the devDependency was
    // removed, so the node-path entry is dead and must be rewritten to bare
    // `argent` — matching init's own marker cleanup in the same run.
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "proj" }));
    const { mcpJson } = writeCommittedLocalEntry();

    const { lines } = writeMcpConfigs({
      selectedAdapters: [claude],
      installMode: "global",
      scope: "local",
      effectiveRoot: tmpDir,
      projectRoot: tmpDir,
    });

    const entry = (
      JSON.parse(fs.readFileSync(mcpJson, "utf8")) as {
        mcpServers: Record<string, { command: string; args: string[] }>;
      }
    ).mcpServers.argent;
    expect(entry.command).toBe("argent");
    expect(entry.args).toEqual(["mcp"]);
    expect(lines.join("\n")).not.toContain("kept the committed");
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
