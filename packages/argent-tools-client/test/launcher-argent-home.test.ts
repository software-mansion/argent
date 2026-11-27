import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redirectHomeTo } from "./helpers/home-redirect.js";

let TEST_HOME: string;
let RELOCATED: string;
let restoreHome: () => void;

async function importFresh() {
  vi.resetModules();
  return {
    launcher: await import("../src/launcher.js"),
    link: await import("../src/link-config.js"),
  };
}

beforeAll(() => {
  TEST_HOME = mkdtempSync(join(tmpdir(), "argent-home-test-"));
  RELOCATED = join(TEST_HOME, "relocated");
  restoreHome = redirectHomeTo(TEST_HOME);
});

afterAll(() => {
  vi.unstubAllEnvs();
  restoreHome();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const BUNDLE = "/some/path/tool-server.cjs";
const state = {
  port: 49502,
  pid: 12345,
  startedAt: "2026-05-11T17:00:00.000Z",
  bundlePath: BUNDLE,
  host: "127.0.0.1",
};

describe("ARGENT_HOME_DIR", () => {
  it("keeps the server records, lock, log and link apart from ~/.argent", async () => {
    vi.stubEnv("ARGENT_HOME_DIR", "");
    const defaultHome = await importFresh();
    await defaultHome.launcher.writeToolsServerState(state);
    await defaultHome.link.writeLinkConfig({
      url: "http://10.0.0.5:3001",
      host: "10.0.0.5",
      port: 3001,
      createdAt: state.startedAt,
    });

    vi.stubEnv("ARGENT_HOME_DIR", RELOCATED);
    const relocated = await importFresh();

    expect(relocated.launcher.STATE_PATHS).toEqual({
      STATE_DIR: RELOCATED,
      STATE_FILE: join(RELOCATED, "tool-server.json"),
      LOG_FILE: join(RELOCATED, "tool-server.log"),
      LOCK_FILE: join(RELOCATED, "tool-server.lock"),
    });
    expect(await relocated.launcher.readToolsServerState(BUNDLE)).toBeNull();
    expect(await relocated.launcher.readAllToolsServerStates()).toEqual([]);
    expect(await relocated.link.readLinkConfig()).toBeNull();
    expect(await defaultHome.launcher.readToolsServerState(BUNDLE)).toEqual(state);
  });
});
