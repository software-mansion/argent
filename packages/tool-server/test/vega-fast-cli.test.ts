import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { vegaFastCliPath } from "../src/utils/vega-fast-cli";

const ENV_KEYS = ["ARGENT_VEGA_FAST_CLI_BIN", "ARGENT_VEGA_FAST_CLI_DIR"] as const;

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vfc-"));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("vegaFastCliPath", () => {
  it("honors ARGENT_VEGA_FAST_CLI_BIN when the file exists", () => {
    const bin = path.join(tmp, "vega-fast-cli");
    fs.writeFileSync(bin, "x");
    process.env.ARGENT_VEGA_FAST_CLI_BIN = bin;
    expect(vegaFastCliPath()).toBe(bin);
  });

  it("throws when ARGENT_VEGA_FAST_CLI_BIN points at a missing file", () => {
    process.env.ARGENT_VEGA_FAST_CLI_BIN = path.join(tmp, "nope");
    expect(() => vegaFastCliPath()).toThrow(/not found/);
  });

  it("resolves <dir>/<platform>/vega-fast-cli under ARGENT_VEGA_FAST_CLI_DIR", () => {
    const platDir = path.join(tmp, process.platform);
    fs.mkdirSync(platDir, { recursive: true });
    const bin = path.join(platDir, "vega-fast-cli");
    fs.writeFileSync(bin, "x");
    process.env.ARGENT_VEGA_FAST_CLI_DIR = tmp;
    expect(vegaFastCliPath()).toBe(bin);
  });

  it("throws with the searched paths when no binary exists", () => {
    process.env.ARGENT_VEGA_FAST_CLI_DIR = tmp; // empty → no <platform>/vega-fast-cli
    expect(() => vegaFastCliPath()).toThrow(new RegExp(`platform "${process.platform}"`));
  });
});
