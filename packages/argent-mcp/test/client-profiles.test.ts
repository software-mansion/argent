import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { canonicalizeAiClient } from "@argent/telemetry";
import {
  clientProfile,
  DEFAULT_PROFILE,
  KNOWN_CLIENTS,
  type ClientProfile,
} from "../src/clients/profiles.js";

type Expected = [
  name: string | undefined,
  id: string,
  screenshot: ClientProfile["screenshot"],
  autoScreenshot: ClientProfile["autoScreenshot"],
  keywordFacts: boolean,
];

// Written out here rather than read from the table, so that a change to a row has to
// change this list too.
const EXPECTED: Expected[] = [
  ["claude-code", "claude-code", "image-and-path", "image", false],
  ["  Claude-Code  ", "claude-code", "image-and-path", "image", false],
  ["codex-mcp-client", "codex", "image-and-path", "image", true],
  ["Cursor", "cursor", "image-and-path", "image", true],
  ["cursor", "cursor", "image-and-path", "image", true],
  ["cursor-vscode", "cursor", "image-and-path", "image", true],
  ["opencode", "opencode", "image-and-path", "image", true],
  ["gemini-cli-mcp-client", "gemini-cli", "image-and-path", "image", false],
  ["Zed", "zed", "image-and-path", "image", false],
  ["Visual Studio Code", "vscode", "image-and-path", "image", true],
  ["Visual Studio Code - Insiders", "vscode", "image-and-path", "image", true],
  ["copilot-cli", "vscode-agent-host", "image-and-path", "image", false],
  ["kiro", "kiro", "image-and-path", "image", false],
  ["Q DEV CLI", "kiro-cli-v1-v2", "path", "path", false],
  ["q dev cli", "kiro-cli-v1-v2", "path", "path", false],
];

// Unnamed, SDK-default and look-alike names keep the image, the path and the facts.
const UNKNOWN = [
  undefined,
  "",
  "mcp",
  "rmcp",
  "some-new-client",
  // One per seen name: the name after a prefix, which the row's `^` rejects.
  ...KNOWN_CLIENTS.flatMap((client) => client.seen).map((name) => `my-${name}`),
  // One per row: the row's name and one more word character, which its `\b` rejects.
  "claude-codex",
  "codex-mcp-clientx",
  "cursorx",
  "opencodex",
  "gemini-cli-mcp-clientx",
  "zedx",
  "visual studio codex",
  "copilot-clix",
  "kirox",
  "q dev clix",
];

describe("clientProfile", () => {
  it.each(EXPECTED)(
    "%j → %s (screenshot %s, auto-screenshot %s, keyword facts %s)",
    (name, id, screenshot, autoScreenshot, keywordFacts) => {
      expect(clientProfile(name)).toMatchObject({ id, screenshot, autoScreenshot, keywordFacts });
    }
  );

  it.each(UNKNOWN)("gives %j the default profile", (name) => {
    expect(clientProfile(name)).toEqual(DEFAULT_PROFILE);
  });

  it("keeps the image, the path and the keyword facts by default", () => {
    expect(DEFAULT_PROFILE).toEqual({
      id: "default",
      screenshot: "image-and-path",
      autoScreenshot: "image-and-path",
      keywordFacts: true,
    });
  });
});

describe("KNOWN_CLIENTS", () => {
  it("has unique ids, none of them `default`", () => {
    const ids = KNOWN_CLIENTS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(DEFAULT_PROFILE.id);
  });

  it("matches every seen name to its own row and to no other", () => {
    for (const client of KNOWN_CLIENTS) {
      expect(client.seen.length).toBeGreaterThan(0);
      for (const name of client.seen) {
        const lower = name.trim().toLowerCase();
        const matching = KNOWN_CLIENTS.filter((c) => c.names.some((p) => p.test(lower)));
        expect(
          matching.map((c) => c.id),
          name
        ).toEqual([client.id]);
      }
    }
  });

  it("covers every seen name in the expectations above", () => {
    const expected = new Set(EXPECTED.map(([name]) => name));
    for (const name of KNOWN_CLIENTS.flatMap((c) => c.seen)) {
      expect(expected.has(name), name).toBe(true);
    }
  });

  it("states the slug @argent/telemetry gives each seen name", () => {
    for (const client of KNOWN_CLIENTS) {
      for (const name of client.seen) {
        expect(canonicalizeAiClient(name) ?? "other", name).toBe(client.telemetry);
      }
    }
  });
});

describe("clients/README.md", () => {
  const readme = readFileSync(new URL("../src/clients/README.md", import.meta.url), "utf8");

  /** The cells of the first table after `## Matrix`, without the separator row. */
  function matrixCells(): string[][] {
    const lines = readme.split("\n");
    const start = lines.indexOf("## Matrix");
    expect(start, "README.md has no `## Matrix` heading").toBeGreaterThan(-1);
    const rows: string[][] = [];
    for (const line of lines.slice(start + 1)) {
      if (!line.startsWith("|")) {
        if (rows.length > 0) break;
        continue;
      }
      const cells = line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim());
      if (!cells.every((cell) => /^:?-+:?$/.test(cell))) rows.push(cells);
    }
    return rows;
  }

  const code = (value: string): string => `\`${value}\``;
  const yesNo = (value: boolean): string => (value ? "yes" : "no");

  it("lists every profile as profiles.ts defines it", () => {
    expect(matrixCells()).toEqual([
      [
        "`clientInfo.name`",
        "Profile",
        "`screenshot` tool",
        "Auto-screenshot",
        "Keyword facts copied",
        "Telemetry slug",
      ],
      ...KNOWN_CLIENTS.map((c) => [
        c.seen.map(code).join(", "),
        code(c.id),
        code(c.screenshot),
        code(c.autoScreenshot),
        yesNo(c.keywordFacts),
        code(c.telemetry),
      ]),
      [
        "unnamed or unknown",
        code(DEFAULT_PROFILE.id),
        code(DEFAULT_PROFILE.screenshot),
        code(DEFAULT_PROFILE.autoScreenshot),
        yesNo(DEFAULT_PROFILE.keywordFacts),
        `${code("other")}; none if unnamed`,
      ],
    ]);
  });
});
